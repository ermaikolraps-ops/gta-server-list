import { type BBox, bboxToIdRanges, type CellId, zoneOfCell } from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable, Tx } from '../db/pool';
import { changeParcelCount, lockPlayers, settle } from './economy';

export type AcquiredVia = 'gps' | 'drone' | 'war';

/**
 * Claims neutral cells for a player. The parcels primary key makes this
 * race-free: if two players claim the same cell at once, exactly one insert
 * wins and the other silently gets nothing. Callers must have checked land.
 */
export async function claimNeutralCells(
  tx: Tx,
  ctx: GameContext,
  playerId: string,
  cells: CellId[],
  via: AcquiredVia,
  atMs: number,
): Promise<CellId[]> {
  const unique = [...new Set(cells)];
  if (!unique.length) return [];
  // Settle first so the new parcels only earn from this instant.
  await settle(tx, ctx, playerId, atMs);
  const zones = unique.map(zoneOfCell);
  const res = await tx.query<{ cell_id: string }>(
    `INSERT INTO parcels (cell_id, owner_id, zlat, zlon, acquired_at, acquired_via)
     SELECT c, $2, zl, zo, $3, $4
       FROM unnest($1::bigint[], $5::smallint[], $6::smallint[]) AS u(c, zl, zo)
     ON CONFLICT (cell_id) DO NOTHING
     RETURNING cell_id`,
    [unique, playerId, new Date(atMs), via, zones.map((z) => z.zlat), zones.map((z) => z.zlon)],
  );
  const won = res.rows.map((r) => Number(r.cell_id));
  if (won.length) {
    await tx.query('UPDATE players SET parcel_count = parcel_count + $2 WHERE id = $1', [playerId, won.length]);
  }
  return won;
}

/** Moves cells still owned by `fromId` to `toId`, settling both players at `atMs`. */
export async function transferCells(
  tx: Tx,
  ctx: GameContext,
  cells: CellId[],
  fromId: string,
  toId: string,
  via: AcquiredVia,
  atMs: number,
): Promise<CellId[]> {
  if (!cells.length || fromId === toId) return [];
  await lockPlayers(tx, [fromId, toId]);
  await settle(tx, ctx, fromId, atMs);
  await settle(tx, ctx, toId, atMs);
  const res = await tx.query<{ cell_id: string }>(
    `UPDATE parcels SET owner_id = $3, acquired_at = $4, acquired_via = $5
      WHERE cell_id = ANY($1::bigint[]) AND owner_id = $2
      RETURNING cell_id`,
    [cells, fromId, toId, new Date(atMs), via],
  );
  const moved = res.rows.map((r) => Number(r.cell_id));
  if (moved.length) {
    await changeParcelCount(tx, ctx, fromId, -moved.length, atMs);
    await changeParcelCount(tx, ctx, toId, moved.length, atMs);
  }
  return moved;
}

export async function ownersOf(db: Queryable, cells: CellId[]): Promise<Map<CellId, string>> {
  if (!cells.length) return new Map();
  const res = await db.query<{ cell_id: string; owner_id: string }>(
    'SELECT cell_id, owner_id FROM parcels WHERE cell_id = ANY($1::bigint[])',
    [[...new Set(cells)]],
  );
  return new Map(res.rows.map((r) => [Number(r.cell_id), r.owner_id]));
}

export interface OwnerInfo {
  id: string;
  name: string;
  color: string;
  allianceId: string | null;
  allianceColor: string | null;
}

export type TerritoryView =
  | { mode: 'cells'; cells: [CellId, number][]; owners: OwnerInfo[]; truncated: boolean }
  | { mode: 'zones'; zoneDeg: number; zones: [number, number, number, number][]; owners: OwnerInfo[]; truncated: boolean };

const MAX_CELLS = 30000;
const MAX_ZONES = 20000;

async function ownerInfo(db: Queryable, ids: string[]): Promise<OwnerInfo[]> {
  if (!ids.length) return [];
  const res = await db.query<{
    id: string;
    username: string;
    color: string;
    alliance_id: string | null;
    alliance_color: string | null;
  }>(
    `SELECT p.id, p.username, p.color, a.id AS alliance_id, a.color AS alliance_color
       FROM players p LEFT JOIN alliances a ON a.id = p.alliance_id
      WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id)!;
    return {
      id,
      name: r.username,
      color: r.color,
      allianceId: r.alliance_id,
      allianceColor: r.alliance_color,
    };
  });
}

/**
 * Public territory for a map viewport. Close up it returns individual cells;
 * zoomed out it aggregates parcels into 0.1°–2° bins with the dominant owner.
 */
export async function territoryView(db: Queryable, bbox: BBox, zoom: number): Promise<TerritoryView> {
  if (zoom >= 12) {
    const ranges = bboxToIdRanges(bbox, 4000);
    if (ranges) {
      const res = await db.query<{ cell_id: string; owner_id: string }>(
        `SELECT p.cell_id, p.owner_id
           FROM unnest($1::bigint[], $2::bigint[]) AS r(lo, hi)
           JOIN parcels p ON p.cell_id BETWEEN r.lo AND r.hi
          LIMIT ${MAX_CELLS + 1}`,
        [ranges.map((r) => r.lo), ranges.map((r) => r.hi)],
      );
      const truncated = res.rows.length > MAX_CELLS;
      const rows = res.rows.slice(0, MAX_CELLS);
      const ownerIdx = new Map<string, number>();
      const cells: [CellId, number][] = rows.map((r) => {
        let i = ownerIdx.get(r.owner_id);
        if (i === undefined) {
          i = ownerIdx.size;
          ownerIdx.set(r.owner_id, i);
        }
        return [Number(r.cell_id), i];
      });
      return { mode: 'cells', cells, owners: await ownerInfo(db, [...ownerIdx.keys()]), truncated };
    }
  }
  const k = zoom >= 8 ? 1 : zoom >= 5 ? 5 : 20;
  const zlat0 = Math.max(0, Math.floor((bbox.south + 90) / 0.1));
  const zlat1 = Math.min(1799, Math.floor((bbox.north + 90) / 0.1));
  const lonRanges: [number, number][] =
    bbox.west <= bbox.east
      ? [[Math.floor((bbox.west + 180) / 0.1), Math.min(3599, Math.floor((bbox.east + 180) / 0.1))]]
      : [
          [Math.floor((bbox.west + 180) / 0.1), 3599],
          [0, Math.floor((bbox.east + 180) / 0.1)],
        ];
  const res = await db.query<{ bz: number; bx: number; owner_id: string; n: string }>(
    `SELECT zlat / $1 AS bz, zlon / $1 AS bx, owner_id, count(*) AS n
       FROM parcels
      WHERE zlat BETWEEN $2 AND $3
        AND (zlon BETWEEN $4 AND $5 OR zlon BETWEEN $6 AND $7)
      GROUP BY 1, 2, 3`,
    [
      k,
      zlat0,
      zlat1,
      lonRanges[0]![0],
      lonRanges[0]![1],
      lonRanges[1]?.[0] ?? -1,
      lonRanges[1]?.[1] ?? -1,
    ],
  );
  const bins = new Map<string, { bz: number; bx: number; owner: string; best: number; total: number }>();
  for (const r of res.rows) {
    const key = `${r.bz}:${r.bx}`;
    const n = Number(r.n);
    const b = bins.get(key);
    if (!b) bins.set(key, { bz: r.bz, bx: r.bx, owner: r.owner_id, best: n, total: n });
    else {
      b.total += n;
      if (n > b.best || (n === b.best && r.owner_id < b.owner)) {
        b.best = n;
        b.owner = r.owner_id;
      }
    }
  }
  const ownerIdx = new Map<string, number>();
  const zones: [number, number, number, number][] = [];
  for (const b of bins.values()) {
    if (zones.length >= MAX_ZONES) break;
    let i = ownerIdx.get(b.owner);
    if (i === undefined) {
      i = ownerIdx.size;
      ownerIdx.set(b.owner, i);
    }
    zones.push([b.bz, b.bx, i, b.total]);
  }
  return {
    mode: 'zones',
    zoneDeg: 0.1 * k,
    zones,
    owners: await ownerInfo(db, [...ownerIdx.keys()]),
    truncated: bins.size > MAX_ZONES,
  };
}
