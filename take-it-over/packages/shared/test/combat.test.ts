import { describe, expect, it } from 'vitest';
import {
  addArmy,
  type BattleState,
  composition,
  compositionPower,
  createBattle,
  decideOutcome,
  DEFAULT_PARAMS,
  effectivePower,
  efficiency,
  estimateBand,
  firstFullRound,
  type GameParams,
  headcount,
  resolveRound,
  runToEnd,
  sidePower,
  targetWeights,
  UNIT_TYPES,
  type UnitType,
} from '../src';

const MIXED = { infantry: 1000, armor: 50, artillery: 50, antiArmor: 100 };
const noVariance: GameParams = { ...DEFAULT_PARAMS, combat: { ...DEFAULT_PARAMS.combat, variance: 0 } };

function battle(
  armies: { id: string; side: 'attacker' | 'defender'; units: Partial<Record<UnitType, number>>; from?: number }[],
  seed = 7,
  rounds = 180,
): BattleState {
  const s = createBattle(seed, rounds);
  for (const a of armies) {
    addArmy(s, { id: a.id, ownerId: a.id, side: a.side, units: composition(a.units), activeFromRound: a.from ?? 1 });
  }
  return s;
}

const scaled = (k: number) =>
  Object.fromEntries(Object.entries(MIXED).map(([t, n]) => [t, Math.round(n * k)])) as Partial<Record<UnitType, number>>;

describe('determinism', () => {
  it('replays identically from the same seed and differs with another', () => {
    const run = (seed: number) => {
      const s = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: MIXED }], seed);
      runToEnd(s, DEFAULT_PARAMS);
      return JSON.stringify(s);
    };
    expect(run(11)).toBe(run(11));
    expect(run(11)).not.toBe(run(12));
  });

  it('resumes exactly from a saved state (server restart mid-war)', () => {
    const straight = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: MIXED }]);
    runToEnd(straight, DEFAULT_PARAMS);

    const first = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: MIXED }]);
    for (let i = 0; i < 90; i++) resolveRound(first, DEFAULT_PARAMS);
    const restored = JSON.parse(JSON.stringify(first)) as BattleState;
    runToEnd(restored, DEFAULT_PARAMS);
    expect(restored).toEqual(straight);
  });

  it('refuses to run past the last round', () => {
    const s = battle([{ id: 'a', side: 'attacker', units: MIXED }], 1, 2);
    resolveRound(s, DEFAULT_PARAMS);
    resolveRound(s, DEFAULT_PARAMS);
    expect(() => resolveRound(s, DEFAULT_PARAMS)).toThrow();
  });
});

describe('damage', () => {
  it('applies the +50% bonus and defence mitigation exactly', () => {
    const s = battle([
      { id: 'a', side: 'attacker', units: { armor: 100 } },
      { id: 'd', side: 'defender', units: { infantry: 10000 } },
    ]);
    const r = resolveRound(s, noVariance);
    const { combat, units } = noVariance;
    const mitigation = combat.defenseReference / (combat.defenseReference + units.infantry.defense);
    const expected = 100 * units.armor.attack * combat.damagePerAttackPerRound * 1.5 * mitigation;
    expect(r.damageDealt.attacker).toBeCloseTo(expected, 9);
  });

  it('focuses fire on bonus targets and spreads the rest by exposure', () => {
    const hp = { infantry: 1000, armor: 1000, artillery: 0, antiArmor: 0 };
    const w = targetWeights('artillery', hp, DEFAULT_PARAMS);
    expect(w.infantry).toBeCloseTo(0.6 + 0.4 * 0.5, 12);
    expect(w.armor).toBeCloseTo(0.4 * 0.5, 12);
    const none = targetWeights('armor', { infantry: 0, armor: 300, artillery: 100, antiArmor: 0 }, DEFAULT_PARAMS);
    expect(none.armor).toBeCloseTo(0.75, 12);
    expect(none.artillery).toBeCloseTo(0.25, 12);
  });

  it('is simultaneous: a side wiped out in a round still fires in that round', () => {
    const s = battle([
      { id: 'a', side: 'attacker', units: { armor: 5000 } },
      { id: 'd', side: 'defender', units: { infantry: 3 } },
    ]);
    const r = resolveRound(s, noVariance);
    expect(headcount(s.armies.find((a) => a.id === 'd')!.units)).toBe(0);
    expect(r.damageDealt.defender).toBeGreaterThan(0);
  });

  it('makes casualties permanent and keeps survivors damaged', () => {
    const s = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: MIXED }]);
    let prev = s.armies.map((a) => headcount(a.units));
    for (let i = 0; i < 180; i++) {
      resolveRound(s, DEFAULT_PARAMS);
      const now = s.armies.map((a) => headcount(a.units));
      now.forEach((n, j) => expect(n).toBeLessThanOrEqual(prev[j]!));
      prev = now;
    }
    for (const a of s.armies) {
      for (const t of UNIT_TYPES) {
        const st = a.units[t];
        expect(st.damage).toBeGreaterThanOrEqual(0);
        expect(st.damage).toBeLessThan(Math.max(1, st.count * DEFAULT_PARAMS.units[t].hp));
      }
      expect(UNIT_TYPES.some((t) => a.units[t].damage > 0)).toBe(true);
      // power reflects remaining HP, not just headcount
      const fresh = compositionPower(composition(Object.fromEntries(UNIT_TYPES.map((t) => [t, a.units[t].count]))), DEFAULT_PARAMS);
      expect(compositionPower(a.units, DEFAULT_PARAMS)).toBeLessThan(fresh);
    }
  });

  it('never lets survivors average below the minimum HP fraction', () => {
    const s = battle([{ id: 'a', side: 'attacker', units: scaled(3) }, { id: 'd', side: 'defender', units: MIXED }]);
    runToEnd(s, DEFAULT_PARAMS);
    for (const a of s.armies) {
      for (const t of UNIT_TYPES) {
        const st = a.units[t];
        if (!st.count) continue;
        const avg = (st.count * DEFAULT_PARAMS.units[t].hp - st.damage) / st.count;
        expect(avg).toBeGreaterThanOrEqual(DEFAULT_PARAMS.combat.minSurvivorHpFraction * DEFAULT_PARAMS.units[t].hp - 1e-9);
      }
    }
  });
});

describe('reinforcements and timing', () => {
  it('joins at the next complete round', () => {
    const start = 1_000_000;
    expect(firstFullRound(start, start, 60_000)).toBe(1);
    expect(firstFullRound(start + 1, start, 60_000)).toBe(2);
    expect(firstFullRound(start + 30_000, start, 60_000)).toBe(2);
    expect(firstFullRound(start + 60_000, start, 60_000)).toBe(2);
    expect(firstFullRound(start + 60_001, start, 60_000)).toBe(3);
  });

  it('counts a reinforcement from arrival but lets it fire only from its first full round', () => {
    const s = battle([
      { id: 'a', side: 'attacker', units: MIXED },
      { id: 'd', side: 'defender', units: MIXED, from: 5 },
    ]);
    expect(sidePower(s, 'defender', DEFAULT_PARAMS)).toBeGreaterThan(0);
    for (let i = 1; i <= 4; i++) {
      const r = resolveRound(s, DEFAULT_PARAMS);
      expect(r.damageDealt.defender).toBe(0);
      expect(r.damageDealt.attacker).toBe(0); // nothing to shoot at yet
    }
    const r5 = resolveRound(s, DEFAULT_PARAMS);
    expect(r5.damageDealt.defender).toBeGreaterThan(0);
  });

  it('keeps going when one side is temporarily empty', () => {
    const s = battle([
      { id: 'a', side: 'attacker', units: MIXED },
      { id: 'd', side: 'defender', units: {} },
    ]);
    for (let i = 0; i < 100; i++) resolveRound(s, DEFAULT_PARAMS);
    addArmy(s, { id: 'relief', ownerId: 'd', side: 'defender', units: composition(scaled(2)), activeFromRound: 101 });
    const outcome = runToEnd(s, DEFAULT_PARAMS);
    expect(s.round).toBe(180);
    expect(outcome.winner).toBe('defender');
  });

  it('lets a reinforcement arriving after the last round started still count for victory', () => {
    const s = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: {} }], 3, 10);
    for (let i = 0; i < 10; i++) resolveRound(s, DEFAULT_PARAMS);
    expect(decideOutcome(s, DEFAULT_PARAMS).winner).toBe('attacker');
    addArmy(s, { id: 'late', ownerId: 'd', side: 'defender', units: composition(scaled(2)), activeFromRound: 11 });
    expect(decideOutcome(s, DEFAULT_PARAMS).winner).toBe('defender');
  });
});

describe('victory', () => {
  it('gives a tie to the defender', () => {
    const empty = battle([{ id: 'a', side: 'attacker', units: {} }, { id: 'd', side: 'defender', units: {} }]);
    expect(runToEnd(empty, DEFAULT_PARAMS).winner).toBe('defender');
    const mirror = battle([{ id: 'a', side: 'attacker', units: MIXED }, { id: 'd', side: 'defender', units: MIXED }]);
    const o = runToEnd(mirror, noVariance);
    expect(o.power.attacker).toBeCloseTo(o.power.defender, 9);
    expect(o.winner).toBe('defender');
  });

  it('combines attack, defence and remaining HP in victory power', () => {
    const c = composition({ armor: 10 });
    const u = DEFAULT_PARAMS.units.armor;
    expect(compositionPower(c, DEFAULT_PARAMS)).toBeCloseTo(10 * ((u.attack + u.defense) / 2), 12);
    c.armor.damage = 5 * u.hp; // half the pool gone
    expect(compositionPower(c, DEFAULT_PARAMS)).toBeCloseTo(5 * ((u.attack + u.defense) / 2), 12);
  });

  it('gives a coarse estimate of enemy strength', () => {
    expect(estimateBand(0)).toEqual([0, 0]);
    expect(estimateBand(3000)).toEqual([2048, 4096]);
  });
});

describe('diminishing returns', () => {
  const big = scaled(20); // ~43,000 power, far above the 10,000 threshold

  it('scales a side\'s fire by P_eff / P above the threshold', () => {
    const undiminished: GameParams = { ...noVariance, combat: { ...noVariance.combat, diminishingThreshold: 1e12 } };
    const make = () => battle([{ id: 'a', side: 'attacker', units: big }, { id: 'd', side: 'defender', units: big }]);
    const s1 = make();
    const raw = resolveRound(s1, undiminished).damageDealt.attacker;
    const s2 = make();
    const P = sidePower(s2, 'attacker', noVariance);
    expect(P).toBeGreaterThan(10000);
    const reduced = resolveRound(s2, noVariance);
    expect(reduced.firingEfficiency.attacker).toBeCloseTo(efficiency(P, 10000), 12);
    // the first hits fall on fresh units, so landed damage scales the same way
    expect(reduced.damageDealt.attacker / raw).toBeCloseTo(efficiency(P, 10000), 3);
  });

  it('does not remove units or HP: only fire is reduced', () => {
    const s = battle([{ id: 'a', side: 'attacker', units: big }]);
    const before = JSON.stringify(s.armies);
    resolveRound(s, DEFAULT_PARAMS); // no enemy: nothing happens to the attacker
    expect(JSON.stringify(s.armies)).toBe(before);
  });

  it('applies per side and front, so splitting into many armies gains nothing', () => {
    const one = battle([{ id: 'a', side: 'attacker', units: scaled(20) }, { id: 'd', side: 'defender', units: big }]);
    const five = battle([
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, side: 'attacker' as const, units: scaled(4) })),
      { id: 'd', side: 'defender', units: big },
    ]);
    const o1 = runToEnd(one, noVariance);
    const o5 = runToEnd(five, noVariance);
    expect(Math.abs(o5.power.attacker / o1.power.attacker - 1)).toBeLessThan(1e-4);
    expect(Math.abs(o5.power.defender / o1.power.defender - 1)).toBeLessThan(1e-4);
  });

  it('never changes the winner, only the margin', () => {
    for (const [a, d] of [
      [5000, 4000],
      [60000, 59000],
      [9000, 30000],
    ] as const) {
      expect(effectivePower(a, 10000) > effectivePower(d, 10000)).toBe(a > d);
    }
  });
});
