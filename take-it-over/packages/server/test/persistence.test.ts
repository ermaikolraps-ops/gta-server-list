import { describe, expect, it } from 'vitest';
import { api, harness, registerPlayer, stand } from './helpers';

describe('restart safety', () => {
  it('keeps sessions, parcels and accrued income across a server restart', async () => {
    const h1 = await harness();
    const p = await registerPlayer(h1, 'survivor');
    expect((await stand(h1, p, 40.3, 0.3)).body.status).toBe('conquered');
    const clock = h1.clock;
    await h1.close(); // server process gone, pool closed

    clock.advance(3 * 3600_000); // offline for three hours
    const h2 = await harness({ reset: false, clock });
    const me = await api(h2, p, 'GET', '/api/me');
    expect(me.status).toBe(200);
    expect(me.body.parcels).toBe(1);
    expect(me.body.credits).toBe(1000 + 10 + 3); // start + exploration reward + 3 h × 1 parcel
    // GPS presence is intentionally in memory: a fresh 2 s dwell is needed after restart.
    expect((await stand(h2, p, 40.3, 0.3015, 1)).body.status).toBe('tracking');
    await h2.close();
  });
});
