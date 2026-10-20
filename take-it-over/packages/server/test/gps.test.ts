import { cellAt, DEFAULT_PARAMS, mergeParams } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { api, harness, type Harness, registerPlayer, resetGameTables, stand, T0, walk } from './helpers';

let h: Harness;
beforeEach(async () => {
  if (!h) h = await harness({ params: mergeParams(DEFAULT_PARAMS, { gps: { anomalyThreshold: 3 } }) });
  else await resetGameTables(h.pool);
  h.clock.set(T0);
  h.services.gps['presence'].clear();
  h.services.gps['suspension'].clear();
});
afterAll(async () => h.close());

const owner = async (lat: number, lon: number) =>
  (await h.pool.query('SELECT owner_id FROM parcels WHERE cell_id = $1', [cellAt(lat, lon)])).rows[0]?.owner_id;

describe('GPS conquest', () => {
  it('conquers a neutral land cell after 2 seconds of server-timed dwell', async () => {
    const p = await registerPlayer(h, 'walker');
    const fix = { lat: 40.3, lon: 0.3, accuracy: 10 };
    const r1 = await api(h, p, 'POST', '/api/gps', fix);
    expect(r1.body).toMatchObject({ status: 'tracking', dwellMs: 0, requiredMs: 2000 });
    h.clock.advance(1999);
    const r2 = await api(h, p, 'POST', '/api/gps', fix);
    expect(r2.body).toMatchObject({ status: 'tracking', dwellMs: 1999 });
    expect(await owner(40.3, 0.3)).toBeUndefined();
    h.clock.advance(300);
    const r3 = await api(h, p, 'POST', '/api/gps', fix);
    expect(r3.body).toMatchObject({ status: 'conquered', dwellMs: 2299 });
    expect(await owner(40.3, 0.3)).toBe(p.id);
    expect(h.events.some((e) => e.type === 'parcel_conquered' && e.to === p.id)).toBe(true);
    h.clock.advance(1000);
    const again = await api(h, p, 'POST', '/api/gps', fix);
    expect(again.body.status).toBe('own');
  });

  it('requires continuous presence: a long gap between fixes restarts the dwell', async () => {
    const p = await registerPlayer(h, 'gappy');
    await walk(h, p, [{ lat: 40.3, lon: 0.3 }], 11_000);
    const r = await walk(h, p, [{ lat: 40.3, lon: 0.3 }]);
    expect(r.body).toMatchObject({ status: 'tracking', dwellMs: 0 });
  });

  it('restarts the dwell timer when the player changes cell', async () => {
    const p = await registerPlayer(h, 'walker');
    await walk(h, p, [{ lat: 40.3, lon: 0.3 }, { lat: 40.3, lon: 0.3 }]);
    const moved = await walk(h, p, [{ lat: 40.3, lon: 0.3015 }]);
    expect(moved.body).toMatchObject({ status: 'tracking', dwellMs: 0 });
    expect(await owner(40.3, 0.3)).toBeUndefined();
  });

  it('ignores fixes worse than 20 m and restarts the dwell after them', async () => {
    const p = await registerPlayer(h, 'walker');
    const pt = { lat: 40.3, lon: 0.3 };
    await walk(h, p, [pt, pt]);
    const bad = await walk(h, p, [{ ...pt, accuracy: 20.5 }]);
    expect(bad.body.status).toBe('low_accuracy');
    const r = await walk(h, p, [
      { ...pt, accuracy: 20 },
      { ...pt, accuracy: 20 },
    ]);
    expect(r.body).toMatchObject({ status: 'tracking', dwellMs: 1000 });
    expect((await walk(h, p, [pt])).body.status).toBe('conquered');
  });

  it('never conquers water: lakes and sea', async () => {
    const p = await registerPlayer(h, 'swimmer');
    expect((await stand(h, p, 40.51, 0.51)).body.status).toBe('water');
    expect((await stand(h, p, 40.5, 1.2)).body.status).toBe('water');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM parcels')).rows[0].n).toBe(0);
  });

  it('cannot conquer enemy territory by GPS', async () => {
    const a = await registerPlayer(h, 'first');
    const b = await registerPlayer(h, 'second');
    await stand(h, a, 40.3, 0.3);
    const r = await stand(h, b, 40.3, 0.3, 5);
    expect(r.body.status).toBe('enemy');
    expect(r.body.ownerId).toBe(a.id);
    expect(await owner(40.3, 0.3)).toBe(a.id);
  });

  it('allows isolated parcels anywhere', async () => {
    const p = await registerPlayer(h, 'hopper');
    await stand(h, p, 40.3, 0.3);
    h.clock.advance(3600_000);
    await stand(h, p, 40.9, 0.9);
    expect(await owner(40.9, 0.9)).toBe(p.id);
  });

  it('allows any real travel speed without logging anomalies', async () => {
    const p = await registerPlayer(h, 'flyer');
    // ~900 km/h: 2.5 km every 10 s
    for (let i = 0; i < 5; i++) {
      await api(h, p, 'POST', '/api/gps', { lat: 40.3, lon: 0.3 + i * 0.0295, accuracy: 15 });
      h.clock.advance(10_000);
    }
    expect((await stand(h, p, 40.3, 0.3 + 5 * 0.0295)).body.status).toBe('conquered');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM gps_anomalies')).rows[0].n).toBe(0);
  });

  it('logs a teleport as an anomaly but does not punish a single jump', async () => {
    const p = await registerPlayer(h, 'jumper');
    await stand(h, p, 40.3, 0.3);
    const r = await stand(h, p, 40.9, 0.9); // 85 km in 1 s
    expect(r.body.status).toBe('conquered');
    await new Promise((res) => setTimeout(res, 50));
    const rows = await h.pool.query('SELECT kind, detail FROM gps_anomalies WHERE player_id = $1', [p.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].kind).toBe('implausible_speed');
    // derived numbers only — never coordinates
    expect(Object.keys(rows.rows[0].detail).sort()).toEqual(['distanceM', 'dtMs', 'speedKmh', 'toCell']);
  });

  it('suspends GPS conquest only after repeated anomalies', async () => {
    const p = await registerPlayer(h, 'cheater');
    for (const lon of [0.1, 0.9, 0.1, 0.9]) {
      await walk(h, p, [{ lat: 40.3, lon }]);
      await new Promise((res) => setTimeout(res, 30));
    }
    const r = await stand(h, p, 40.6, 0.9, 4);
    expect(r.body.status).toBe('suspended');
    const me = await api(h, p, 'GET', '/api/me');
    expect(me.body.gpsSuspendedUntil).not.toBeNull();
    h.clock.advance(13 * 3600_000);
    h.services.gps['suspension'].clear();
    expect((await stand(h, p, 40.6, 0.9, 3)).body.status).toBe('conquered');
  });

  it('drops fixes that arrive faster than the rate limit', async () => {
    const p = await registerPlayer(h, 'spammer');
    await api(h, p, 'POST', '/api/gps', { lat: 40.3, lon: 0.3, accuracy: 5 });
    h.clock.advance(100);
    expect((await api(h, p, 'POST', '/api/gps', { lat: 40.3, lon: 0.3, accuracy: 5 })).body.status).toBe('rate_limited');
  });

  it('rejects malformed fixes', async () => {
    const p = await registerPlayer(h, 'fuzzer');
    expect((await api(h, p, 'POST', '/api/gps', { lat: 91, lon: 0, accuracy: 5 })).status).toBe(400);
    expect((await api(h, p, 'POST', '/api/gps', { lat: 40, lon: 0, accuracy: 0 })).status).toBe(400);
    expect((await api(h, p, 'POST', '/api/gps', { lat: '40', lon: 0, accuracy: 5 })).status).toBe(400);
  });

  it('rewards territory-less explorers for new zones, once per zone', async () => {
    const p = await registerPlayer(h, 'explorer');
    const minute = 60_000; // walk at plausible speeds so no anomaly interferes
    const r1 = await walk(h, p, [{ lat: 40.51, lon: 0.51 }], minute); // lake: still a new zone
    expect(r1.body.explorationReward).toBe(10);
    await walk(h, p, [{ lat: 40.55, lon: 0.55 }], minute); // same 0.1° zone
    const back = await walk(h, p, [{ lat: 40.45, lon: 0.45 }], minute);
    expect(back.body.explorationReward).toBe(10);
    const again = await walk(h, p, [{ lat: 40.51, lon: 0.51 }], minute);
    expect(again.body.explorationReward).toBeUndefined();
    expect((await api(h, p, 'GET', '/api/me')).body.credits).toBe(1020);
    h.clock.advance(10 * minute);
    expect((await stand(h, p, 40.3, 0.3)).body.status).toBe('conquered');
    h.clock.advance(10 * minute);
    const withLand = await walk(h, p, [{ lat: 40.65, lon: 0.65 }]);
    expect(withLand.body.explorationReward).toBeUndefined();
  });

  it('accepts fixes over the WebSocket and pushes conquest events', async () => {
    const p = await registerPlayer(h, 'socket');
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(address.replace('http', 'ws') + '/ws', { headers: { cookie: p.cookie } });
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('message', (d) => {
        messages.push(JSON.parse(d.toString()));
        if (messages[0]?.type === 'hello') resolve();
      });
      ws.on('error', reject);
    });
    const send = async (seq: number) => {
      ws.send(JSON.stringify({ type: 'gps', seq, lat: 40.3, lon: 0.3, accuracy: 5 }));
      await new Promise((res) => setTimeout(res, 150));
      h.clock.advance(1000);
    };
    await send(1);
    await send(2);
    await send(3);
    ws.close();
    expect(messages.find((m) => m.type === 'gps_result' && m.seq === 3)?.status).toBe('conquered');
    expect(messages.some((m) => m.type === 'parcel_conquered')).toBe(true);

    const anon = new WebSocket(address.replace('http', 'ws') + '/ws');
    const code = await new Promise<number>((resolve) => anon.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
