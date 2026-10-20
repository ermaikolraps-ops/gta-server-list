import { describe, expect, it } from 'vitest';
import {
  accruedUnits,
  balanceUnitsAt,
  creditsToUnits,
  DEFAULT_PARAMS,
  effectivePower,
  efficiency,
  mergeParams,
  paramCatalog,
  unitsToCredits,
  bonusMultiplier,
  UNIT_TYPES,
} from '../src';

describe('credit units', () => {
  it('pays exactly 1 credit per parcel per hour', () => {
    expect(unitsToCredits(accruedUnits(1, 3_600_000, 1))).toBe(1);
    expect(unitsToCredits(accruedUnits(250, 3_600_000 * 3, 1))).toBe(750);
    expect(unitsToCredits(accruedUnits(1, 3_599_999, 1))).toBe(0);
  });

  it('does not drift when settled often', () => {
    let units = creditsToUnits(1000);
    let t = 0;
    for (let i = 0; i < 10_000; i++) {
      units = balanceUnitsAt(units, 7, t, t + 361, 1);
      t += 361;
    }
    expect(units).toBe(creditsToUnits(1000) + accruedUnits(7, t, 1));
  });

  it('accrues nothing for negative elapsed time or zero parcels', () => {
    expect(accruedUnits(5, -100, 1)).toBe(0n);
    expect(accruedUnits(0, 1000, 1)).toBe(0n);
  });
});

describe('diminishing returns', () => {
  it('is identity up to the threshold and logarithmic above', () => {
    expect(effectivePower(5000, 10000)).toBe(5000);
    expect(effectivePower(10000, 10000)).toBe(10000);
    expect(effectivePower(10000 * Math.E, 10000)).toBeCloseTo(20000, 6);
    expect(efficiency(20000, 10000)).toBeCloseTo((10000 * (1 + Math.log(2))) / 20000, 12);
  });

  it('is strictly increasing so it never flips who is stronger', () => {
    let prev = -1;
    for (let p = 0; p < 200000; p += 997) {
      const e = effectivePower(p, 10000);
      expect(e).toBeGreaterThan(prev);
      prev = e;
    }
  });
});

describe('parameters', () => {
  it('encodes the approved rules from the design spec', () => {
    const p = DEFAULT_PARAMS;
    expect(p.economy.startingCredits).toBe(1000);
    expect(p.economy.creditsPerParcelPerHour).toBe(1);
    expect(p.gps.dwellMs).toBe(2000);
    expect(p.gps.maxAccuracyM).toBe(20);
    expect(p.drones.types.basic.radiusKm).toBe(300);
    expect(p.drones.types.advanced.radiusKm).toBe(600);
    expect(p.drones.types.longRange.radiusKm).toBe(1500);
    expect(p.drones.speedKmh).toBe(300);
    expect(p.drones.maxActive).toBe(10);
    expect(p.drones.maxTargets).toBe(20);
    expect(p.aa.radiusKm).toBe(5);
    expect(p.war.durationMinutes).toBe(180);
    expect(p.war.roundSeconds).toBe(60);
    expect(p.war.maxSectorParcels).toBe(100);
    expect(p.war.autoDefenseRadiusKm).toBe(100);
    expect(p.armies.speedKmh).toBe(100);
    expect(p.armies.operationalRadiusKm).toBe(100);
    expect(p.combat.diminishingThreshold).toBe(10000);
    expect(p.combat.bonusMultiplier).toBe(1.5);
    expect(p.bases.repairMinutes).toBe(30);
    expect(p.ships.speedKmh).toBe(100);
    expect(p.ships.capacityUnits).toBe(10000);
    expect(p.alliances.maxMembers).toBe(10);
  });

  it('applies the approved +50% matchups and nothing else', () => {
    const bonus = (a: (typeof UNIT_TYPES)[number], t: (typeof UNIT_TYPES)[number]) =>
      bonusMultiplier(a, t, DEFAULT_PARAMS);
    expect(bonus('infantry', 'antiArmor')).toBe(1.5);
    expect(bonus('armor', 'infantry')).toBe(1.5);
    expect(bonus('artillery', 'infantry')).toBe(1.5);
    expect(bonus('artillery', 'antiArmor')).toBe(1.5);
    expect(bonus('antiArmor', 'armor')).toBe(1.5);
    let bonusPairs = 0;
    for (const a of UNIT_TYPES) for (const t of UNIT_TYPES) if (bonus(a, t) > 1) bonusPairs++;
    expect(bonusPairs).toBe(5);
  });

  it('lists every parameter with a status, and marks all prices provisional', () => {
    const cat = paramCatalog();
    expect(cat.length).toBeGreaterThan(40);
    for (const e of cat) expect(['approved', 'provisional']).toContain(e.status);
    for (const e of cat.filter((x) => x.path.endsWith('.price'))) expect(e.status).toBe('provisional');
    for (const e of cat.filter((x) => x.status === 'provisional')) expect(e.note).toBeTruthy();
  });

  it('merges validated overrides and rejects typos', () => {
    const p = mergeParams(DEFAULT_PARAMS, { units: { armor: { price: 20 } } });
    expect(p.units.armor.price).toBe(20);
    expect(p.units.armor.attack).toBe(DEFAULT_PARAMS.units.armor.attack);
    expect(() => mergeParams(DEFAULT_PARAMS, { units: { armour: { price: 1 } } })).toThrow(/unknown param/);
    expect(() => mergeParams(DEFAULT_PARAMS, { aa: { radiusKm: '5' } })).toThrow(/expected number/);
    expect(() => mergeParams(DEFAULT_PARAMS, { economy: { creditsPerParcelPerHour: 1.5 } })).toThrow(/integer/);
  });
});
