/**
 * Synthetic geography used by the integration tests, loaded into the real
 * PostGIS land mask. Distances: 1° lat ≈ 111 km, 1° lon at 40.5° ≈ 84.6 km.
 *
 *   MAINLAND  lat 40.0–41.0, lon 0.0–1.0   (with LAKE at 40.50–40.52, 0.50–0.52)
 *   ISLAND    lat 40.0–40.3, lon 1.5–1.8   (~42 km of sea east of the mainland)
 *   FAR       lat 40.0–41.0, lon 4.0–5.0   (~250+ km east, beyond a sea)
 */
export const WORLD = {
  mainland: { south: 40.0, north: 41.0, west: 0.0, east: 1.0 },
  lake: { south: 40.5, north: 40.52, west: 0.5, east: 0.52 },
  island: { south: 40.0, north: 40.3, west: 1.5, east: 1.8 },
  far: { south: 40.0, north: 41.0, west: 4.0, east: 5.0 },
};

type Box = { south: number; north: number; west: number; east: number };

export function boxWkt(b: Box): string {
  return `POLYGON((${b.west} ${b.south}, ${b.east} ${b.south}, ${b.east} ${b.north}, ${b.west} ${b.north}, ${b.west} ${b.south}))`;
}
