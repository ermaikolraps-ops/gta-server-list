import { describe, expect, it } from 'vitest';
import { cellAt, cellId, cellRow, cellCol, clusterCenter, distanceM, firstInterception, planFlight, positionAt } from '../src';

const H = 3600_000;

describe('drone flights', () => {
  it('flies at 300 km/h out and back', () => {
    const plan = planFlight({ lat: 40, lon: 0 }, { lat: 40, lon: 3.5 }, 0, 300);
    const d = distanceM({ lat: 40, lon: 0 }, { lat: 40, lon: 3.5 });
    expect(plan.arriveAt).toBeCloseTo((d / 300_000) * H, -1);
    expect(plan.returnAt).toBe(2 * plan.arriveAt);
    expect(distanceM(positionAt(plan, plan.arriveAt / 2), { lat: 40, lon: 0 })).toBeCloseTo(d / 2, -2);
    expect(positionAt(plan, plan.returnAt)).toEqual({ lat: 40, lon: 0 });
  });

  it('centres a cluster even across the antimeridian', () => {
    const r = cellRow(cellAt(-16.8, 179.9999));
    const east = cellAt(-16.8, 179.9999);
    const west = cellId(r, 0);
    expect(cellCol(east)).toBeGreaterThan(cellCol(west));
    const c = clusterCenter([east, west]);
    expect(Math.abs(Math.abs(c.lon) - 180)).toBeLessThan(0.01);
  });
});

describe('AA interception', () => {
  const launch = { lat: 40, lon: 0 };
  const target = { lat: 40, lon: 2 };
  const plan = planFlight(launch, target, 0, 300);
  const R = 5000;

  it('catches a drone whose outbound path crosses the radius', () => {
    const hit = firstInterception(plan, [{ id: 'aa', lat: 40.02, lon: 1, createdAt: -1 }], R, 0);
    expect(hit).not.toBeNull();
    expect(hit!.at).toBeLessThan(plan.arriveAt);
    expect(distanceM(hit!.position, { lat: 40.02, lon: 1 })).toBeLessThan(R + 50);
  });

  it('ignores batteries away from the path, even near the destination', () => {
    expect(firstInterception(plan, [{ id: 'aa', lat: 40.2, lon: 1, createdAt: -1 }], R, 0)).toBeNull();
    expect(firstInterception(plan, [{ id: 'aa', lat: 40, lon: 2.1 }].map((b) => ({ ...b, createdAt: -1 })), R, 0)).toBeNull();
  });

  it('checks the return leg: a battery built after arrival still catches the drone on the way home', () => {
    const built = plan.arriveAt + 60_000;
    const hit = firstInterception(plan, [{ id: 'late', lat: 40, lon: 1, createdAt: built }], R, built);
    expect(hit).not.toBeNull();
    expect(hit!.at).toBeGreaterThan(plan.arriveAt);
    expect(hit!.at).toBeLessThan(plan.returnAt);
  });

  it('fires immediately when built under a drone already inside the radius', () => {
    const mid = plan.arriveAt / 2;
    const p = positionAt(plan, mid);
    const hit = firstInterception(plan, [{ id: 'aa', lat: p.lat, lon: p.lon, createdAt: mid }], R, mid);
    expect(hit!.at).toBe(Math.ceil(mid));
  });

  it('does not shoot at parts of the path already flown', () => {
    const after = plan.returnAt - 60_000;
    expect(firstInterception(plan, [{ id: 'aa', lat: 40, lon: 0.5, createdAt: after }], R, after)).toBeNull();
  });

  it('picks the earliest of several batteries', () => {
    const hit = firstInterception(
      plan,
      [
        { id: 'far', lat: 40, lon: 1.5, createdAt: -1 },
        { id: 'near', lat: 40, lon: 0.5, createdAt: -1 },
      ],
      R,
      0,
    );
    expect(hit!.batteryId).toBe('near');
  });
});
