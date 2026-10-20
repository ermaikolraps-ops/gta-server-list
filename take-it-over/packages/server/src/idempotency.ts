import type { GameContext } from './context';
import { type Tx, withTx } from './db/pool';
import { GameError } from './errors';

export interface Outcome<T = unknown> {
  status: number;
  body: T;
  replayed?: boolean;
}

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Runs a state-changing operation at most once per (player, Idempotency-Key).
 * The key row is inserted inside the same transaction as the effects, so a
 * retried request either replays the stored response or — if the first
 * attempt rolled back — runs again. A concurrent duplicate blocks on the key's
 * unique index until the first finishes, then replays its response.
 */
export async function idempotent<T>(
  ctx: GameContext,
  playerId: string,
  key: string | undefined,
  route: string,
  fn: (tx: Tx) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  if (key === undefined) return withTx(ctx.pool, fn);
  if (!KEY_RE.test(key)) throw new GameError('bad_idempotency_key', 'Idempotency-Key must be 8–100 url-safe chars', 400);
  return withTx(ctx.pool, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO idempotency_keys (player_id, key, route, status_code, response, created_at)
       VALUES ($1, $2, $3, 0, 'null'::jsonb, $4) ON CONFLICT DO NOTHING RETURNING key`,
      [playerId, key, route, new Date(ctx.clock.now())],
    );
    if (!ins.rowCount) {
      const prev = await tx.query<{ route: string; status_code: number; response: T }>(
        'SELECT route, status_code, response FROM idempotency_keys WHERE player_id = $1 AND key = $2',
        [playerId, key],
      );
      const row = prev.rows[0]!;
      if (row.route !== route) {
        throw new GameError('idempotency_key_reused', 'this Idempotency-Key was used for another request', 422);
      }
      return { status: row.status_code, body: row.response, replayed: true };
    }
    const out = await fn(tx);
    await tx.query('UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE player_id = $1 AND key = $2', [
      playerId,
      key,
      out.status,
      JSON.stringify(out.body ?? null),
    ]);
    return out;
  });
}
