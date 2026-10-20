import { type CellId, cellAt, composition, DEFAULT_PARAMS, type GameParams, type UnitType } from '@tio/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { ManualClock } from '../src/clock';
import { type Config, loadConfig } from '../src/config';
import type { GameContext } from '../src/context';
import { createPool, type Pool, withTx } from '../src/db/pool';
import { unitsJson } from '../src/services/common';
import { grant } from '../src/services/economy';
import { claimNeutralCells } from '../src/services/territory';
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
  'jobs',
  'bases',
  'aa_batteries',
  'armies',
  'repairs',
  'drone_missions',
  'ships',
  'wars',
  'war_cells',
  'alliance_invites',
  'notifications',
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
    publicPath?: string;
    trustProxyHops?: number;
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
    publicPath: opts.publicPath ?? '/',
    trustProxyHops: opts.trustProxyHops ?? 0,
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

// ------------------------------------------------------------ Phase C helpers


/** A rectangle of cells starting at (lat, lon), `rows` × `cols` cells of ~100 m. */
export function block(lat: number, lon: number, rows: number, cols: number): CellId[] {
  const out: CellId[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(cellAt(lat + r * 0.0009, lon + c * 0.00119));
  return [...new Set(out)];
}

export async function giveCells(h: Harness, playerId: string, cells: CellId[]): Promise<void> {
  await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, playerId, cells, 'gps', h.clock.now()));
}

export async function giveCredits(h: Harness, playerId: string, credits: number): Promise<void> {
  await withTx(h.pool, (tx) => grant(tx, h.ctx, playerId, credits, 'test', null, h.clock.now()));
}

/** Inserts an idle army directly (test setup shortcut for recruit/deploy). */
export async function armyAt(
  h: Harness,
  ownerId: string,
  lat: number,
  lon: number,
  units: Partial<Record<UnitType, number>>,
): Promise<string> {
  const res = await h.pool.query<{ id: string }>(
    `INSERT INTO armies (owner_id, units, status, lat, lon, created_at) VALUES ($1, $2, 'idle', $3, $4, $5) RETURNING id`,
    [ownerId, unitsJson(composition(units)), lat, lon, new Date(h.clock.now())],
  );
  return res.rows[0]!.id;
}

/** Advances game time and runs every job that fell due, in order. */
export async function advance(h: Harness, ms: number): Promise<number> {
  h.clock.advance(ms);
  return h.services.scheduler.runDue();
}

/** Gives the player a fresh accurate GPS fix at a point. */
export async function fixAt(h: Harness, p: TestPlayer, lat: number, lon: number) {
  h.clock.advance(1000);
  return api(h, p, 'POST', '/api/gps', { lat, lon, accuracy: 5 });
}

export async function armyRow(h: Harness, id: string) {
  return (await h.pool.query('SELECT * FROM armies WHERE id = $1', [id])).rows[0];
}

export async function ownerOf(h: Harness, cell: CellId): Promise<string | undefined> {
  return (await h.pool.query('SELECT owner_id FROM parcels WHERE cell_id = $1', [cell])).rows[0]?.owner_id;
}

export function key(): string {
  return `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}
