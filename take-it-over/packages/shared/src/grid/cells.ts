import { type BBox, DEG, type LatLon, normalizeLon } from '../geo/sphere';
import { latFromMeridianArc, meridianArc, parallelCircumference, QUARTER_MERIDIAN_M } from '../geo/wgs84';
import { BAND_COLS, BAND_START_D } from './bandTable.generated';
import { COL_FACTOR, MAX_ROW_DISTANCE, MID_ROW, ROW_COUNT, ROW_HEIGHT_M } from './spec';

/**
 * A cell id packs (row, col) as row * 2^19 + col. Max id ≈ 1.05e11, well inside
 * Number.MAX_SAFE_INTEGER and Postgres BIGINT. Ids are stable for grid v1.
 */
export type CellId = number;

const COLS_BY_D = new Int32Array(MAX_ROW_DISTANCE + 1);
const BAND_BY_D = new Int32Array(MAX_ROW_DISTANCE + 1);
for (let b = 0; b < BAND_START_D.length; b++) {
  const start = BAND_START_D[b]!;
  const end = b + 1 < BAND_START_D.length ? BAND_START_D[b + 1]! - 1 : MAX_ROW_DISTANCE;
  for (let d = start; d <= end; d++) {
    COLS_BY_D[d] = BAND_COLS[b]!;
    BAND_BY_D[d] = b;
  }
}

export function rowDistance(row: number): number {
  return Math.abs(row - MID_ROW);
}

export function colsInRow(row: number): number {
  return COLS_BY_D[rowDistance(row)]!;
}

/** Band index (0 at the equator) of a row; rows in the same band have aligned columns. */
export function bandOfRow(row: number): number {
  return BAND_BY_D[rowDistance(row)]!;
}

export function cellId(row: number, col: number): CellId {
  return row * COL_FACTOR + col;
}

export function cellRow(id: CellId): number {
  return Math.floor(id / COL_FACTOR);
}

export function cellCol(id: CellId): number {
  return id - Math.floor(id / COL_FACTOR) * COL_FACTOR;
}

export function isValidCellId(id: unknown): id is CellId {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return false;
  const row = cellRow(id);
  if (row >= ROW_COUNT) return false;
  return cellCol(id) < colsInRow(row);
}

export function rowAt(lat: number): number {
  const clamped = Math.max(-90, Math.min(90, lat));
  const arc = meridianArc(clamped * DEG) + QUARTER_MERIDIAN_M;
  const row = Math.floor(arc / ROW_HEIGHT_M);
  return Math.max(0, Math.min(ROW_COUNT - 1, row));
}

function colAt(row: number, lon: number): number {
  const n = colsInRow(row);
  const x = (((lon + 180) % 360) + 360) % 360;
  return Math.min(n - 1, Math.floor((x / 360) * n));
}

/** The cell containing a WGS84 point. */
export function cellAt(lat: number, lon: number): CellId {
  const row = rowAt(lat);
  return cellId(row, colAt(row, lon));
}

/** Latitude (degrees) of the southern edge of a row. `row = ROW_COUNT` gives 90. */
export function rowSouthLat(row: number): number {
  if (row <= 0) return -90;
  if (row >= ROW_COUNT) return 90;
  return latFromMeridianArc(row * ROW_HEIGHT_M - QUARTER_MERIDIAN_M) / DEG;
}

export interface CellBounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export function cellBounds(id: CellId): CellBounds {
  const row = cellRow(id);
  const col = cellCol(id);
  const n = colsInRow(row);
  return {
    south: rowSouthLat(row),
    north: rowSouthLat(row + 1),
    west: -180 + (col * 360) / n,
    east: -180 + ((col + 1) * 360) / n,
  };
}

export function cellCenter(id: CellId): LatLon {
  const row = cellRow(id);
  const col = cellCol(id);
  const n = colsInRow(row);
  const lat = latFromMeridianArc((row + 0.5) * ROW_HEIGHT_M - QUARTER_MERIDIAN_M) / DEG;
  return { lat, lon: normalizeLon(-180 + ((col + 0.5) * 360) / n) };
}

/** Closed polygon ring [lon, lat][] (counter-clockwise) for rendering. */
export function cellRing(id: CellId): [number, number][] {
  const b = cellBounds(id);
  return [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [b.west, b.south],
  ];
}

/** Real east–west width of the cells in a row, measured at the row centre. */
export function cellWidthM(row: number): number {
  const lat = latFromMeridianArc((row + 0.5) * ROW_HEIGHT_M - QUARTER_MERIDIAN_M);
  return parallelCircumference(lat) / colsInRow(row);
}

export const CELL_HEIGHT_M = ROW_HEIGHT_M;

/**
 * Columns of row `toRow` (with n2 columns) whose span overlaps column `col` of a
 * row with n1 columns by a positive length. Pure integer arithmetic: touching at
 * a single point (a corner) does not count.
 */
function overlappingCols(col: number, n1: number, n2: number): [number, number] {
  if (n1 === n2) return [col, col];
  const lo = Math.floor((col * n2) / n1);
  const hi = Math.floor(((col + 1) * n2 - 1) / n1);
  return [lo, hi];
}

/**
 * Cells sharing a side (or part of a side, across a band seam) with `id`.
 * Corner-only contact is never adjacency.
 */
export function neighbors(id: CellId): CellId[] {
  const row = cellRow(id);
  const col = cellCol(id);
  const n = colsInRow(row);
  const out: CellId[] = [];
  if (n > 1) {
    out.push(cellId(row, (col - 1 + n) % n));
    const east = cellId(row, (col + 1) % n);
    if (east !== out[0]) out.push(east);
  }
  for (const r2 of [row - 1, row + 1]) {
    if (r2 < 0 || r2 >= ROW_COUNT) continue;
    const n2 = colsInRow(r2);
    const [lo, hi] = overlappingCols(col, n, n2);
    for (let c = lo; c <= hi; c++) out.push(cellId(r2, c));
  }
  return out;
}

export function areAdjacent(a: CellId, b: CellId): boolean {
  return neighbors(a).includes(b);
}

/** Groups cells into side-connected components. Components and members are sorted ascending. */
export function connectedComponents(ids: Iterable<CellId>): CellId[][] {
  const set = new Set(ids);
  const seen = new Set<CellId>();
  const comps: CellId[][] = [];
  for (const start of [...set].sort((x, y) => x - y)) {
    if (seen.has(start)) continue;
    const comp: CellId[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.pop()!;
      comp.push(cur);
      for (const nb of neighbors(cur)) {
        if (set.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    comps.push(comp.sort((x, y) => x - y));
  }
  return comps;
}

export function isConnected(ids: Iterable<CellId>): boolean {
  const arr = [...new Set(ids)];
  if (arr.length === 0) return false;
  return connectedComponents(arr).length === 1;
}

/**
 * Largest connected component; ties go to the component holding the smallest
 * cell id. Used when some drone targets were taken in flight.
 */
export function largestComponent(ids: Iterable<CellId>): CellId[] {
  let best: CellId[] = [];
  for (const comp of connectedComponents(ids)) {
    if (comp.length > best.length) best = comp;
  }
  return best;
}

export interface IdRange {
  lo: CellId;
  hi: CellId;
}

/**
 * Cell-id ranges covering a bbox. Within a row ids are contiguous, so each row
 * contributes one range (two if the bbox crosses the antimeridian). Returns
 * null when the bbox spans more than `maxRows` rows.
 */
export function bboxToIdRanges(bbox: BBox, maxRows = 2000): IdRange[] | null {
  const r0 = rowAt(bbox.south);
  const r1 = rowAt(bbox.north);
  if (r1 - r0 + 1 > maxRows) return null;
  const spans: [number, number][] =
    bbox.west <= bbox.east ? [[bbox.west, bbox.east]] : [[bbox.west, 180], [-180, bbox.east]];
  const out: IdRange[] = [];
  for (let r = r0; r <= r1; r++) {
    const n = colsInRow(r);
    for (const [w, e] of spans) {
      if (e - w >= 360) {
        out.push({ lo: cellId(r, 0), hi: cellId(r, n - 1) });
        continue;
      }
      const c0 = colAt(r, w);
      const c1 = e >= 180 ? n - 1 : colAt(r, e);
      if (c0 <= c1) out.push({ lo: cellId(r, c0), hi: cellId(r, c1) });
      else {
        out.push({ lo: cellId(r, c0), hi: cellId(r, n - 1) });
        out.push({ lo: cellId(r, 0), hi: cellId(r, c1) });
      }
    }
  }
  return out;
}

/** All cells in a bbox, or null if there would be more than `maxCells`. */
export function cellsInBBox(bbox: BBox, maxCells = 20000): CellId[] | null {
  const ranges = bboxToIdRanges(bbox, maxCells);
  if (!ranges) return null;
  let total = 0;
  for (const r of ranges) total += r.hi - r.lo + 1;
  if (total > maxCells) return null;
  const out: CellId[] = [];
  for (const r of ranges) for (let id = r.lo; id <= r.hi; id++) out.push(id);
  return out;
}

/** Coarse 0.1° zone used for map aggregation and exploration rewards. */
export interface Zone {
  zlat: number;
  zlon: number;
}

export const ZONE_DEG = 0.1;
export const ZONE_LAT_COUNT = 1800;
export const ZONE_LON_COUNT = 3600;

export function zoneOf(p: LatLon): Zone {
  const zlat = Math.min(ZONE_LAT_COUNT - 1, Math.max(0, Math.floor((p.lat + 90) / ZONE_DEG)));
  const x = (((p.lon + 180) % 360) + 360) % 360;
  const zlon = Math.min(ZONE_LON_COUNT - 1, Math.floor(x / ZONE_DEG));
  return { zlat, zlon };
}

export function zoneOfCell(id: CellId): Zone {
  return zoneOf(cellCenter(id));
}

export function zoneKey(z: Zone): number {
  return z.zlat * ZONE_LON_COUNT + z.zlon;
}
