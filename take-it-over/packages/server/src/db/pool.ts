import pg from 'pg';

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max });
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock

/**
 * Runs `fn` in a transaction. Deadlocks and serialization failures are retried
 * a few times; anything else rolls back and propagates.
 */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
