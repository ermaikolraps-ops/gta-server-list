import { type CellId, cellCenter } from './grid/cells';
import { distanceM, interpolate, type LatLon, normalizeLon, segmentCircleCrossing } from './geo/sphere';

/**
 * A drone flies a great circle from its launch point to the centre of its
 * target cluster, captures on arrival, and flies the same great circle back.
 * (20 side-connected cells span at most ~2 km, so the sweep over the cluster
 * itself is folded into the arrival instant.)
 */
export interface FlightPlan {
  launch: LatLon;
  target: LatLon;
  launchedAt: number;
  arriveAt: number;
  returnAt: number;
}

export function clusterCenter(cells: CellId[]): LatLon {
  const pts = cells.map(cellCenter);
  const ref = pts[0]!.lon;
  let lat = 0;
  let dlon = 0;
  for (const p of pts) {
    lat += p.lat;
    dlon += normalizeLon(p.lon - ref); // safe across the antimeridian
  }
  return { lat: lat / pts.length, lon: normalizeLon(ref + dlon / pts.length) };
}

export function planFlight(launch: LatLon, target: LatLon, launchedAt: number, speedKmh: number): FlightPlan {
  const legMs = Math.ceil((distanceM(launch, target) / (speedKmh * 1000)) * 3600_000);
  return { launch, target, launchedAt, arriveAt: launchedAt + legMs, returnAt: launchedAt + 2 * legMs };
}

/** Where the drone is at time `t`. */
export function positionAt(plan: FlightPlan, t: number): LatLon {
  if (t <= plan.launchedAt) return plan.launch;
  if (t >= plan.returnAt) return plan.launch;
  if (t <= plan.arriveAt) {
    const f = (t - plan.launchedAt) / Math.max(1, plan.arriveAt - plan.launchedAt);
    return interpolate(plan.launch, plan.target, f);
  }
  const f = (t - plan.arriveAt) / Math.max(1, plan.returnAt - plan.arriveAt);
  return interpolate(plan.target, plan.launch, f);
}

export interface AaSite {
  id: string;
  lat: number;
  lon: number;
  /** Batteries only shoot from the moment they exist. */
  createdAt: number;
}

export interface Interception {
  at: number;
  batteryId: string;
  position: LatLon;
}

/**
 * Earliest moment at or after `fromMs` when the drone is inside the radius of
 * one of the given (hostile) batteries, checking the outbound AND return legs
 * exactly, not just the destination. A battery built while the drone is
 * already inside its radius fires the moment it is built.
 */
export function firstInterception(
  plan: FlightPlan,
  batteries: AaSite[],
  radiusM: number,
  fromMs: number,
): Interception | null {
  const legs = [
    { a: plan.launch, b: plan.target, t0: plan.launchedAt, t1: plan.arriveAt },
    { a: plan.target, b: plan.launch, t0: plan.arriveAt, t1: plan.returnAt },
  ];
  let best: Interception | null = null;
  for (const leg of legs) {
    const len = distanceM(leg.a, leg.b);
    const dur = leg.t1 - leg.t0;
    for (const bat of batteries) {
      const hit = segmentCircleCrossing(leg.a, leg.b, bat, radiusM);
      if (!hit) continue;
      const toTime = (m: number) => (len > 0 ? leg.t0 + (m / len) * dur : leg.t0);
      const enter = toTime(hit.enterM);
      const exit = len > 0 ? toTime(hit.exitM) : leg.t1;
      const at = Math.ceil(Math.max(enter, bat.createdAt, fromMs, leg.t0));
      if (at > Math.min(exit, leg.t1)) continue;
      if (!best || at < best.at) best = { at, batteryId: bat.id, position: positionAt(plan, at) };
    }
  }
  return best;
}
