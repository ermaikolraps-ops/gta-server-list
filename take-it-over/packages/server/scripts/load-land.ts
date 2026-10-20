/**
 * Loads land and inland-water polygons into PostGIS, subdivided for fast
 * point-in-polygon lookups.
 *
 *   pnpm land:load                      # Natural Earth files from data/
 *   pnpm land:load --land a.geojson --water b.geojson --source osm
 *
 * Replaces previously loaded polygons. GeoJSON must be a FeatureCollection in
 * WGS84. Cell land status is cached in memory by the server, so restart it
 * after reloading.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { createPool, withTx } from '../src/db/pool';

const dataDir = fileURLToPath(new URL('../../../data/', import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
};
const landFile = arg('land', dataDir + 'ne_10m_land.geojson');
const waterFile = arg('water', dataDir + 'ne_10m_lakes.geojson');
const source = arg('source', 'naturalearth-10m');

interface FC {
  features: { geometry: unknown }[];
}

const pool = createPool(loadConfig().databaseUrl, 2);
try {
  await migrate(pool, console.log);
  await withTx(pool, async (tx) => {
    for (const [table, file] of [
      ['land_polygons', landFile],
      ['water_polygons', waterFile],
    ] as const) {
      const fc = JSON.parse(readFileSync(file, 'utf8')) as FC;
      await tx.query(`DELETE FROM ${table}`);
      let n = 0;
      for (const f of fc.features) {
        if (!f.geometry) continue;
        const res = await tx.query(
          `INSERT INTO ${table} (source, geom)
           SELECT $1, d.geom FROM (
             SELECT (ST_Dump(ST_Subdivide(
               ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)), 3), 256))).geom
           ) d
           WHERE GeometryType(d.geom) = 'POLYGON'`,
          [source, JSON.stringify(f.geometry)],
        );
        n += res.rowCount ?? 0;
      }
      console.log(`${table}: ${fc.features.length} features → ${n} subdivided polygons from ${file}`);
    }
  });
  await pool.query('ANALYZE land_polygons; ANALYZE water_polygons;');
} finally {
  await pool.end();
}
