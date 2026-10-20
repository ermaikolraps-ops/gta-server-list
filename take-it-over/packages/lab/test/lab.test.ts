import { DEFAULT_PARAMS } from '@tio/shared';
import { describe, expect, it } from 'vitest';
import { calibrateDamage, matchupMatrix, runBattle, runScenario } from '../src/run';
import { scenario, SCENARIOS } from '../src/scenarios';

describe('battle lab', () => {
  it('reproduces every battle from its seed', () => {
    for (const sc of SCENARIOS) expect(runBattle(sc, 99, DEFAULT_PARAMS)).toEqual(runBattle(sc, 99, DEFAULT_PARAMS));
    const a = runScenario(scenario('balanced-small'), 50, 5, DEFAULT_PARAMS);
    const b = runScenario(scenario('balanced-small'), 50, 5, DEFAULT_PARAMS);
    expect({ ...a, msPerBattle: 0 }).toEqual({ ...b, msPerBattle: 0 });
  });

  it('meets the calibration target: balanced wars lose 40–60% of units', () => {
    const m = runScenario(scenario('balanced-small'), 300, 1, DEFAULT_PARAMS);
    for (const side of ['attacker', 'defender'] as const) {
      expect(m.casualties[side].median).toBeGreaterThan(0.4);
      expect(m.casualties[side].median).toBeLessThan(0.6);
    }
    expect(m.attackerWinRate).toBeGreaterThan(0.4);
    expect(m.attackerWinRate).toBeLessThan(0.6);
  });

  it('finds the default damage constant when calibrating', () => {
    const r = calibrateDamage(scenario('balanced-small'), DEFAULT_PARAMS, 0.5, 100);
    expect(r.damagePerAttackPerRound / DEFAULT_PARAMS.combat.damagePerAttackPerRound).toBeGreaterThan(0.9);
    expect(r.damagePerAttackPerRound / DEFAULT_PARAMS.combat.damagePerAttackPerRound).toBeLessThan(1.1);
  });

  it('gives no advantage for splitting a force into many armies', () => {
    const m = runScenario(scenario('split-exploit'), 300, 1, DEFAULT_PARAMS);
    expect(m.attackerWinRate).toBeGreaterThan(0.4);
    expect(m.attackerWinRate).toBeLessThan(0.6);
  });

  it('lets the approved bonus decide equal-power duels with the provisional stats', () => {
    const m = matchupMatrix(DEFAULT_PARAMS, 20);
    expect(m.infantry!.antiArmor).toBe(1);
    expect(m.armor!.infantry).toBe(1);
    expect(m.antiArmor!.armor).toBe(1);
    expect(m.artillery!.infantry).toBe(1);
    expect(m.artillery!.antiArmor).toBe(1);
  });
});
