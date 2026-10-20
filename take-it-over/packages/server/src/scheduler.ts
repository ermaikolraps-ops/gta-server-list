import type { GameContext } from './context';
import type { Tx } from './db/pool';
import { Outbox } from './outbox';

export interface Job {
  id: string;
  kind: string;
  ref: string;
  runAt: number;
  payload: Record<string, unknown>;
}

/** A job handler. `job.runAt` is the in-game time of the event, even when processed late. */
export type JobHandler = (tx: Tx, job: Job, out: Outbox) => Promise<void>;

const MAX_ATTEMPTS = 5;

/**
 * Durable, restart-safe timers backed by the jobs table. Each due job runs in
 * its own transaction together with its effects (exactly-once). Due jobs are
 * claimed with FOR UPDATE SKIP LOCKED, so several server instances can share
 * the work, and are processed in run_at order so catch-up after downtime
 * replays events chronologically.
 */
export class Scheduler {
  private handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly ctx: GameContext) {}

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async schedule(tx: Tx, kind: string, ref: string, runAtMs: number, payload: Record<string, unknown> = {}): Promise<void> {
    await tx.query('INSERT INTO jobs (kind, ref, run_at, payload, created_at) VALUES ($1, $2, $3, $4, $5)', [
      kind,
      ref,
      new Date(runAtMs),
      JSON.stringify(payload),
      new Date(this.ctx.clock.now()),
    ]);
  }

  async cancel(tx: Tx, kind: string, ref: string): Promise<void> {
    await tx.query(`UPDATE jobs SET status = 'cancelled' WHERE kind = $1 AND ref = $2 AND status = 'pending'`, [kind, ref]);
  }

  /** Runs every job due at the current clock time. Returns how many ran. */
  async runDue(max = 10_000): Promise<number> {
    let ran = 0;
    while (ran < max) {
      const did = await this.runOne();
      if (did === null) break;
      ran++;
    }
    return ran;
  }

  private async runOne(): Promise<boolean | null> {
    const now = this.ctx.clock.now();
    const client = await this.ctx.pool.connect();
    let job: Job | null = null;
    const out = new Outbox();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ id: string; kind: string; ref: string; run_at: Date; payload: Record<string, unknown> }>(
        `SELECT id, kind, ref, run_at, payload FROM jobs
          WHERE status = 'pending' AND run_at <= $1
          ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [new Date(now)],
      );
      const row = res.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      job = { id: row.id, kind: row.kind, ref: row.ref, runAt: row.run_at.getTime(), payload: row.payload };
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
      await handler(client, job, out);
      await client.query(`UPDATE jobs SET status = 'done', attempts = attempts + 1 WHERE id = $1`, [job.id]);
      await client.query('COMMIT');
      out.flush(this.ctx.events);
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!job) throw err;
      this.ctx.log.error({ err, job }, 'job failed');
      await this.ctx.pool.query(
        `UPDATE jobs SET attempts = attempts + 1, last_error = $2,
                status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END,
                run_at = CASE WHEN attempts + 1 >= $3 THEN run_at ELSE run_at + interval '5 seconds' END
          WHERE id = $1`,
        [job.id, String((err as Error).message ?? err).slice(0, 1000), MAX_ATTEMPTS],
      );
      return false;
    } finally {
      client.release();
    }
  }

  start(intervalMs: number): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runDue(500);
      } catch (err) {
        this.ctx.log.error({ err }, 'scheduler tick failed');
      } finally {
        this.running = false;
        if (this.timer) this.timer = setTimeout(tick, intervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
