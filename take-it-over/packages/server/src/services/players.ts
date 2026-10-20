import { creditsToUnits } from '@tio/shared';
import type { GameContext } from '../context';
import { withTx } from '../db/pool';
import { GameError } from '../errors';
import { dummyPasswordHash, hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth';
import { readBalance } from './economy';

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const SESSION_COOKIE = 'tio_session';

/** A random, reasonably bright colour for a new player's territory. */
export function randomPlayerColor(rand: () => number = Math.random): string {
  const h = rand() * 360;
  const s = 0.65 + rand() * 0.3;
  const l = 0.5 + rand() * 0.12;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export interface Registered {
  playerId: string;
  token: string;
}

/** Creates a player with the approved starting kit: 1,000 credits and one free basic drone. */
export async function register(ctx: GameContext, username: string, password: string): Promise<Registered> {
  if (!USERNAME_RE.test(username)) {
    throw new GameError('invalid_username', 'username must be 3–20 letters, digits or _', 400);
  }
  if (password.length < 8 || password.length > 200) {
    throw new GameError('invalid_password', 'password must be 8–200 characters', 400);
  }
  const hash = await hashPassword(password);
  const now = ctx.clock.now();
  return withTx(ctx.pool, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO players (username, username_lower, password_hash, color, credit_units, settled_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (username_lower) DO NOTHING
       RETURNING id`,
      [
        username,
        username.toLowerCase(),
        hash,
        randomPlayerColor(),
        creditsToUnits(ctx.params.economy.startingCredits).toString(),
        new Date(now),
      ],
    );
    const playerId = ins.rows[0]?.id;
    if (!playerId) throw new GameError('username_taken', 'that username is taken', 409);
    await tx.query(
      `INSERT INTO ledger (player_id, delta_units, reason, created_at) VALUES ($1, $2, 'starting_credits', $3)`,
      [playerId, creditsToUnits(ctx.params.economy.startingCredits).toString(), new Date(now)],
    );
    await tx.query(`INSERT INTO drones (owner_id, type, status, created_at) VALUES ($1, 'basic', 'idle', $2)`, [
      playerId,
      new Date(now),
    ]);
    const session = await createSession(tx, playerId, now, ctx);
    return { playerId, token: session };
  });
}

async function createSession(
  db: { query: GameContext['pool']['query'] },
  playerId: string,
  now: number,
  ctx: GameContext,
): Promise<string> {
  const { token, hash } = newSessionToken();
  const ttl = ctx.sessionTtlMs;
  await db.query(
    `INSERT INTO sessions (token_hash, player_id, created_at, expires_at, last_seen_at) VALUES ($1, $2, $3, $4, $3)`,
    [hash, playerId, new Date(now), new Date(now + ttl)],
  );
  return token;
}

export async function login(ctx: GameContext, username: string, password: string): Promise<Registered> {
  const res = await ctx.pool.query<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM players WHERE username_lower = $1',
    [username.toLowerCase()],
  );
  const row = res.rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyPasswordHash()));
  if (!row || !ok) throw new GameError('invalid_credentials', 'wrong username or password', 401);
  const token = await createSession(ctx.pool, row.id, ctx.clock.now(), ctx);
  return { playerId: row.id, token };
}

export async function logout(ctx: GameContext, token: string): Promise<void> {
  await ctx.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Resolves a session token to a player id, sliding `last_seen_at` at most once a minute. */
export async function authenticate(ctx: GameContext, token: string | undefined): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const now = ctx.clock.now();
  const res = await ctx.pool.query<{ player_id: string; last_seen_at: Date }>(
    'SELECT player_id, last_seen_at FROM sessions WHERE token_hash = $1 AND expires_at > $2',
    [hashToken(token), new Date(now)],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (now - row.last_seen_at.getTime() > 60_000) {
    await ctx.pool.query('UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1', [hashToken(token), new Date(now)]);
  }
  return row.player_id;
}

export interface Profile {
  id: string;
  username: string;
  color: string;
  locale: string;
  allianceId: string | null;
  credits: number;
  creditFraction: number;
  parcels: number;
  incomePerHour: number;
  notificationPrefs: Record<string, boolean>;
  gpsSuspendedUntil: string | null;
  serverTime: number;
}

export async function profile(ctx: GameContext, playerId: string): Promise<Profile> {
  const now = ctx.clock.now();
  const res = await ctx.pool.query<{
    username: string;
    color: string;
    locale: string;
    alliance_id: string | null;
    notification_prefs: Record<string, boolean>;
    gps_suspended_until: Date | null;
  }>(
    'SELECT username, color, locale, alliance_id, notification_prefs, gps_suspended_until FROM players WHERE id = $1',
    [playerId],
  );
  const row = res.rows[0]!;
  const bal = await readBalance(ctx.pool, ctx, playerId, now);
  return {
    id: playerId,
    username: row.username,
    color: row.color,
    locale: row.locale,
    allianceId: row.alliance_id,
    credits: bal.credits,
    creditFraction: bal.fraction,
    parcels: bal.parcels,
    incomePerHour: bal.incomePerHour,
    notificationPrefs: row.notification_prefs,
    gpsSuspendedUntil:
      row.gps_suspended_until && row.gps_suspended_until.getTime() > now ? row.gps_suspended_until.toISOString() : null,
    serverTime: now,
  };
}

export const NOTIFICATION_CATEGORIES = ['conquest', 'drones', 'wars', 'armies', 'bases', 'alliance', 'economy'] as const;

export async function updateSettings(
  ctx: GameContext,
  playerId: string,
  patch: { locale?: 'en' | 'es'; color?: string; notificationPrefs?: Record<string, boolean> },
): Promise<void> {
  if (patch.color !== undefined && !/^#[0-9a-f]{6}$/.test(patch.color)) {
    throw new GameError('invalid_color', 'colour must be #rrggbb', 400);
  }
  if (patch.notificationPrefs) {
    for (const k of Object.keys(patch.notificationPrefs)) {
      if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(k)) {
        throw new GameError('invalid_category', `unknown notification category ${k}`, 400);
      }
    }
  }
  await ctx.pool.query(
    `UPDATE players SET
       locale = COALESCE($2, locale),
       color = COALESCE($3, color),
       notification_prefs = notification_prefs || COALESCE($4::jsonb, '{}'::jsonb)
     WHERE id = $1`,
    [playerId, patch.locale ?? null, patch.color ?? null, patch.notificationPrefs ? JSON.stringify(patch.notificationPrefs) : null],
  );
}
