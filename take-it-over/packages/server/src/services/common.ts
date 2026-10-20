import {
  type CellId,
  cellAt,
  type Composition,
  compositionPower,
  distanceM,
  emptyComposition,
  headcount,
  type LatLon,
  samplePath,
  UNIT_TYPES,
  type UnitType,
} from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable } from '../db/pool';
import { GameError } from '../errors';
import { ownersOf } from './territory';

// ----------------------------------------------------------- relations

/** Alliance id per player (null when not in one). */
export async function alliancesOf(db: Queryable, ids: string[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const res = await db.query<{ id: string; alliance_id: string | null }>(
    'SELECT id, alliance_id FROM players WHERE id = ANY($1::uuid[])',
    [uniq],
  );
  return new Map(res.rows.map((r) => [r.id, r.alliance_id]));
}

export function friendlyWith(a: string, b: string, alliances: Map<string, string | null>): boolean {
  if (a === b) return true;
  const x = alliances.get(a);
  return !!x && x === alliances.get(b);
}

/** The player and every member of their alliance. */
export async function friendlyIds(db: Queryable, playerId: string): Promise<Set<string>> {
  const res = await db.query<{ id: string }>(
    `SELECT p.id FROM players p
      WHERE p.id = $1
         OR (p.alliance_id IS NOT NULL AND p.alliance_id = (SELECT alliance_id FROM players WHERE id = $1))`,
    [playerId],
  );
  return new Set(res.rows.map((r) => r.id));
}

// ----------------------------------------------------------- routes

export type RouteProblem = 'water' | 'foreign_territory' | 'too_far' | 'not_coast';

export interface RouteCheck {
  ok: boolean;
  problem?: RouteProblem;
  distanceM: number;
}

/**
 * A land route is the great circle between two points, sampled every
 * armies.routeSampleM metres. Every cell it crosses must be land and either
 * neutral, the mover's, an ally's, or explicitly allowed (a war sector). The
 * cell the army starts in is exempt (it is already there). Routes do not path
 * around obstacles: an invalid straight line must be split into legs.
 */
export async function checkLandRoute(
  db: Queryable,
  ctx: GameContext,
  ownerId: string,
  from: LatLon,
  to: LatLon,
  opts: { maxM?: number; allowedCells?: Set<CellId>; friendly?: Set<string> } = {},
): Promise<RouteCheck> {
  const dist = distanceM(from, to);
  if (opts.maxM !== undefined && dist > opts.maxM) return { ok: false, problem: 'too_far', distanceM: dist };
  const start = cellAt(from.lat, from.lon);
  const cells = [...new Set(samplePath(from, to, ctx.params.armies.routeSampleM).map((p) => cellAt(p.lat, p.lon)))];
  const land = await ctx.land.cellsOnLand(cells);
  if (cells.some((c) => c !== start && !land.get(c))) return { ok: false, problem: 'water', distanceM: dist };
  const owners = await ownersOf(db, cells);
  const friendly = opts.friendly ?? (await friendlyIds(db, ownerId));
  for (const [cell, owner] of owners) {
    if (cell === start || friendly.has(owner) || opts.allowedCells?.has(cell)) continue;
    return { ok: false, problem: 'foreign_territory', distanceM: dist };
  }
  return { ok: true, distanceM: dist };
}

/** A land point with water within ships.maxCoastDistanceM. */
export async function isCoastal(ctx: GameContext, p: LatLon): Promise<boolean> {
  const [onLand] = await ctx.land.pointsOnLand([p]);
  if (!onLand) return false;
  const R = ctx.params.ships.maxCoastDistanceM;
  const probes: LatLon[] = [];
  for (const frac of [0.33, 0.66, 1]) {
    for (let k = 0; k < 8; k++) {
      const brg = (k * Math.PI) / 4;
      const dLat = ((R * frac) / 111_195) * Math.cos(brg);
      const dLon = ((R * frac) / (111_195 * Math.cos((p.lat * Math.PI) / 180))) * Math.sin(brg);
      probes.push({ lat: p.lat + dLat, lon: p.lon + dLon });
    }
  }
  return (await ctx.land.pointsOnLand(probes)).some((x) => !x);
}

/**
 * A sea route visits each waypoint in order along great circles; every sample
 * must be water except within maxCoastDistanceM of the first and last point
 * (leaving and reaching the coast).
 */
export async function checkSeaRoute(ctx: GameContext, points: LatLon[]): Promise<RouteCheck> {
  let total = 0;
  const samples: { p: LatLon; nearEnds: boolean }[] = [];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const coast = ctx.params.ships.maxCoastDistanceM;
  for (let i = 0; i + 1 < points.length; i++) {
    total += distanceM(points[i]!, points[i + 1]!);
    for (const p of samplePath(points[i]!, points[i + 1]!, ctx.params.ships.routeSampleM)) {
      samples.push({ p, nearEnds: distanceM(p, first) <= coast || distanceM(p, last) <= coast });
    }
  }
  const check = samples.filter((s) => !s.nearEnds);
  const land = await ctx.land.pointsOnLand(check.map((s) => s.p));
  if (land.some((x) => x)) return { ok: false, problem: 'water', distanceM: total };
  return { ok: true, distanceM: total };
}

// ----------------------------------------------------------- armies

export function parseUnits(json: unknown): Composition {
  const c = emptyComposition();
  const src = (json ?? {}) as Record<string, { count?: number; damage?: number }>;
  for (const t of UNIT_TYPES) c[t] = { count: Number(src[t]?.count ?? 0), damage: Number(src[t]?.damage ?? 0) };
  return c;
}

export function unitsJson(c: Composition): string {
  const out: Record<string, { count: number; damage: number }> = {};
  for (const t of UNIT_TYPES) out[t] = { count: c[t].count, damage: c[t].count > 0 ? c[t].damage : 0 };
  return JSON.stringify(out);
}

export function healthOf(c: Composition, ctx: GameContext): number {
  let max = 0;
  let cur = 0;
  for (const t of UNIT_TYPES) {
    const hp = ctx.params.units[t].hp;
    max += c[t].count * hp;
    cur += c[t].count * hp - c[t].damage;
  }
  return max > 0 ? cur / max : 1;
}

export function costOfUnits(counts: Partial<Record<UnitType, number>>, ctx: GameContext): number {
  let cost = 0;
  for (const t of UNIT_TYPES) {
    const n = counts[t] ?? 0;
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new GameError('bad_units', 'invalid unit counts', 400);
    cost += n * ctx.params.units[t].price;
  }
  return Math.ceil(cost);
}

/** Repair price: factor × unit price × share of HP restored, summed over types. */
export function repairCost(c: Composition, ctx: GameContext): number {
  let cost = 0;
  for (const t of UNIT_TYPES) {
    const u = ctx.params.units[t];
    cost += (c[t].damage / u.hp) * u.price * ctx.params.bases.repairCostFactor;
  }
  return Math.ceil(cost);
}

export interface ArmyRow {
  id: string;
  owner_id: string;
  units: unknown;
  status: 'idle' | 'moving' | 'at_war' | 'repairing' | 'sailing' | 'retreating';
  lat: number;
  lon: number;
  from_lat: number | null;
  from_lon: number | null;
  to_lat: number | null;
  to_lon: number | null;
  depart_at: Date | null;
  arrive_at: Date | null;
  war_id: string | null;
  war_side: 'attacker' | 'defender' | null;
  ship_id: string | null;
}

export async function lockArmy(db: Queryable, armyId: string, ownerId?: string): Promise<ArmyRow> {
  const res = await db.query<ArmyRow>('SELECT * FROM armies WHERE id = $1 FOR UPDATE', [armyId]);
  const row = res.rows[0];
  if (!row || (ownerId && row.owner_id !== ownerId)) throw new GameError('not_found', 'army not found', 404);
  return row;
}

export function requireIdle(row: ArmyRow): void {
  if (row.status !== 'idle') throw new GameError('army_busy', 'that army is busy', 409, { status: row.status });
  if (headcount(parseUnits(row.units)) <= 0) throw new GameError('army_empty', 'that army has no units', 409);
}

export function armyPower(row: ArmyRow, ctx: GameContext): number {
  return compositionPower(parseUnits(row.units), ctx.params);
}

export function validUnitsInput(units: Partial<Record<UnitType, number>>): void {
  for (const [k, v] of Object.entries(units)) {
    if (!(UNIT_TYPES as readonly string[]).includes(k)) throw new GameError('bad_units', `unknown unit type ${k}`, 400);
    if (!Number.isInteger(v) || (v as number) < 0) throw new GameError('bad_units', 'unit counts must be whole numbers', 400);
  }
  if (!Object.values(units).some((v) => (v ?? 0) > 0)) throw new GameError('bad_units', 'choose at least one unit', 400);
}
