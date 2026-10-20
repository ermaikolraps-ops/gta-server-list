import { migrate } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { boxWkt, WORLD } from './world';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://tio:tio@localhost:5432/takeitover_test';

/** Rebuilds the test database from scratch once per test run. */
export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DB, 2);
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
    for (const b of [WORLD.mainland, WORLD.island, WORLD.far]) {
      await pool.query(`INSERT INTO land_polygons (source, geom) VALUES ('test', ST_GeomFromText($1, 4326))`, [boxWkt(b)]);
    }
    await pool.query(`INSERT INTO water_polygons (source, geom) VALUES ('test', ST_GeomFromText($1, 4326))`, [
      boxWkt(WORLD.lake),
    ]);
  } finally {
    await pool.end();
  }
}
