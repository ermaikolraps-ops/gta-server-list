import { describe, expect, it } from 'vitest';
import {
  DEG,
  distanceM,
  interpolate,
  latFromMeridianArc,
  meridianArc,
  QUARTER_MERIDIAN_M,
  samplePath,
  segmentCircleCrossing,
  WGS84_A,
  WGS84_E2,
} from '../src';
import { testRng } from './rng';

/** Independent check: integrate the meridional radius of curvature with Simpson's rule. */
function meridianArcNumeric(latRad: number): number {
  const steps = 20000;
  const h = latRad / steps;
  const f = (p: number) => (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * Math.sin(p) ** 2) ** 1.5;
  let s = f(0) + f(latRad);
  for (let i = 1; i < steps; i++) s += f(i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

describe('WGS84 meridian arc', () => {
  it('matches the known quarter meridian', () => {
    expect(QUARTER_MERIDIAN_M).toBeCloseTo(10001965.729, 2);
  });

  it('matches numerical integration at many latitudes', () => {
    for (const lat of [1, 10, 23.4, 45, 60, 75, 89.9]) {
      expect(Math.abs(meridianArc(lat * DEG) - meridianArcNumeric(lat * DEG))).toBeLessThan(0.001);
    }
  });

  it('round-trips latitude ↔ arc length to well under a millimetre', () => {
    const rnd = testRng(1);
    for (let i = 0; i < 2000; i++) {
      const lat = (rnd() * 180 - 90) * DEG;
      const back = latFromMeridianArc(meridianArc(lat));
      expect(Math.abs(back - lat) * 6.4e6).toBeLessThan(1e-4);
    }
  });
});

describe('great-circle helpers', () => {
  it('measures one degree of latitude on the mean sphere', () => {
    expect(distanceM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111195.08, 0);
  });

  it('finds where a segment enters a circle (matches brute force)', () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 10 };
    const center = { lat: 0.03, lon: 5 };
    const hit = segmentCircleCrossing(a, b, center, 5000);
    expect(hit).not.toBeNull();
    const pts = samplePath(a, b, 10);
    const total = distanceM(a, b);
    const firstInside = pts.findIndex((p) => distanceM(p, center) <= 5000);
    const bruteEnter = (firstInside / (pts.length - 1)) * total;
    expect(Math.abs(hit!.enterM - bruteEnter)).toBeLessThan(20);
  });

  it('returns null when the segment stays outside or ends before the circle', () => {
    expect(segmentCircleCrossing({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, { lat: 0.2, lon: 5 }, 5000)).toBeNull();
    expect(segmentCircleCrossing({ lat: 0, lon: 0 }, { lat: 0, lon: 4 }, { lat: 0, lon: 5 }, 5000)).toBeNull();
    expect(segmentCircleCrossing({ lat: 0, lon: 6 }, { lat: 0, lon: 10 }, { lat: 0, lon: 5 }, 5000)).toBeNull();
  });

  it('reports entry at 0 when the start point is already inside', () => {
    const hit = segmentCircleCrossing({ lat: 0, lon: 5 }, { lat: 0, lon: 10 }, { lat: 0, lon: 5.01 }, 5000);
    expect(hit?.enterM).toBe(0);
  });

  it('agrees with brute force on random long legs', () => {
    const rnd = testRng(7);
    for (let i = 0; i < 200; i++) {
      const a = { lat: rnd() * 120 - 60, lon: rnd() * 360 - 180 };
      const b = { lat: a.lat + (rnd() - 0.5) * 20, lon: a.lon + (rnd() - 0.5) * 20 };
      const t = rnd();
      const onPath = interpolate(a, b, t);
      const center = { lat: onPath.lat + (rnd() - 0.5) * 0.1, lon: onPath.lon + (rnd() - 0.5) * 0.1 };
      const r = 5000;
      const hit = segmentCircleCrossing(a, b, center, r);
      const pts = samplePath(a, b, 50);
      const total = distanceM(a, b);
      const idx = pts.findIndex((p) => distanceM(p, center) <= r);
      if (idx === -1) {
        // brute force at 50 m can only miss grazing hits a few metres deep
        if (hit) expect(hit.exitM - hit.enterM).toBeLessThan(1000);
      } else {
        expect(hit).not.toBeNull();
        expect(Math.abs(hit!.enterM - (idx / (pts.length - 1)) * total)).toBeLessThan(120);
      }
    }
  });
});
