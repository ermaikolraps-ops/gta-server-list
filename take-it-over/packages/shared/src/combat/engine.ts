import { BONUS_TARGETS, type GameParams, UNIT_TYPES, type UnitType } from '../params';
import { effectivePower, efficiency } from './diminishing';
import { Rng } from './rng';

/**
 * Deterministic, isolated combat engine (docs/combat.md).
 *
 * Units are never simulated one by one. Each army holds, per unit type, a
 * headcount and the total HP missing across its living units. Firepower scales
 * with headcount; staying power with the remaining HP pool. All state is plain
 * JSON so a war can be saved after every round and resumed after a restart.
 */

export type Side = 'attacker' | 'defender';
export const SIDES: readonly Side[] = ['attacker', 'defender'];

export interface Stack {
  count: number;
  /** HP missing across all living units of this stack (0 ≤ damage < count × hp). */
  damage: number;
}

export type Composition = Record<UnitType, Stack>;

export interface BattleArmy {
  id: string;
  ownerId: string;
  side: Side;
  units: Composition;
  /** First round (1-based) this army fires in and can be targeted in. */
  activeFromRound: number;
  /** Total damage this army's fire has inflicted (for shared-conquest contribution). */
  damageDealt: number;
}

export interface BattleState {
  rng: number;
  /** Rounds resolved so far. */
  round: number;
  totalRounds: number;
  armies: BattleArmy[];
  /**
   * Fractional casualties owed per side and unit type, carried to the next
   * round instead of being rounded away. Kept per side (not per army) so that
   * splitting a force into many armies changes nothing.
   */
  carry: Record<Side, Record<UnitType, number>>;
}

export interface RoundReport {
  round: number;
  damageDealt: Record<Side, number>;
  losses: Record<Side, Record<UnitType, number>>;
  /** Raw victory power of all arrived armies after the round. */
  power: Record<Side, number>;
  /** Power after diminishing returns (what fired this round, per side). */
  firingEfficiency: Record<Side, number>;
}

export function emptyComposition(): Composition {
  return {
    infantry: { count: 0, damage: 0 },
    armor: { count: 0, damage: 0 },
    artillery: { count: 0, damage: 0 },
    antiArmor: { count: 0, damage: 0 },
  };
}

export function composition(counts: Partial<Record<UnitType, number>>): Composition {
  const c = emptyComposition();
  for (const t of UNIT_TYPES) c[t].count = Math.max(0, Math.floor(counts[t] ?? 0));
  return c;
}

export function createBattle(seed: number, totalRounds: number): BattleState {
  return { rng: seed >>> 0, round: 0, totalRounds, armies: [], carry: { attacker: zeroByType(), defender: zeroByType() } };
}

/**
 * The first round an army joins: an army counts from its arrival but only
 * fires in the next *complete* round. Round k spans [(k-1)·len, k·len).
 */
export function firstFullRound(arrivalMs: number, startMs: number, roundMs: number): number {
  return Math.max(1, Math.ceil((arrivalMs - startMs) / roundMs) + 1);
}

export function addArmy(state: BattleState, army: Omit<BattleArmy, 'damageDealt'> & { damageDealt?: number }): void {
  if (state.armies.some((a) => a.id === army.id)) throw new Error(`army ${army.id} already in battle`);
  state.armies.push({ damageDealt: 0, ...army, units: cloneComposition(army.units) });
  state.armies.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function cloneComposition(c: Composition): Composition {
  const out = emptyComposition();
  for (const t of UNIT_TYPES) out[t] = { count: c[t].count, damage: c[t].damage };
  return out;
}

export function headcount(c: Composition): number {
  let n = 0;
  for (const t of UNIT_TYPES) n += c[t].count;
  return n;
}

function hpPool(stack: Stack, hp: number): number {
  return stack.count * hp - stack.damage;
}

/**
 * Victory power of one stack: each unit is worth the mean of its attack and
 * defence, scaled by the HP it has left. Combines attack, defence and remaining
 * resistance as the rules require.
 */
export function stackPower(type: UnitType, stack: Stack, params: GameParams): number {
  const s = params.units[type];
  if (stack.count <= 0) return 0;
  return ((s.attack + s.defense) / 2) * (hpPool(stack, s.hp) / s.hp);
}

export function compositionPower(c: Composition, params: GameParams): number {
  let p = 0;
  for (const t of UNIT_TYPES) p += stackPower(t, c[t], params);
  return p;
}

/** Victory power of a side: every army that has arrived, whether or not it has fired yet. */
export function sidePower(state: BattleState, side: Side, params: GameParams): number {
  let p = 0;
  for (const a of state.armies) if (a.side === side) p += compositionPower(a.units, params);
  return p;
}

function participants(state: BattleState, side: Side, round: number): BattleArmy[] {
  return state.armies.filter((a) => a.side === side && a.activeFromRound <= round && headcount(a.units) > 0);
}

/**
 * Damage model for one stack. A share of incoming damage (lethality) lands as
 * killing blows on average-health units; the rest spreads as wounds. Expected
 * kills are fractional; the caller turns them into whole casualties.
 */
export function expectedKills(stack: Stack, dmg: number, hp: number, params: GameParams): number {
  if (stack.count <= 0 || dmg <= 0) return 0;
  const avg = hpPool(stack, hp) / stack.count;
  return (params.combat.lethality * dmg) / avg;
}

/** Most units `dmg` can kill: never more HP than the stack has lost, and never the last survivor. */
export function killCap(stack: Stack, dmg: number, hp: number): number {
  return Math.max(0, Math.min(stack.count - 1, Math.floor((stack.damage + dmg + 1e-9) / hp)));
}

/**
 * Lands `dmg` and `kills` on a stack. Damage at or above the remaining HP pool
 * wipes it; survivors never average below minSurvivorHpFraction (the excess
 * becomes casualties). Returns units killed.
 */
export function landDamage(stack: Stack, dmg: number, kills: number, hp: number, params: GameParams): number {
  if (stack.count <= 0 || dmg <= 0) return 0;
  const total = hpPool(stack, hp);
  const before = stack.count;
  if (dmg >= total - 1e-9) {
    stack.count = 0;
    stack.damage = 0;
    return before;
  }
  const remaining = total - dmg;
  let survivors = stack.count - Math.min(kills, killCap(stack, dmg, hp));
  const maxSurvivors = Math.floor(remaining / (params.combat.minSurvivorHpFraction * hp) + 1e-9);
  if (survivors > maxSurvivors) survivors = maxSurvivors;
  if (survivors <= 0) {
    stack.count = 0;
    stack.damage = 0;
    return before;
  }
  stack.count = survivors;
  stack.damage = Math.max(0, survivors * hp - remaining);
  return before - survivors;
}

/** Single-stack convenience (tests, docs): expected kills rounded down, remainder dropped. */
export function applyDamage(stack: Stack, dmg: number, hp: number, params: GameParams): number {
  return landDamage(stack, dmg, Math.floor(expectedKills(stack, dmg, hp, params)), hp, params);
}

/**
 * Splits `total` whole kills between stacks in proportion to their expected
 * kills (largest remainder, ties to the earlier army), respecting each cap.
 */
function allocateKills(expected: number[], caps: number[], total: number): number[] {
  const sum = expected.reduce((a, b) => a + b, 0);
  const out = expected.map(() => 0);
  if (sum <= 0 || total <= 0) return out;
  const exact = expected.map((e) => (e * total) / sum);
  let given = 0;
  exact.forEach((x, i) => {
    out[i] = Math.min(caps[i]!, Math.floor(x));
    given += out[i]!;
  });
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let pass = 0; pass < 2 && given < total; pass++) {
    for (const [, i] of order) {
      if (given >= total) break;
      if (out[i]! < caps[i]!) {
        out[i]!++;
        given++;
      }
    }
  }
  return out;
}

function zeroByType(): Record<UnitType, number> {
  return { infantry: 0, armor: 0, artillery: 0, antiArmor: 0 };
}

/**
 * How one side's fire is spread over the enemy, per attacking type. A share
 * (tacticalFocus) goes to the types it has a bonus against; the rest — or all
 * of it when no preferred target is present — is spread by exposure, i.e. each
 * enemy type's share of the remaining HP pool.
 */
export function targetWeights(
  attacker: UnitType,
  enemyHp: Record<UnitType, number>,
  params: GameParams,
): Record<UnitType, number> {
  const w = zeroByType();
  const total = UNIT_TYPES.reduce((s, t) => s + enemyHp[t], 0);
  if (total <= 0) return w;
  const preferred = BONUS_TARGETS[attacker].filter((t) => enemyHp[t] > 0);
  const prefTotal = preferred.reduce((s, t) => s + enemyHp[t], 0);
  const focus = preferred.length ? params.combat.tacticalFocus : 0;
  for (const t of UNIT_TYPES) {
    w[t] = (1 - focus) * (enemyHp[t] / total);
    if (preferred.includes(t)) w[t] += focus * (enemyHp[t] / prefTotal);
  }
  return w;
}

/** Resolves the next round: both sides fire simultaneously, then damage lands. */
export function resolveRound(state: BattleState, params: GameParams): RoundReport {
  if (state.round >= state.totalRounds) throw new Error('battle already finished');
  const round = state.round + 1;
  const rng = new Rng(state.rng);
  const { combat, units } = params;

  const firing: Record<Side, BattleArmy[]> = {
    attacker: participants(state, 'attacker', round),
    defender: participants(state, 'defender', round),
  };
  const eff = zeroBySide();
  const variance = zeroBySide();
  for (const side of SIDES) {
    let p = 0;
    for (const a of firing[side]) p += compositionPower(a.units, params);
    eff[side] = efficiency(p, combat.diminishingThreshold);
    variance[side] = 1 + combat.variance * (2 * rng.next() - 1);
  }

  // 1. Every side computes its fire against the enemy as it stood at round start.
  const incoming: Record<Side, Record<UnitType, number>> = { attacker: zeroByType(), defender: zeroByType() };
  const output: Record<Side, Map<string, number>> = { attacker: new Map(), defender: new Map() };
  for (const side of SIDES) {
    const enemy: Side = side === 'attacker' ? 'defender' : 'attacker';
    const enemyHp = zeroByType();
    for (const a of firing[enemy]) for (const t of UNIT_TYPES) enemyHp[t] += hpPool(a.units[t], units[t].hp);
    for (const a of firing[side]) {
      let armyOut = 0;
      for (const atk of UNIT_TYPES) {
        const n = a.units[atk].count;
        if (n <= 0) continue;
        const fire = n * units[atk].attack * combat.damagePerAttackPerRound * eff[side] * variance[side];
        const w = targetWeights(atk, enemyHp, params);
        for (const tgt of UNIT_TYPES) {
          if (w[tgt] <= 0) continue;
          const mitigation = combat.defenseReference / (combat.defenseReference + units[tgt].defense);
          const bonus = BONUS_TARGETS[atk].includes(tgt) ? combat.bonusMultiplier : 1;
          const d = fire * w[tgt] * bonus * mitigation;
          incoming[enemy][tgt] += d;
          armyOut += d;
        }
      }
      output[side].set(a.id, armyOut);
    }
  }

  // 2. Damage lands simultaneously, split across armies by their HP exposure.
  //    Casualties are counted per side and type, then handed out as whole
  //    units, so the outcome does not depend on how a side is divided.
  const losses: Record<Side, Record<UnitType, number>> = { attacker: zeroByType(), defender: zeroByType() };
  const landed = zeroBySide();
  for (const side of SIDES) {
    for (const t of UNIT_TYPES) {
      const dmg = incoming[side][t];
      if (dmg <= 0) continue;
      const hp = units[t].hp;
      const armies = firing[side];
      const pools = armies.map((a) => hpPool(a.units[t], hp));
      const totalPool = pools.reduce((acc, x) => acc + x, 0);
      if (totalPool <= 0) continue;
      const shares = pools.map((p) => (dmg * p) / totalPool);
      const expected = armies.map((a, i) => expectedKills(a.units[t], shares[i]!, hp, params));
      const caps = armies.map((a, i) => killCap(a.units[t], shares[i]!, hp));
      const owed = expected.reduce((acc, x) => acc + x, 0) + state.carry[side][t];
      const kills = allocateKills(expected, caps, Math.floor(owed));
      const given = kills.reduce((acc, x) => acc + x, 0);
      state.carry[side][t] = Math.min(owed - given, 1e6);
      armies.forEach((a, i) => {
        if (shares[i]! <= 0) return;
        const before = hpPool(a.units[t], hp);
        losses[side][t] += landDamage(a.units[t], shares[i]!, kills[i]!, hp, params);
        landed[side] += before - hpPool(a.units[t], hp);
      });
      if (armies.every((a) => a.units[t].count === 0)) state.carry[side][t] = 0;
    }
  }

  // 3. Credit each army with its share of the damage its side actually landed.
  const damageDealt = zeroBySide();
  for (const side of SIDES) {
    const enemy: Side = side === 'attacker' ? 'defender' : 'attacker';
    const totalOut = [...output[side].values()].reduce((s, x) => s + x, 0);
    damageDealt[side] = landed[enemy];
    if (totalOut <= 0) continue;
    for (const a of firing[side]) a.damageDealt += (landed[enemy] * (output[side].get(a.id) ?? 0)) / totalOut;
  }

  state.round = round;
  state.rng = rng.state;
  return {
    round,
    damageDealt,
    losses,
    power: { attacker: sidePower(state, 'attacker', params), defender: sidePower(state, 'defender', params) },
    firingEfficiency: eff,
  };
}

function zeroBySide(): Record<Side, number> {
  return { attacker: 0, defender: 0 };
}

export interface Outcome {
  winner: Side;
  power: Record<Side, number>;
  effectivePower: Record<Side, number>;
}

/**
 * The side with more surviving victory power wins; a tie goes to the defender.
 * Effective (diminished) power is reported too; because the curve is strictly
 * increasing it can never change the winner.
 */
export function decideOutcome(state: BattleState, params: GameParams): Outcome {
  const power = { attacker: sidePower(state, 'attacker', params), defender: sidePower(state, 'defender', params) };
  const T = params.combat.diminishingThreshold;
  const effective = { attacker: effectivePower(power.attacker, T), defender: effectivePower(power.defender, T) };
  const tieEps = 1e-9 * Math.max(1, power.attacker, power.defender);
  const winner: Side = power.attacker > power.defender + tieEps ? 'attacker' : 'defender';
  return { winner, power, effectivePower: effective };
}

/** Runs all remaining rounds (used by the lab and tests; the server steps one round per minute). */
export function runToEnd(state: BattleState, params: GameParams, onRound?: (r: RoundReport) => void): Outcome {
  while (state.round < state.totalRounds) {
    const r = resolveRound(state, params);
    onRound?.(r);
  }
  return decideOutcome(state, params);
}

/**
 * Coarse public estimate of an enemy force: powers of two bands, so a player
 * learns the order of magnitude but not the exact composition.
 */
export function estimateBand(power: number): [number, number] {
  if (power <= 0) return [0, 0];
  const lo = 2 ** Math.floor(Math.log2(power));
  return [lo, lo * 2];
}
