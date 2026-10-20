import type { GameContext } from '../context';
import type { Tx } from '../db/pool';
import type { Scheduler } from '../scheduler';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Retention windows. GPS-derived data is kept only as long as anti-cheat needs it. */
export const RETENTION = {
  gpsAnomaliesMs: 30 * DAY,
  idempotencyKeysMs: 2 * DAY,
  notificationsMs: 90 * DAY,
  finishedJobsMs: 7 * DAY,
};

/**
 * Hourly housekeeping as a self-rescheduling durable job: purges expired
 * sessions, old GPS anomaly records, used idempotency keys, old
 * notifications and finished jobs.
 */
export class MaintenanceService {
  constructor(
    private readonly ctx: GameContext,
    private readonly scheduler: Scheduler,
  ) {
    scheduler.register('maintenance', (tx, job) => this.run(tx, job.runAt));
  }

  /** Makes sure exactly one maintenance job is pending (call at startup). */
  async ensureScheduled(): Promise<void> {
    const client = await this.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(727002)');
      const pending = await client.query(`SELECT 1 FROM jobs WHERE kind = 'maintenance' AND status = 'pending' LIMIT 1`);
      if (!pending.rowCount) await this.scheduler.schedule(client, 'maintenance', 'global', this.ctx.clock.now() + HOUR);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async run(tx: Tx, at: number): Promise<void> {
    const before = (ms: number) => new Date(at - ms);
    await tx.query('DELETE FROM sessions WHERE expires_at < $1', [new Date(at)]);
    await tx.query('DELETE FROM gps_anomalies WHERE created_at < $1', [before(RETENTION.gpsAnomaliesMs)]);
    await tx.query('DELETE FROM idempotency_keys WHERE created_at < $1', [before(RETENTION.idempotencyKeysMs)]);
    await tx.query('DELETE FROM notifications WHERE created_at < $1', [before(RETENTION.notificationsMs)]);
    await tx.query(`DELETE FROM jobs WHERE status IN ('done', 'cancelled') AND run_at < $1`, [before(RETENTION.finishedJobsMs)]);
    await this.scheduler.schedule(tx, 'maintenance', 'global', at + HOUR);
  }
}
