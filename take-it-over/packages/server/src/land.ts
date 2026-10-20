import { type CellId, cellCenter, type LatLon } from '@tio/shared';
import type { Pool } from './db/pool';

/**
 * Decides what is conquerable land. A cell counts as land when its centre is
 * inside a land polygon and outside every inland-water polygon. Results per
 * cell are cached in memory (land never changes).
 */
export interface LandMask {
  readonly kind: string;
  pointsOnLand(points: LatLon[]): Promise<boolean[]>;
  cellsOnLand(cells: CellId[]): Promise<Map<CellId, boolean>>;
}

class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

const CHUNK = 5000;

export class PostgisLandMask implements LandMask {
  readonly kind = 'postgis';
  private cache: Lru<CellId, boolean>;

  constructor(
    private readonly pool: Pool,
    cacheSize = 500_000,
  ) {
    this.cache = new Lru(cacheSize);
  }

  async pointsOnLand(points: LatLon[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let i = 0; i < points.length; i += CHUNK) {
      const chunk = points.slice(i, i + CHUNK);
      const res = await this.pool.query<{ land: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM land_polygons l WHERE ST_Intersects(l.geom, t.pt))
                AND NOT EXISTS (SELECT 1 FROM water_polygons w WHERE ST_Intersects(w.geom, t.pt)) AS land
           FROM (SELECT i, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS pt
                   FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS u(lon, lat, i)) t
          ORDER BY t.i`,
        [chunk.map((p) => p.lon), chunk.map((p) => p.lat)],
      );
      for (const r of res.rows) out.push(r.land);
    }
    return out;
  }

  async cellsOnLand(cells: CellId[]): Promise<Map<CellId, boolean>> {
    const out = new Map<CellId, boolean>();
    const missing: CellId[] = [];
    for (const c of new Set(cells)) {
      const v = this.cache.get(c);
      if (v === undefined) missing.push(c);
      else out.set(c, v);
    }
    if (missing.length) {
      const flags = await this.pointsOnLand(missing.map(cellCenter));
      missing.forEach((c, i) => {
        this.cache.set(c, flags[i]!);
        out.set(c, flags[i]!);
      });
    }
    return out;
  }

  async isLoaded(): Promise<boolean> {
    const r = await this.pool.query('SELECT 1 FROM land_polygons LIMIT 1');
    return (r.rowCount ?? 0) > 0;
  }
}

/** Development fallback: the whole planet is land. Never use in production. */
export class PermissiveLandMask implements LandMask {
  readonly kind = 'permissive';
  async pointsOnLand(points: LatLon[]): Promise<boolean[]> {
    return points.map(() => true);
  }
  async cellsOnLand(cells: CellId[]): Promise<Map<CellId, boolean>> {
    return new Map(cells.map((c) => [c, true]));
  }
}
