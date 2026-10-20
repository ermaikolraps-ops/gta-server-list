import { DEFAULT_PARAMS, type GameParams, mergeParams } from '@tio/shared';
import { readFileSync } from 'node:fs';
import { buildApp } from './app';
import { systemClock } from './clock';
import { loadConfig } from './config';
import type { GameContext } from './context';
import { migrate } from './db/migrate';
import { createPool } from './db/pool';
import { EventBus } from './events';
import { PermissiveLandMask, PostgisLandMask } from './land';
import { createServices } from './services';

const config = loadConfig();
const pool = createPool(config.databaseUrl, 20);

let params: GameParams = DEFAULT_PARAMS;
if (config.paramsFile) params = mergeParams(DEFAULT_PARAMS, JSON.parse(readFileSync(config.paramsFile, 'utf8')));

await migrate(pool, (m) => console.log(m));

let land;
if (config.landMask === 'permissive') {
  console.warn('WARNING: TIO_LAND_MASK=permissive — every point counts as land. Development only.');
  land = new PermissiveLandMask();
} else {
  land = new PostgisLandMask(pool);
  if (!(await land.isLoaded())) {
    console.error(
      'No land polygons loaded. Run `pnpm land:fetch && pnpm land:load`, or set TIO_LAND_MASK=permissive for local development.',
    );
    process.exit(1);
  }
}

const events = new EventBus();
const placeholderLog = { info: console.log, warn: console.warn, error: console.error };
const ctx: GameContext = {
  pool,
  clock: systemClock,
  params,
  land,
  events,
  log: placeholderLog,
  sessionTtlMs: config.sessionTtlDays * 86400_000,
};
const services = createServices(ctx);
const app = await buildApp(ctx, services, config);
ctx.log = app.log;
services.start(config.schedulerIntervalMs);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  services.stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
