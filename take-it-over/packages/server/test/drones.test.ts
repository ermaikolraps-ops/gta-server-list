import { cellAt, cellId, cellRow, cellCol } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  api,
  block,
  fixAt,
  giveCells,
  giveCredits,
  harness,
  type Harness,
  key,
  ownerOf,
  registerPlayer,
  resetGameTables,
  T0,
  type TestPlayer,
} from './helpers';

let h: Harness;
beforeEach(async () => {
  if (!h) h = await harness();
  else await resetGameTables(h.pool);
  h.clock.set(T0);
  h.services.gps['presence'].clear();
});
afterAll(async () => h.close());

const HOME = { lat: 40.3, lon: 0.3 };
const droneOf = async (p: TestPlayer) => (await api(h, p, 'GET', '/api/drones')).body.drones[0].id as string;
const launch = (p: TestPlayer, droneId: string, targets: number[]) =>
  api(h, p, 'POST', `/api/drones/${droneId}/launch`, { targets }, { 'idempotency-key': key() });
const missionRow = async (p: TestPlayer) =>
  (await h.pool.query('SELECT * FROM drone_missions WHERE owner_id = $1 ORDER BY launched_at DESC LIMIT 1', [p.id])).rows[0];

describe('drone missions', () => {
  it('captures a connected group of neutral parcels and comes back to be reused', async () => {
    const p = await registerPlayer(h, 'pilot');
    await fixAt(h, p, HOME.lat, HOME.lon);
    const targets = block(40.6, 0.6, 3, 3);
    const drone = await droneOf(p);
    const res = await launch(p, drone, targets);
    expect(res.status).toBe(201);
    const flightMs = res.body.arriveAt - res.body.launchedAt;
    // ~42 km at 300 km/h ≈ 8.4 minutes each way
    expect(flightMs).toBeGreaterThan(8 * 60_000);
    expect(flightMs).toBeLessThan(9 * 60_000);
    expect(res.body.returnAt - res.body.arriveAt).toBe(flightMs);

    await advance(h, flightMs - 1000);
    expect(await ownerOf(h, targets[0]!)).toBeUndefined();
    await advance(h, 1000);
    for (const c of targets) expect(await ownerOf(h, c)).toBe(p.id);
    expect((await api(h, p, 'GET', '/api/drones')).body.drones[0].status).toBe('flying');
    await advance(h, flightMs);
    const after = await api(h, p, 'GET', '/api/drones');
    expect(after.body.drones[0].status).toBe('idle');
    expect(after.body.missions[0]).toMatchObject({ status: 'completed', captured: expect.any(Array) });
    expect(after.body.missions[0].captured).toHaveLength(targets.length);
    const me = await api(h, p, 'GET', '/api/me');
    expect(me.body.parcels).toBe(targets.length);
    // reusable: launch again right away
    await fixAt(h, p, HOME.lat, HOME.lon);
    expect((await launch(p, drone, block(40.7, 0.7, 1, 2))).status).toBe(201);
  });

  it('launches only from a fresh, accurate server-side GPS fix', async () => {
    const p = await registerPlayer(h, 'pilot');
    const drone = await droneOf(p);
    expect((await launch(p, drone, [cellAt(40.6, 0.6)])).body.error).toBe('no_fresh_gps');
    await fixAt(h, p, HOME.lat, HOME.lon);
    h.clock.advance(20_000);
    expect((await launch(p, drone, [cellAt(40.6, 0.6)])).body.error).toBe('no_fresh_gps');
  });

  it('rejects disconnected, oversized, water, owned and out-of-range targets', async () => {
    const p = await registerPlayer(h, 'pilot');
    const rival = await registerPlayer(h, 'rival');
    await fixAt(h, p, HOME.lat, HOME.lon);
    const drone = await droneOf(p);
    const c = cellAt(40.6, 0.6);
    const diagonal = cellId(cellRow(c) + 1, cellCol(c) + 1);
    const preview = async (targets: number[]) =>
      (await api(h, p, 'POST', `/api/drones/${drone}/preview`, { targets })).body;

    expect((await preview([c, diagonal])).connected).toBe(false);
    expect((await launch(p, drone, [c, diagonal])).body.error).toBe('invalid_targets');
    expect((await preview(block(40.6, 0.6, 3, 7))).tooMany).toBe(true);
    expect((await preview([cellAt(40.51, 0.51)])).cells[0].status).toBe('water');
    await giveCells(h, rival.id, [c]);
    expect((await preview([c])).cells[0].status).toBe('owned');
    expect((await preview([cellAt(40.5, 4.5)])).cells[0].status).toBe('out_of_range'); // ~356 km > 300 km
    expect((await launch(p, drone, [c])).body.error).toBe('invalid_targets');
  });

  it('reaches farther with a long-range drone and may create enclaves across the sea', async () => {
    const p = await registerPlayer(h, 'pilot');
    await giveCredits(h, p.id, 10_000);
    const bought = await api(h, p, 'POST', '/api/drones', { type: 'longRange' }, { 'idempotency-key': key() });
    expect(bought.status).toBe(201);
    expect(bought.body.radiusKm).toBe(1500);
    await fixAt(h, p, HOME.lat, HOME.lon);
    const far = block(40.5, 4.5, 2, 2);
    const res = await launch(p, bought.body.id, far);
    expect(res.status).toBe(201);
    await advance(h, res.body.arriveAt - h.clock.now());
    for (const c of far) expect(await ownerOf(h, c)).toBe(p.id);
  });

  it('allows at most 10 drones in flight', async () => {
    const p = await registerPlayer(h, 'swarm');
    await giveCredits(h, p.id, 100_000);
    for (let i = 0; i < 10; i++) await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': key() });
    await fixAt(h, p, HOME.lat, HOME.lon);
    const drones = (await api(h, p, 'GET', '/api/drones')).body.drones;
    expect(drones).toHaveLength(11);
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await launch(p, drones[i].id, [cellAt(40.6 + i * 0.002, 0.6)]));
    expect(results.slice(0, 10).every((r) => r.status === 201)).toBe(true);
    expect(results[10]!.body.error).toBe('too_many_active_drones');
  });

  it('skips targets taken in flight and captures only a connected remainder', async () => {
    const p = await registerPlayer(h, 'pilot');
    const rival = await registerPlayer(h, 'rival');
    await fixAt(h, p, HOME.lat, HOME.lon);
    const row = block(40.6, 0.6, 1, 5); // c0 c1 c2 c3 c4 in a line
    const res = await launch(p, await droneOf(p), row);
    expect(res.status).toBe(201);
    await giveCells(h, rival.id, [row[1]!]); // rival walks onto c1 meanwhile
    await advance(h, res.body.arriveAt - h.clock.now());
    expect(await ownerOf(h, row[0]!)).toBeUndefined(); // isolated piece is left alone
    for (const c of row.slice(2)) expect(await ownerOf(h, c)).toBe(p.id);
    expect((await missionRow(p)).captured.map(Number).sort()).toEqual(row.slice(2).sort());
  });

  it('is shot down by an enemy AA battery on the way out, capturing nothing', async () => {
    const p = await registerPlayer(h, 'pilot');
    const rival = await registerPlayer(h, 'gunner');
    const aaCell = cellAt(40.45, 0.45); // on the flight path
    await giveCells(h, rival.id, [aaCell]);
    expect((await api(h, rival, 'POST', '/api/aa', { cellId: aaCell }, { 'idempotency-key': key() })).status).toBe(201);
    await fixAt(h, p, HOME.lat, HOME.lon);
    const targets = block(40.6, 0.6, 2, 2);
    const res = await launch(p, await droneOf(p), targets);
    await advance(h, res.body.returnAt - h.clock.now() + 1000);
    const m = await missionRow(p);
    expect(m.status).toBe('destroyed');
    expect(m.destroyed_at.getTime()).toBeLessThan(res.body.arriveAt);
    for (const c of targets) expect(await ownerOf(h, c)).toBeUndefined();
    expect((await api(h, p, 'GET', '/api/drones')).body.drones).toHaveLength(0);
    const notes = (await api(h, rival, 'GET', '/api/notifications')).body.items.map((n: { key: string }) => n.key);
    expect(notes).toContain('notify.aa.shotDown');
  });

  it('checks the return leg too: a battery built after the capture still downs the drone', async () => {
    const p = await registerPlayer(h, 'pilot');
    const rival = await registerPlayer(h, 'gunner');
    const aaCell = cellAt(40.45, 0.45);
    await giveCells(h, rival.id, [aaCell]);
    await fixAt(h, p, HOME.lat, HOME.lon);
    const targets = block(40.6, 0.6, 2, 2);
    const res = await launch(p, await droneOf(p), targets);
    await advance(h, res.body.arriveAt - h.clock.now() + 1000);
    for (const c of targets) expect(await ownerOf(h, c)).toBe(p.id);
    await api(h, rival, 'POST', '/api/aa', { cellId: aaCell }, { 'idempotency-key': key() });
    await advance(h, res.body.returnAt - h.clock.now());
    const m = await missionRow(p);
    expect(m.status).toBe('destroyed');
    expect(m.destroyed_at.getTime()).toBeGreaterThan(res.body.arriveAt);
    for (const c of targets) expect(await ownerOf(h, c)).toBe(p.id); // captures stand
  });

  it('ignores batteries away from the path and allied batteries', async () => {
    const p = await registerPlayer(h, 'pilot');
    const friend = await registerPlayer(h, 'friend');
    const aaCell = cellAt(40.45, 0.45);
    await giveCells(h, friend.id, [aaCell]);
    await api(h, friend, 'POST', '/api/aa', { cellId: aaCell }, { 'idempotency-key': key() });
    const created = await api(h, p, 'POST', '/api/alliances', { name: 'Skywatch', color: '#22aa66' });
    await api(h, p, 'POST', '/api/alliance/invite', { username: 'friend' });
    await api(h, friend, 'POST', `/api/alliances/${created.body.alliance.id}/accept`);
    await fixAt(h, p, HOME.lat, HOME.lon);
    const targets = block(40.6, 0.6, 2, 2);
    const res = await launch(p, await droneOf(p), targets);
    await advance(h, res.body.returnAt - h.clock.now());
    expect((await missionRow(p)).status).toBe('completed');
  });

  it('re-arms an enemy battery when an alliance breaks up mid-flight', async () => {
    const p = await registerPlayer(h, 'pilot');
    const friend = await registerPlayer(h, 'friend');
    const created = await api(h, p, 'POST', '/api/alliances', { name: 'Shortlived', color: '#aa2266' });
    await api(h, p, 'POST', '/api/alliance/invite', { username: 'friend' });
    await api(h, friend, 'POST', `/api/alliances/${created.body.alliance.id}/accept`);
    const aaCell = cellAt(40.5, 0.5 + 0.03); // near the end of the outbound leg
    await giveCells(h, friend.id, [cellAt(40.55, 0.55)]);
    await giveCells(h, friend.id, [aaCell]);
    await api(h, friend, 'POST', '/api/aa', { cellId: cellAt(40.55, 0.55) }, { 'idempotency-key': key() });
    await fixAt(h, p, HOME.lat, HOME.lon);
    const res = await launch(p, await droneOf(p), block(40.6, 0.6, 1, 1));
    await advance(h, 60_000);
    await api(h, friend, 'POST', '/api/alliance/leave');
    await advance(h, res.body.returnAt - h.clock.now());
    expect((await missionRow(p)).status).toBe('destroyed');
  });

  it('charges once for a retried purchase (idempotency)', async () => {
    const p = await registerPlayer(h, 'buyer');
    const k = key();
    const a = await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': k });
    const b = await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': k });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect((await api(h, p, 'GET', '/api/me')).body.credits).toBe(500);
    // a new key is a new purchase
    expect((await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': key() })).status).toBe(201);
    expect((await api(h, p, 'POST', '/api/drones', { type: 'basic' }, { 'idempotency-key': key() })).body.error).toBe(
      'insufficient_credits',
    );
    expect((await api(h, p, 'GET', '/api/drones')).body.drones).toHaveLength(3);
  });
});

describe('drone persistence', () => {
  it('finishes a mission launched before a server restart', async () => {
    const p = await registerPlayer(h, 'pilot');
    await fixAt(h, p, HOME.lat, HOME.lon);
    const targets = block(40.6, 0.6, 2, 2);
    const res = await launch(p, await droneOf(p), targets);
    expect(res.status).toBe(201);
    const clock = h.clock;
    await h.close();
    clock.advance(2 * 3600_000); // server was down through arrival and return
    h = await harness({ reset: false, clock });
    expect(await h.services.scheduler.runDue()).toBeGreaterThanOrEqual(2);
    for (const c of targets) expect(await ownerOf(h, c)).toBe(p.id);
    // captured at arrival time, so income counts from then
    const parcelRow = (await h.pool.query('SELECT acquired_at FROM parcels WHERE cell_id = $1', [targets[0]])).rows[0];
    expect(parcelRow.acquired_at.getTime()).toBe(res.body.arriveAt);
    expect((await missionRow(p)).status).toBe('completed');
  });
});
