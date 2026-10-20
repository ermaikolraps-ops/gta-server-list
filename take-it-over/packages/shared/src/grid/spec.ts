import { latFromMeridianArc, parallelCircumference, QUARTER_MERIDIAN_M } from '../geo/wgs84';

/**
 * World grid v1 — see docs/decisions/0002-world-grid.md.
 *
 * - Rows are bands of equal *meridian arc* (~100 m) from pole to pole.
 *   The row count is odd so that the middle row is centred on the equator and
 *   both hemispheres are mirror images.
 * - Rows are grouped into latitude bands. Every row in a band has the same
 *   number of columns, so cells line up perfectly inside a band and the grid
 *   only has a seam at band edges.
 * - Bands are chosen greedily from the equator so that every cell's real width
 *   stays within ±WIDTH_TOLERANCE of TARGET_CELL_M (except in the polar caps,
 *   where a parallel is shorter than a few cells and widths degrade).
 */

export const GRID_VERSION = 1;
export const TARGET_CELL_M = 100;
export const WIDTH_TOLERANCE = 0.01;

export const MERIDIAN_LENGTH_M = 2 * QUARTER_MERIDIAN_M;
export const ROW_COUNT = Math.round(MERIDIAN_LENGTH_M / TARGET_CELL_M);
export const ROW_HEIGHT_M = MERIDIAN_LENGTH_M / ROW_COUNT;
export const MID_ROW = (ROW_COUNT - 1) / 2;
/** Largest distance (in rows) from the equator row: the polar cap rows. */
export const MAX_ROW_DISTANCE = MID_ROW;

/** Bits reserved for the column in a cell id: 2^19 = 524,288 > max columns (~400,750). */
export const COL_BITS = 19;
export const COL_FACTOR = 2 ** COL_BITS;

/** Circumference of the parallel through the centre of a row `d` rows from the equator. */
export function rowCenterCircumference(d: number): number {
  return parallelCircumference(latFromMeridianArc(d * ROW_HEIGHT_M));
}

export interface Band {
  /** First row distance from the equator row (inclusive). */
  startD: number;
  /** Columns in every row of this band. */
  cols: number;
}

/** Deterministically builds the band table. Frozen output lives in bandTable.generated.ts. */
export function buildBandTable(tolerance = WIDTH_TOLERANCE, target = TARGET_CELL_M): Band[] {
  const ratioLimit = (1 + tolerance) / (1 - tolerance);
  const bands: Band[] = [];
  let d = 0;
  while (d <= MAX_ROW_DISTANCE) {
    const start = d;
    const cStart = rowCenterCircumference(start);
    let end = start;
    while (end + 1 <= MAX_ROW_DISTANCE && cStart / rowCenterCircumference(end + 1) <= ratioLimit) end++;
    const cEnd = rowCenterCircumference(end);
    const cols = Math.max(1, Math.round(Math.sqrt(cStart * cEnd) / target));
    bands.push({ startD: start, cols });
    d = end + 1;
  }
  return bands;
}
