import { describe, expect, it } from 'vitest';
import {
  areAdjacent,
  BAND_COLS,
  BAND_START_D,
  bandOfRow,
  bboxToIdRanges,
  buildBandTable,
  cellAt,
  cellBounds,
  cellCenter,
  cellCol,
  cellId,
  cellRow,
  cellsInBBox,
  cellWidthM,
  colsInRow,
  connectedComponents,
  isConnected,
  isValidCellId,
  largestComponent,
  MID_ROW,
  neighbors,
  ROW_COUNT,
  ROW_HEIGHT_M,
  rowAt,
  rowSouthLat,
} from '../src';
import { BAND_START_D as FROZEN_STARTS } from '../src/grid/bandTable.generated';
import { testRng } from './rng';

const rnd = testRng(42);
const randomCell = () => cellAt(rnd() * 179.8 - 89.9, rnd() * 360 - 180);

describe('grid layout', () => {
  it('has ~100 m rows and an odd row count centred on the equator', () => {
    expect(ROW_COUNT % 2).toBe(1);
    expect(Math.abs(ROW_HEIGHT_M - 100)).toBeLessThan(0.01);
    expect(rowAt(0)).toBe(MID_ROW);
    expect(rowSouthLat(MID_ROW)).toBeCloseTo(-rowSouthLat(MID_ROW + 1), 12);
  });

  it('frozen band table matches a fresh deterministic build', () => {
    const fresh = buildBandTable();
    expect(fresh.map((b) => b.startD)).toEqual([...FROZEN_STARTS]);
    expect(fresh.map((b) => b.cols)).toEqual([...BAND_COLS]);
  });

  it('keeps every cell within ±1% of 100 m wide below 89.5° latitude', () => {
    let checked = 0;
    for (let row = MID_ROW; row < ROW_COUNT; row++) {
      if (rowSouthLat(row + 1) > 89.5) break;
      const w = cellWidthM(row);
      expect(Math.abs(w - 100) / 100).toBeLessThanOrEqual(0.0101);
      checked++;
    }
    expect(checked).toBeGreaterThan(99000);
  });

  it('is symmetric between hemispheres', () => {
    for (const d of [0, 1, 5000, 50000, 90000, 100000]) {
      expect(colsInRow(MID_ROW + d)).toBe(colsInRow(MID_ROW - d));
      expect(rowSouthLat(MID_ROW + d + 1)).toBeCloseTo(-rowSouthLat(MID_ROW - d), 9);
    }
  });

  it('covers the Earth with ~5.1e10 cells', () => {
    let total = 0;
    for (let row = 0; row < ROW_COUNT; row++) total += colsInRow(row);
    const earthArea = 510065621.7e6; // WGS84 ellipsoid surface, m²
    expect(Math.abs(total * 1e4 - earthArea) / earthArea).toBeLessThan(0.005);
  });
});

describe('point ↔ cell', () => {
  it('maps a cell centre back to the same cell', () => {
    for (let i = 0; i < 5000; i++) {
      const id = randomCell();
      const c = cellCenter(id);
      expect(cellAt(c.lat, c.lon)).toBe(id);
      expect(isValidCellId(id)).toBe(true);
    }
  });

  it('puts every point inside the bounds of its cell', () => {
    for (let i = 0; i < 5000; i++) {
      const lat = rnd() * 180 - 90;
      const lon = rnd() * 360 - 180;
      const b = cellBounds(cellAt(lat, lon));
      expect(lat).toBeGreaterThanOrEqual(b.south - 1e-12);
      expect(lat).toBeLessThanOrEqual(b.north + 1e-12);
      expect(lon).toBeGreaterThanOrEqual(b.west - 1e-9);
      expect(lon).toBeLessThanOrEqual(b.east + 1e-9);
    }
  });

  it('handles poles, the antimeridian and out-of-range longitudes', () => {
    expect(cellRow(cellAt(90, 0))).toBe(ROW_COUNT - 1);
    expect(cellRow(cellAt(-90, 0))).toBe(0);
    const n = colsInRow(rowAt(10));
    expect(cellCol(cellAt(10, 180))).toBe(0); // 180 == -180
    expect(cellCol(cellAt(10, 179.99999999))).toBe(n - 1);
    expect(cellAt(10, 190)).toBe(cellAt(10, -170));
  });

  it('rejects malformed ids', () => {
    expect(isValidCellId(-1)).toBe(false);
    expect(isValidCellId(1.5)).toBe(false);
    expect(isValidCellId('5')).toBe(false);
    expect(isValidCellId(cellId(ROW_COUNT, 0))).toBe(false);
    expect(isValidCellId(cellId(MID_ROW, colsInRow(MID_ROW)))).toBe(false);
  });
});

describe('side adjacency', () => {
  it('is symmetric everywhere, including seams, antimeridian and poles', () => {
    const samples: number[] = [];
    for (let i = 0; i < 3000; i++) samples.push(randomCell());
    for (const startD of BAND_START_D.slice(1, 60)) {
      for (const row of [MID_ROW + startD, MID_ROW + startD - 1, MID_ROW - startD]) {
        const n = colsInRow(row);
        samples.push(cellId(row, 0), cellId(row, n - 1), cellId(row, Math.floor(n / 3)));
      }
    }
    for (const row of [0, 1, 2, ROW_COUNT - 3, ROW_COUNT - 2, ROW_COUNT - 1]) {
      for (let c = 0; c < colsInRow(row); c++) samples.push(cellId(row, c));
    }
    for (const id of samples) {
      for (const nb of neighbors(id)) {
        expect(neighbors(nb)).toContain(id);
        expect(nb).not.toBe(id);
      }
    }
  });

  it('gives interior cells exactly four side neighbours', () => {
    const row = MID_ROW + 100;
    expect(bandOfRow(row - 1)).toBe(bandOfRow(row + 1));
    const id = cellId(row, 12345);
    expect(neighbors(id).sort((a, b) => a - b)).toEqual(
      [cellId(row - 1, 12345), cellId(row, 12344), cellId(row, 12346), cellId(row + 1, 12345)].sort((a, b) => a - b),
    );
  });

  it('never treats corner contact as adjacency', () => {
    const row = MID_ROW + 100;
    const a = cellId(row, 500);
    const diag = cellId(row + 1, 501);
    expect(areAdjacent(a, diag)).toBe(false);
    expect(isConnected([a, diag])).toBe(false);
    expect(isConnected([a, diag, cellId(row, 501)])).toBe(true);
  });

  it('links cells across a band seam only where their edges overlap', () => {
    const seamRow = MID_ROW + BAND_START_D[1]!;
    const below = seamRow - 1;
    const n1 = colsInRow(below);
    const n2 = colsInRow(seamRow);
    expect(n1).not.toBe(n2);
    for (let i = 0; i < 500; i++) {
      const col = Math.floor(rnd() * n1);
      const id = cellId(below, col);
      const b = cellBounds(id);
      const up = neighbors(id).filter((x) => cellRow(x) === seamRow);
      expect(up.length).toBeGreaterThanOrEqual(1);
      expect(up.length).toBeLessThanOrEqual(2);
      for (const u of up) {
        const ub = cellBounds(u);
        const overlap = Math.min(b.east, ub.east) - Math.max(b.west, ub.west);
        expect(overlap).toBeGreaterThan(0);
      }
      // the cells just outside the found range touch at most at a corner
      const cols = up.map(cellCol);
      for (const c of [Math.min(...cols) - 1, Math.max(...cols) + 1]) {
        if (c < 0 || c >= n2) continue;
        const ob = cellBounds(cellId(seamRow, c));
        expect(Math.min(b.east, ob.east) - Math.max(b.west, ob.west)).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('wraps around the antimeridian', () => {
    const row = MID_ROW + 2000;
    const n = colsInRow(row);
    expect(areAdjacent(cellId(row, 0), cellId(row, n - 1))).toBe(true);
  });
});

describe('connectivity', () => {
  const row = MID_ROW + 300;
  const c = (dr: number, dc: number) => cellId(row + dr, 1000 + dc);

  it('splits a set into side-connected components', () => {
    const comps = connectedComponents([c(0, 0), c(0, 1), c(1, 1), c(5, 5), c(6, 6)]);
    expect(comps.map((x) => x.length).sort()).toEqual([1, 1, 3]);
  });

  it('picks the largest component, breaking ties by the smallest id', () => {
    expect(largestComponent([c(0, 0), c(0, 1), c(3, 3), c(3, 4)])).toEqual([c(0, 0), c(0, 1)]);
    expect(largestComponent([c(0, 0), c(3, 3), c(3, 4), c(3, 5)])).toEqual([c(3, 3), c(3, 4), c(3, 5)]);
  });

  it('treats the empty set as not connected', () => {
    expect(isConnected([])).toBe(false);
  });
});

describe('bbox queries', () => {
  it('covers exactly the cells of a bbox', () => {
    const bbox = { west: 2.29, south: 48.85, east: 2.3, north: 48.86 };
    const cells = cellsInBBox(bbox)!;
    expect(cells.length).toBeGreaterThan(50);
    expect(cells).toContain(cellAt(48.855, 2.295));
    const ranges = bboxToIdRanges(bbox)!;
    expect(ranges.reduce((s, r) => s + r.hi - r.lo + 1, 0)).toBe(cells.length);
  });

  it('splits bboxes that cross the antimeridian', () => {
    const cells = cellsInBBox({ west: 179.999, south: -16.8, east: -179.999, north: -16.799 })!;
    expect(cells).toContain(cellAt(-16.7995, 179.9995));
    expect(cells).toContain(cellAt(-16.7995, -179.9995));
  });

  it('refuses huge bboxes', () => {
    expect(cellsInBBox({ west: -10, south: 40, east: 10, north: 50 })).toBeNull();
  });
});
