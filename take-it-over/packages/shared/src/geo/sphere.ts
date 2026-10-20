/**
 * Spherical great-circle helpers for gameplay distances (drone radius, AA
 * radius, army and ship movement). A sphere with the IUGG mean radius is within
 * ~0.5% of the ellipsoid, which is well inside the tolerance of these rules.
 * Grid layout itself uses the ellipsoid (see wgs84.ts).
 */

export const EARTH_MEAN_RADIUS_M = 6371008.8;
export const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export function normalizeLon(lon: number): number {
  let x = ((lon + 180) % 360 + 360) % 360 - 180;
  if (x === -180 && lon > 0) x = 180;
  return x;
}

/** Central angle between two points (radians). */
export function centralAngle(a: LatLon, b: LatLon): number {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dp = p2 - p1;
  const dl = (b.lon - a.lon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceM(a: LatLon, b: LatLon): number {
  return centralAngle(a, b) * EARTH_MEAN_RADIUS_M;
}

/** Initial bearing from a to b, radians clockwise from north. */
export function initialBearing(a: LatLon, b: LatLon): number {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

export function destination(a: LatLon, bearingRad: number, distM: number): LatLon {
  const d = distM / EARTH_MEAN_RADIUS_M;
  const p1 = a.lat * DEG;
  const l1 = a.lon * DEG;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(bearingRad));
  const l2 =
    l1 +
    Math.atan2(Math.sin(bearingRad) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / DEG, lon: normalizeLon(l2 / DEG) };
}

/** Point at fraction f (0..1) along the great circle from a to b. */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = centralAngle(a, b);
  if (d < 1e-12) return { lat: a.lat, lon: a.lon };
  const sa = Math.sin((1 - f) * d) / Math.sin(d);
  const sb = Math.sin(f * d) / Math.sin(d);
  const p1 = a.lat * DEG;
  const l1 = a.lon * DEG;
  const p2 = b.lat * DEG;
  const l2 = b.lon * DEG;
  const x = sa * Math.cos(p1) * Math.cos(l1) + sb * Math.cos(p2) * Math.cos(l2);
  const y = sa * Math.cos(p1) * Math.sin(l1) + sb * Math.cos(p2) * Math.sin(l2);
  const z = sa * Math.sin(p1) + sb * Math.sin(p2);
  return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG, lon: normalizeLon(Math.atan2(y, x) / DEG) };
}

/**
 * Points every `stepM` metres along the great circle a→b, both ends included.
 * Used to validate routes against land/water and territory.
 */
export function samplePath(a: LatLon, b: LatLon, stepM: number): LatLon[] {
  const total = distanceM(a, b);
  const steps = Math.max(1, Math.ceil(total / stepM));
  const out: LatLon[] = [];
  for (let i = 0; i <= steps; i++) out.push(interpolate(a, b, i / steps));
  return out;
}

/** Signed cross-track distance of p from the great circle through a→b (metres). */
export function crossTrackM(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = centralAngle(a, p);
  const t13 = initialBearing(a, p);
  const t12 = initialBearing(a, b);
  return Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12)))) * EARTH_MEAN_RADIUS_M;
}

/**
 * Signed distance from a, along a→b, to the point of the great circle closest
 * to p. Negative when that point lies behind a.
 */
export function alongTrackM(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = centralAngle(a, p);
  const t13 = initialBearing(a, p);
  const t12 = initialBearing(a, b);
  const dxt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t13 - t12))));
  const c = Math.cos(d13) / Math.cos(dxt);
  const dat = Math.acos(Math.max(-1, Math.min(1, c)));
  return Math.sign(Math.cos(t13 - t12)) * dat * EARTH_MEAN_RADIUS_M;
}

export interface CircleCrossing {
  /** Distance along the segment (from a) where it first is within the circle. */
  enterM: number;
  /** Distance along the segment where it leaves the circle (clamped to the segment). */
  exitM: number;
}

/**
 * Where (if anywhere) the great-circle segment a→b passes within `radiusM` of
 * `center`. Exact spherical geometry, so long drone legs are not under-sampled.
 */
export function segmentCircleCrossing(
  a: LatLon,
  b: LatLon,
  center: LatLon,
  radiusM: number,
): CircleCrossing | null {
  const length = distanceM(a, b);
  const startInside = distanceM(a, center) <= radiusM;
  if (length < 1e-6) return startInside ? { enterM: 0, exitM: 0 } : null;
  const dxt = crossTrackM(center, a, b);
  if (Math.abs(dxt) > radiusM) return startInside ? { enterM: 0, exitM: 0 } : null;
  const dat = alongTrackM(center, a, b);
  const R = EARTH_MEAN_RADIUS_M;
  const half = Math.acos(Math.max(-1, Math.min(1, Math.cos(radiusM / R) / Math.cos(dxt / R)))) * R;
  const enter = dat - half;
  const exit = dat + half;
  if (startInside) return { enterM: 0, exitM: Math.max(0, Math.min(length, exit)) };
  if (exit < 0 || enter > length) return null;
  return { enterM: Math.max(0, enter), exitM: Math.min(length, exit) };
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}
