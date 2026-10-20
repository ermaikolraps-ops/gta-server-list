/**
 * Edge-case validation of the 100 m world grid: real cell size, side-only
 * adjacency checked against an independent geometric oracle, every band seam
 * in both hemispheres, both polar caps and the antimeridian.
 */
import { describe, expect, it } from 'vitest';
import {
  BAND_START_D,
  cellAt,
  cellBounds,
  cellCenter,
  cellCol,
  cellId,
  cellRow,
  cellsInBBox,
  COL_FACTOR,
  colsInRow,
  connectedComponents,
  DEG,
  distanceM,
  isConnected,
  isValidCellId,
  meridianArc,
  MID_ROW,
  neighbors,
  ROW_COUNT,
  ROW_HEIGHT_M,
  rowSouthLat,
} from '../src';
import { testRng } from './rng';

const rnd = testRng(2026);
const TOP = ROW_COUNT - 1;

/** Rows on both sides of every band seam: [equatorward row, poleward row]. */
function seams(): [number, number][] {
  const out: [number, number][] = [];
  for (const d of BAND_START_D.slice(1)) {
    out.push([MID_ROW + d - 1, MID_ROW + d]); // north
    out.push([MID_ROW - d + 1, MID_ROW - d]); // south
  }
  return out;
}

/** Longitude overlap (degrees) of two cells' spans; cells never straddle ±180. */
function lonOverlap(a: number, b: number): number {
  const A = cellBounds(a);
  const B = cellBounds(b);
  return Math.min(A.east, B.east) - Math.max(A.west, B.west);
}

/**
 * Independent oracle for side adjacency, from cell bounds only:
 * - same row: the east edge of one is the west edge of the other (mod 360);
 * - adjacent rows: their longitude spans overlap by a positive length.
 * Corner-only contact (overlap ≈ 0) is never adjacency.
 */
function oracleAdjacent(a: number, b: number): boolean {
  if (a === b) return false;
  const ra = cellRow(a);
  const rb = cellRow(b);
  if (ra === rb) {
    const n = colsInRow(ra);
    if (n < 2) return false;
    const A = cellBounds(a);
    const B = cellBounds(b);
    const touch = (x: number, y: number) => Math.abs((((x - y) % 360) + 540) % 360 - 180) < 1e-9;
    return touch(A.east, B.west) || touch(B.east, A.west);
  }
  if (Math.abs(ra - rb) !== 1) return false;
  return lonOverlap(a, b) > 1e-9;
}

/** Candidates near a cell (same and adjacent rows, a window of columns) for the oracle. */
function candidates(id: number): number[] {
  const r = cellRow(id);
  const c = cellCol(id);
  const n = colsInRow(r);
  const out: number[] = [];
  for (const r2 of [r - 1, r, r + 1]) {
    if (r2 < 0 || r2 >= ROW_COUNT) continue;
    const n2 = colsInRow(r2);
    const center = Math.floor(((c + 0.5) / n) * n2);
    for (let k = -3; k <= 3; k++) out.push(cellId(r2, (((center + k) % n2) + n2) % n2));
    out.push(cellId(r2, 0), cellId(r2, n2 - 1));
  }
  return [...new Set(out)];
}

function expectMatchesOracle(id: number): void {
  const nb = neighbors(id);
  expect(new Set(nb).size).toBe(nb.length); // no duplicates
  expect(nb).not.toContain(id);
  for (const cand of candidates(id)) {
    expect(nb.includes(cand), `cell ${id} vs ${cand}`).toBe(oracleAdjacent(id, cand));
  }
  for (const x of nb) expect(neighbors(x)).toContain(id); // symmetric
}

/** Sum of the longitude overlaps with the neighbours in row `r2` equals the cell's own width. */
function sideCoverage(id: number, r2: number): number {
  return neighbors(id)
    .filter((x) => cellRow(x) === r2)
    .reduce((s, x) => s + lonOverlap(id, x), 0);
}

describe('cell size is ~100 × 100 m', () => {
  it('every row is 100 m of true meridian arc', () => {
    for (let r = 0; r < ROW_COUNT; r += 997) {
      const h = meridianArc(rowSouthLat(r + 1) * DEG) - meridianArc(rowSouthLat(r) * DEG);
      expect(Math.abs(h - ROW_HEIGHT_M)).toBeLessThan(1e-4);
    }
    expect(Math.abs(ROW_HEIGHT_M - 100)).toBeLessThan(0.001);
  });

  it('neighbouring cell centres are ~100 m apart on the ground in every direction', () => {
    for (let i = 0; i < 3000; i++) {
      const id = cellAt(rnd() * 178 - 89, rnd() * 360 - 180);
      const c = cellCenter(id);
      for (const nb of neighbors(id)) {
        const d = distanceM(c, cellCenter(nb));
        if (cellRow(nb) === cellRow(id)) expect(Math.abs(d - 100)).toBeLessThan(1.6);
        else if (lonOverlap(id, nb) > 0.9 * (cellBounds(id).east - cellBounds(id).west)) {
          // straight above/below (not an offset neighbour across a seam)
          expect(Math.abs(d - 100)).toBeLessThan(1.6);
        }
      }
    }
  });

  it('tiles each row exactly: column spans add up to 360°', () => {
    for (const r of [0, 1, 7, MID_ROW - 1, MID_ROW, MID_ROW + 1, ROW_COUNT - 8, TOP]) {
      const n = colsInRow(r);
      expect(cellBounds(cellId(r, 0)).west).toBe(-180);
      expect(cellBounds(cellId(r, n - 1)).east).toBe(180);
      for (let c = 1; c < Math.min(n, 50); c++) {
        expect(cellBounds(cellId(r, c)).west).toBeCloseTo(cellBounds(cellId(r, c - 1)).east, 12);
      }
    }
  });

  it('fits every id in a JavaScript number and a Postgres BIGINT', () => {
    const maxId = cellId(TOP, colsInRow(TOP) - 1);
    expect(Number.isSafeInteger(cellId(MID_ROW, colsInRow(MID_ROW) - 1))).toBe(true);
    expect(maxId).toBeLessThan(2 ** 53);
    for (let r = 0; r < ROW_COUNT; r += 1013) expect(colsInRow(r)).toBeLessThan(COL_FACTOR);
    for (const id of [cellId(0, 0), cellId(TOP, 0), cellId(MID_ROW, colsInRow(MID_ROW) - 1)]) {
      expect(isValidCellId(id)).toBe(true);
      expect(cellId(cellRow(id), cellCol(id))).toBe(id);
    }
  });
});

describe('side adjacency agrees with an independent geometric oracle', () => {
  it('for random cells all over the world', () => {
    for (let i = 0; i < 2000; i++) expectMatchesOracle(cellAt(rnd() * 179.9 - 89.95, rnd() * 360 - 180));
  });

  it('gives interior cells exactly four neighbours, one per side', () => {
    for (let i = 0; i < 500; i++) {
      const r = MID_ROW + Math.floor(rnd() * 12000) - 6000; // well inside the equatorial band
      const n = colsInRow(r);
      const c = 1 + Math.floor(rnd() * (n - 2));
      const nb = neighbors(cellId(r, c)).sort((a, b) => a - b);
      expect(nb).toEqual([cellId(r - 1, c), cellId(r, c - 1), cellId(r, c + 1), cellId(r + 1, c)].sort((a, b) => a - b));
    }
  });

  it('never links diagonal (corner-only) cells, anywhere', () => {
    for (let i = 0; i < 1000; i++) {
      const id = cellAt(rnd() * 170 - 85, rnd() * 360 - 180);
      const r = cellRow(id);
      const c = cellCol(id);
      if (colsInRow(r + 1) !== colsInRow(r)) continue; // seams are covered separately
      const n = colsInRow(r);
      for (const dc of [-1, 1]) {
        const diag = cellId(r + 1, (c + dc + n) % n);
        expect(neighbors(id)).not.toContain(diag);
        expect(isConnected([id, diag])).toBe(false);
      }
    }
  });
});

describe('every band seam (both hemispheres)', () => {
  const all = seams();

  it('has a seam at each band edge, with different column counts on each side', () => {
    expect(all.length).toBe(2 * (BAND_START_D.length - 1));
    for (const [r1, r2] of all) expect(colsInRow(r1)).not.toBe(colsInRow(r2));
  });

  it('links each seam cell to 1–2 cells across, covering its whole side with no gaps or overlaps', () => {
    for (const [r1, r2] of all) {
      const n1 = colsInRow(r1);
      const cols = new Set([0, 1, n1 - 2, n1 - 1, Math.floor(n1 / 2)]);
      for (let k = 0; k < 20; k++) cols.add(Math.floor(rnd() * n1));
      for (const c of cols) {
        if (c < 0 || c >= n1) continue;
        const id = cellId(r1, c);
        const across = neighbors(id).filter((x) => cellRow(x) === r2);
        expect(across.length).toBeGreaterThanOrEqual(1);
        expect(across.length).toBeLessThanOrEqual(2);
        const width = cellBounds(id).east - cellBounds(id).west;
        expect(sideCoverage(id, r2)).toBeCloseTo(width, 9);
      }
    }
  });

  it('matches the oracle on both sides of every seam', () => {
    for (const [r1, r2] of all) {
      for (const r of [r1, r2]) {
        const n = colsInRow(r);
        for (const c of [0, n - 1, Math.floor(rnd() * n), Math.floor(rnd() * n)]) expectMatchesOracle(cellId(r, c));
      }
    }
  });

  it('treats the corner where seam columns line up as corner-only contact', () => {
    for (const [r1, r2] of all) {
      const n1 = colsInRow(r1);
      const n2 = colsInRow(r2);
      // At −180/+180 both rows' edges line up: (r1, last) and (r2, first) touch at one point only.
      expect(neighbors(cellId(r1, n1 - 1))).not.toContain(cellId(r2, 0));
      expect(neighbors(cellId(r1, 0))).not.toContain(cellId(r2, n2 - 1));
      // …while the cells really above each other are linked.
      expect(neighbors(cellId(r1, 0))).toContain(cellId(r2, 0));
      expect(neighbors(cellId(r1, n1 - 1))).toContain(cellId(r2, n2 - 1));
    }
  });

  it('finds interior aligned corners exactly (integer maths, no float slop)', () => {
    let checked = 0;
    for (const [r1, r2] of all) {
      const n1 = colsInRow(r1);
      const n2 = colsInRow(r2);
      // columns c where c/n1 == c'/n2 exactly: edges line up, so (c-1, r1) and (c', r2) meet at a corner
      const g = gcd(n1, n2);
      if (g < 2) continue;
      const c = n1 / g;
      const cUp = n2 / g;
      expect(neighbors(cellId(r1, c - 1))).not.toContain(cellId(r2, cUp));
      expect(neighbors(cellId(r1, c))).not.toContain(cellId(r2, cUp - 1));
      expect(neighbors(cellId(r1, c))).toContain(cellId(r2, cUp));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('poles', () => {
  it('maps the poles and near-pole points into the polar rows', () => {
    expect(cellRow(cellAt(90, 0))).toBe(TOP);
    expect(cellRow(cellAt(-90, 123))).toBe(0);
    expect(cellBounds(cellAt(90, 0)).north).toBe(90);
    expect(cellBounds(cellAt(-90, 0)).south).toBe(-90);
    for (let i = 0; i < 500; i++) {
      const lat = (rnd() < 0.5 ? -1 : 1) * (89.99 + rnd() * 0.01);
      const lon = rnd() * 360 - 180;
      const b = cellBounds(cellAt(lat, lon));
      expect(lat).toBeGreaterThanOrEqual(b.south - 1e-12);
      expect(lat).toBeLessThanOrEqual(b.north + 1e-12);
      expect(lon).toBeGreaterThanOrEqual(b.west - 1e-9);
      expect(lon).toBeLessThanOrEqual(b.east + 1e-9);
    }
  });

  it('has no neighbours beyond the pole and keeps polar rings connected', () => {
    for (const [row, beyond] of [
      [TOP, TOP + 1],
      [0, -1],
    ] as const) {
      const n = colsInRow(row);
      expect(n).toBeGreaterThanOrEqual(1);
      const ring: number[] = [];
      for (let c = 0; c < n; c++) {
        const id = cellId(row, c);
        ring.push(id);
        expect(neighbors(id).some((x) => cellRow(x) === beyond)).toBe(false);
      }
      expect(isConnected(ring)).toBe(true);
    }
  });

  it('matches the oracle and stays symmetric across the polar caps', () => {
    for (const row of [0, 1, 2, 3, 10, 49, 50, TOP - 50, TOP - 49, TOP - 10, TOP - 3, TOP - 2, TOP - 1, TOP]) {
      const n = colsInRow(row);
      const cols = n <= 400 ? [...Array(n).keys()] : [0, n - 1, Math.floor(n / 3), Math.floor((2 * n) / 3)];
      for (const c of cols) expectMatchesOracle(cellId(row, c));
    }
  });

  it('covers each polar row exactly once (column widths add up to 360°)', () => {
    for (const row of [0, 1, 2, TOP - 2, TOP - 1, TOP]) {
      const n = colsInRow(row);
      let sum = 0;
      for (let c = 0; c < n; c++) {
        const b = cellBounds(cellId(row, c));
        sum += b.east - b.west;
      }
      expect(sum).toBeCloseTo(360, 9);
    }
  });

  it('is symmetric between the North and South Pole', () => {
    for (let k = 0; k < 60; k++) {
      expect(colsInRow(TOP - k)).toBe(colsInRow(k));
      expect(rowSouthLat(TOP - k + 1)).toBeCloseTo(-rowSouthLat(k), 9);
    }
  });

  it('answers bbox queries at the poles', () => {
    const north = cellsInBBox({ west: -180, south: 89.999, east: 180, north: 90 }, 5000);
    expect(north).not.toBeNull();
    expect(north).toContain(cellAt(89.9995, 10));
  });
});

describe('antimeridian', () => {
  const sampleRows = () => {
    const rows: number[] = [];
    for (const d of BAND_START_D) rows.push(MID_ROW + d, MID_ROW - d);
    return rows;
  };

  it('starts every row at −180° and ends it at +180°, in every band', () => {
    for (const r of sampleRows()) {
      const n = colsInRow(r);
      expect(cellBounds(cellId(r, 0)).west).toBe(-180);
      expect(cellBounds(cellId(r, n - 1)).east).toBe(180);
    }
  });

  it('links the first and last cell of every row (n > 2)', () => {
    for (const r of sampleRows()) {
      const n = colsInRow(r);
      if (n < 3) continue;
      expect(neighbors(cellId(r, 0))).toContain(cellId(r, n - 1));
      expect(neighbors(cellId(r, n - 1))).toContain(cellId(r, 0));
    }
  });

  it('maps ±180° and out-of-range longitudes consistently', () => {
    for (const lat of [-89.9, -60, -16.8, 0, 0.0001, 35, 64.1, 89.9]) {
      const r = cellRow(cellAt(lat, 0));
      const n = colsInRow(r);
      expect(cellAt(lat, 180)).toBe(cellAt(lat, -180));
      expect(cellCol(cellAt(lat, -180))).toBe(0);
      expect(cellCol(cellAt(lat, 180 - 1e-9))).toBe(n - 1);
      expect(cellAt(lat, 190)).toBe(cellAt(lat, -170));
      expect(cellAt(lat, -190)).toBe(cellAt(lat, 170));
      expect(cellAt(lat, 540)).toBe(cellAt(lat, 180));
    }
  });

  it('keeps a block of parcels straddling the antimeridian connected', () => {
    const r = cellRow(cellAt(-16.8, 179.9999)); // Fiji
    const n = colsInRow(r);
    const block: number[] = [];
    for (const dr of [0, 1]) for (const c of [n - 2, n - 1, 0, 1]) block.push(cellId(r + dr, c));
    expect(isConnected(block)).toBe(true);
    expect(connectedComponents([cellId(r, n - 1), cellId(r, 0)])).toHaveLength(1);
    expect(isConnected([cellId(r, n - 2), cellId(r, 1)])).toBe(false);
  });

  it('agrees with the oracle at the antimeridian on every seam', () => {
    for (const [r1, r2] of seams()) {
      for (const r of [r1, r2]) {
        const n = colsInRow(r);
        expectMatchesOracle(cellId(r, 0));
        expectMatchesOracle(cellId(r, n - 1));
      }
    }
  });

  it('splits antimeridian bboxes into both sides with no cell lost or duplicated', () => {
    const lat0 = -16.81;
    const lat1 = -16.8;
    const across = cellsInBBox({ west: 179.995, south: lat0, east: -179.995, north: lat1 })!;
    const east = cellsInBBox({ west: 179.995, south: lat0, east: 180, north: lat1 })!;
    const west = cellsInBBox({ west: -180, south: lat0, east: -179.995, north: lat1 })!;
    expect(new Set(across).size).toBe(across.length);
    expect(new Set(across)).toEqual(new Set([...east, ...west]));
  });
});

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
