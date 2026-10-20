import {
  addArmy,
  composition,
  createBattle,
  type GameParams,
  headcount,
  Rng,
  runToEnd,
  type Side,
  sidePower,
} from '@tio/shared';
import type { Scenario } from './scenarios';

export interface BattleResult {
  seed: number;
  winner: Side;
  casualties: Record<Side, number>;
  hpLoss: Record<Side, number>;
  power: Record<Side, number>;
  startPower: Record<Side, number>;
}

function sideTotals(state: ReturnType<typeof createBattle>, params: GameParams) {
  const units = { attacker: 0, defender: 0 };
  const hp = { attacker: 0, defender: 0 };
  for (const a of state.armies) {
    units[a.side] += headcount(a.units);
    for (const [t, s] of Object.entries(a.units)) {
      hp[a.side] += s.count * params.units[t as keyof GameParams['units']].hp - s.damage;
    }
  }
  return { units, hp };
}

/** One battle, fully determined by (scenario, seed, params). */
export function runBattle(sc: Scenario, seed: number, params: GameParams): BattleResult {
  const jitter = new Rng(seed ^ 0x9e3779b9);
  const state = createBattle(seed, params.war.durationMinutes * 60 / params.war.roundSeconds);
  sc.armies.forEach((spec, i) => {
    const k = 1 + sc.jitter * (2 * jitter.next() - 1);
    const counts = Object.fromEntries(Object.entries(spec.units).map(([t, n]) => [t, Math.round(n! * k)]));
    addArmy(state, {
      id: `army-${String(i).padStart(2, '0')}`,
      ownerId: spec.owner ?? spec.side,
      side: spec.side,
      units: composition(counts),
      activeFromRound: spec.fromRound ?? 1,
    });
  });
  const before = sideTotals(state, params);
  const startPower = { attacker: sidePower(state, 'attacker', params), defender: sidePower(state, 'defender', params) };
  const outcome = runToEnd(state, params);
  const after = sideTotals(state, params);
  const ratio = (a: number, b: number) => (b > 0 ? 1 - a / b : 0);
  return {
    seed,
    winner: outcome.winner,
    casualties: {
      attacker: ratio(after.units.attacker, before.units.attacker),
      defender: ratio(after.units.defender, before.units.defender),
    },
    hpLoss: { attacker: ratio(after.hp.attacker, before.hp.attacker), defender: ratio(after.hp.defender, before.hp.defender) },
    power: outcome.power,
    startPower,
  };
}

export interface Distribution {
  mean: number;
  p10: number;
  median: number;
  p90: number;
}

export interface Metrics {
  scenario: string;
  battles: number;
  firstSeed: number;
  attackerWinRate: number;
  casualties: Record<Side, Distribution>;
  hpLoss: Record<Side, Distribution>;
  survivingPowerRatio: Distribution;
  msPerBattle: number;
}

function distribution(xs: number[]): Distribution {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length), p10: q(0.1), median: q(0.5), p90: q(0.9) };
}

export function runScenario(sc: Scenario, battles: number, firstSeed: number, params: GameParams): Metrics {
  const t0 = performance.now();
  const results: BattleResult[] = [];
  for (let i = 0; i < battles; i++) results.push(runBattle(sc, (firstSeed + i) >>> 0, params));
  const ms = performance.now() - t0;
  return {
    scenario: sc.id,
    battles,
    firstSeed,
    attackerWinRate: results.filter((r) => r.winner === 'attacker').length / battles,
    casualties: {
      attacker: distribution(results.map((r) => r.casualties.attacker)),
      defender: distribution(results.map((r) => r.casualties.defender)),
    },
    hpLoss: {
      attacker: distribution(results.map((r) => r.hpLoss.attacker)),
      defender: distribution(results.map((r) => r.hpLoss.defender)),
    },
    survivingPowerRatio: distribution(
      results.map((r) => (r.power.defender > 0 ? r.power.attacker / r.power.defender : r.power.attacker > 0 ? Infinity : 1)),
    ),
    msPerBattle: ms / battles,
  };
}

/**
 * Finds the damage constant at which the target scenario's median casualty
 * rate (mean of both sides) hits `target`. Casualties grow monotonically with
 * the constant, so a bisection in log space converges quickly.
 */
export function calibrateDamage(
  sc: Scenario,
  params: GameParams,
  target = 0.5,
  battles = 200,
  firstSeed = 1,
): { damagePerAttackPerRound: number; median: number } {
  let lo = Math.log(1e-5);
  let hi = Math.log(1);
  let best = { damagePerAttackPerRound: 0, median: 0 };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const k = Math.exp(mid);
    const p = { ...params, combat: { ...params.combat, damagePerAttackPerRound: k } };
    const m = runScenario(sc, battles, firstSeed, p);
    const median = (m.casualties.attacker.median + m.casualties.defender.median) / 2;
    best = { damagePerAttackPerRound: k, median };
    if (Math.abs(median - target) < 0.002) break;
    if (median < target) lo = mid;
    else hi = mid;
  }
  return best;
}

/**
 * Equal-power duels between pure single-type forces. Returns, for each pair,
 * the attacker's win rate — a quick check of the rock-paper-scissors the
 * approved bonuses are meant to create.
 */
export function matchupMatrix(params: GameParams, battles = 50, power = 2000): Record<string, Record<string, number>> {
  const types = ['infantry', 'armor', 'artillery', 'antiArmor'] as const;
  const per = (t: (typeof types)[number]) => (params.units[t].attack + params.units[t].defense) / 2;
  const out: Record<string, Record<string, number>> = {};
  for (const a of types) {
    out[a] = {};
    for (const d of types) {
      const sc: Scenario = {
        id: `${a}-vs-${d}`,
        description: '',
        armies: [
          { side: 'attacker', units: { [a]: Math.round(power / per(a)) } },
          { side: 'defender', units: { [d]: Math.round(power / per(d)) } },
        ],
        jitter: 0.05,
      };
      out[a]![d] = runScenario(sc, battles, 1, params).attackerWinRate;
    }
  }
  return out;
}
