import { DEFAULT_PARAMS, type GameParams } from '@tio/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { type Config, loadConfig } from '../src/config';
import type { GameContext } from '../src/context';
import { createPool, type Pool } from '../src/db/pool';
import { EventBus, type PlayerEvent } from '../src/events';
import { PostgisLandMask } from '../src/land';
import { createServices, type Services } from '../src/services';
import { TEST_DB } from './global-setup';

export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const GAME_TABLES = [
  'players',
  'sessions',
  'parcels',
  'ledger',
  'idempotency_keys',
  'gps_anomalies',
  'explored_zones',
  'drones',
  'alliances',
];

export async function resetGameTables(pool: Pool): Promise<void> {
  const existing = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND tablename NOT IN ('schema_migrations', 'land_polygons', 'water_polygons', 'spatial_ref_sys')`,
  );
  const names = existing.rows.map((r) => r.tablename);
  for (const t of GAME_TABLES) if (!names.includes(t)) throw new Error(`missing table ${t}`);
  await pool.query(`TRUNCATE ${names.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface Harness {
  pool: Pool;
  clock: ManualClock;
  ctx: GameContext;
  services: Services;
  app: FastifyInstance;
  config: Config;
  events: PlayerEvent[];
  close(): Promise<void>;
}

export async function harness(
  opts: {
    params?: GameParams;
    pool?: Pool;
    clock?: ManualClock;
    reset?: boolean;
    rateLimits?: Partial<Config['rateLimits']>;
  } = {},
): Promise<Harness> {
  const pool = opts.pool ?? createPool(TEST_DB, 10);
  if (opts.reset !== false) await resetGameTables(pool);
  const clock = opts.clock ?? new ManualClock(T0);
  const bus = new EventBus();
  const events: PlayerEvent[] = [];
  bus.onPlayer((pid, ev) => events.push({ ...ev, to: pid }));
  const ctx: GameContext = {
    pool,
    clock,
    params: opts.params ?? DEFAULT_PARAMS,
    land: new PostgisLandMask(pool),
    events: bus,
    log: { info() {}, warn() {}, error: (o: unknown, m?: string) => console.error(m, o) },
    sessionTtlMs: 30 * 86400_000,
  };
  const services = createServices(ctx);
  const base = loadConfig({});
  const config: Config = {
    ...base,
    databaseUrl: TEST_DB,
    landMask: 'postgis',
    rateLimits: { global: 100_000, auth: 100_000, gps: 100_000, ...opts.rateLimits },
  };
  const app = await buildApp(ctx, services, config, { logger: false });
  await app.ready();
  return {
    pool,
    clock,
    ctx,
    services,
    app,
    config,
    events,
    async close() {
      await app.close();
      if (!opts.pool) await pool.end();
    },
  };
}

export interface TestPlayer {
  id: string;
  cookie: string;
  name: string;
}

export async function registerPlayer(h: Harness, name: string): Promise<TestPlayer> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-tio-client': 'test' },
    payload: { username: name, password: 'correct horse battery' },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return { id: res.json().id, cookie: raw.split(';')[0]!, name };
}

/** Authenticated request helper. */
export async function api(
  h: Harness,
  p: TestPlayer | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await h.app.inject({
    method,
    url,
    headers: { 'x-tio-client': 'test', ...(p ? { cookie: p.cookie } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers };
}

/** Sends GPS fixes `stepMs` apart (advancing the manual clock) and returns the last result. */
export async function walk(
  h: Harness,
  p: TestPlayer,
  points: { lat: number; lon: number; accuracy?: number }[],
  stepMs = 1000,
) {
  let last: { status: number; body: any } | undefined;
  for (const pt of points) {
    last = await api(h, p, 'POST', '/api/gps', { accuracy: 8, ...pt });
    h.clock.advance(stepMs);
  }
  return last!;
}

/** Sends `n` fixes at the same point, 1 s apart — enough to conquer when n ≥ 3. */
export function stand(h: Harness, p: TestPlayer, lat: number, lon: number, n = 3) {
  return walk(h, p, Array.from({ length: n }, () => ({ lat, lon })));
}
