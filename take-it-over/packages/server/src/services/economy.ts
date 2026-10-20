import { accruedUnits, creditsToUnits, unitsToCredits } from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable, Tx } from '../db/pool';
import { GameError, notFound } from '../errors';

/**
 * Credits use lazy settlement: a player row stores the balance at `settled_at`
 * plus the parcel count since then. Every change to credits or parcel count
 * first settles income up to that moment, so ownership changes split income
 * exactly at the instant they happen. All functions here expect to run inside
 * a transaction and take a row lock on the player.
 */

/** Locks player rows in a global order (by id) so concurrent transfers cannot deadlock. */
export async function lockPlayers(tx: Tx, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return;
  await tx.query('SELECT id FROM players WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [unique]);
}

/** Settles passive income up to `atMs`; returns the balance in units. */
export async function settle(tx: Tx, ctx: GameContext, playerId: string, atMs: number): Promise<bigint> {
  const res = await tx.query<{ credit_units: string; parcel_count: number; settled_at: Date }>(
    'SELECT credit_units, parcel_count, settled_at FROM players WHERE id = $1 FOR UPDATE',
    [playerId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('player');
  const settledAt = row.settled_at.getTime();
  // During catch-up after downtime an event may be older than the last
  // settlement; never settle backwards (that would pay twice).
  const at = Math.max(atMs, settledAt);
  const units =
    BigInt(row.credit_units) +
    accruedUnits(row.parcel_count, at - settledAt, ctx.params.economy.creditsPerParcelPerHour);
  if (at !== settledAt) {
    await tx.query('UPDATE players SET credit_units = $2, settled_at = $3 WHERE id = $1', [
      playerId,
      units.toString(),
      new Date(at),
    ]);
  }
  return units;
}

export async function spend(
  tx: Tx,
  ctx: GameContext,
  playerId: string,
  credits: number,
  reason: string,
  ref: string | null,
  atMs: number,
): Promise<bigint> {
  if (!Number.isInteger(credits) || credits < 0) throw new GameError('bad_amount', 'invalid amount', 400);
  const balance = await settle(tx, ctx, playerId, atMs);
  const cost = creditsToUnits(credits);
  if (balance < cost) {
    throw new GameError('insufficient_credits', 'not enough credits', 409, {
      needed: credits,
      available: unitsToCredits(balance),
    });
  }
  const after = balance - cost;
  await tx.query('UPDATE players SET credit_units = $2 WHERE id = $1', [playerId, after.toString()]);
  await tx.query(
    'INSERT INTO ledger (player_id, delta_units, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)',
    [playerId, (-cost).toString(), reason, ref, new Date(atMs)],
  );
  return after;
}

export async function grant(
  tx: Tx,
  ctx: GameContext,
  playerId: string,
  credits: number,
  reason: string,
  ref: string | null,
  atMs: number,
): Promise<bigint> {
  if (!Number.isInteger(credits) || credits < 0) throw new GameError('bad_amount', 'invalid amount', 400);
  const balance = await settle(tx, ctx, playerId, atMs);
  const amount = creditsToUnits(credits);
  await tx.query('UPDATE players SET credit_units = credit_units + $2 WHERE id = $1', [playerId, amount.toString()]);
  await tx.query(
    'INSERT INTO ledger (player_id, delta_units, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5)',
    [playerId, amount.toString(), reason, ref, new Date(atMs)],
  );
  return balance + amount;
}

/** Settles, then changes the parcel count (income rate) from `atMs` on. */
export async function changeParcelCount(
  tx: Tx,
  ctx: GameContext,
  playerId: string,
  delta: number,
  atMs: number,
): Promise<void> {
  if (delta === 0) return;
  await settle(tx, ctx, playerId, atMs);
  await tx.query('UPDATE players SET parcel_count = parcel_count + $2 WHERE id = $1', [playerId, delta]);
}

export interface Balance {
  credits: number;
  parcels: number;
  incomePerHour: number;
  /** Fraction of the next credit already earned (0..1), for a smooth client counter. */
  fraction: number;
}

/** Read-only balance at `nowMs` (no write, no lock). */
export async function readBalance(db: Queryable, ctx: GameContext, playerId: string, nowMs: number): Promise<Balance> {
  const res = await db.query<{ credit_units: string; parcel_count: number; settled_at: Date }>(
    'SELECT credit_units, parcel_count, settled_at FROM players WHERE id = $1',
    [playerId],
  );
  const row = res.rows[0];
  if (!row) throw notFound('player');
  const rate = ctx.params.economy.creditsPerParcelPerHour;
  const units =
    BigInt(row.credit_units) + accruedUnits(row.parcel_count, nowMs - row.settled_at.getTime(), rate);
  const whole = unitsToCredits(units);
  return {
    credits: whole,
    parcels: row.parcel_count,
    incomePerHour: row.parcel_count * rate,
    fraction: Number(units - creditsToUnits(whole)) / Number(creditsToUnits(1)),
  };
}
