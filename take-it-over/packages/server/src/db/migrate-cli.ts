import { loadConfig } from '../config';
import { migrate } from './migrate';
import { createPool } from './pool';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
try {
  const applied = await migrate(pool, console.log);
  console.log(applied.length ? `done (${applied.length} applied)` : 'database is up to date');
} finally {
  await pool.end();
}
