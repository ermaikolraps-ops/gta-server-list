import { describe, expect, it } from 'vitest';
import { advance, api, harness, registerPlayer, stand } from './helpers';

describe('maintenance', () => {
  it('purges old GPS anomalies, expired sessions and used idempotency keys, and reschedules itself', async () => {
    const h = await harness();
    await h.services.maintenance.ensureScheduled();
    await h.services.maintenance.ensureScheduled(); // idempotent
    const pending = await h.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'maintenance' AND status = 'pending'`);
    expect(pending.rows[0].n).toBe(1);

    const p = await registerPlayer(h, 'tracked');
    await stand(h, p, 40.3, 0.3, 1);
    await stand(h, p, 40.9, 0.9, 1); // a teleport → one anomaly row
    await new Promise((r) => setTimeout(r, 50));
    await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': 'keep-me-for-a-while' });
    const count = async (table: string) => (await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    expect(await count('gps_anomalies')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);

    await advance(h, 3 * 86400_000); // keys older than 2 days go
    expect(await count('idempotency_keys')).toBe(0);
    expect(await count('gps_anomalies')).toBe(1);
    await advance(h, 31 * 86400_000); // anomalies older than 30 days and expired sessions go
    expect(await count('gps_anomalies')).toBe(0);
    expect(await count('sessions')).toBe(0);
    const still = await h.pool.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'maintenance' AND status = 'pending'`);
    expect(still.rows[0].n).toBe(1);
    await h.close();
  });
});
