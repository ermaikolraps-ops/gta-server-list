import { cellAt, cellCenter, distanceM } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  advance,
  api,
  armyAt,
  armyRow,
  block,
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
});
afterAll(async () => h.close());

const post = (p: TestPlayer, url: string, body?: unknown) => api(h, p, 'POST', url, body ?? {}, { 'idempotency-key': key() });
const EAST_COAST = { lat: 40.15, lon: 0.995 }; // mainland, ~420 m from the sea
const ISLAND_COAST = { lat: 40.15, lon: 1.505 }; // island west shore
const WEST_COAST = { lat: 40.15, lon: 0.005 };

async function shipOwner() {
  const p = await registerPlayer(h, 'admiral');
  await giveCredits(h, p.id, 10_000);
  await giveCells(h, p.id, [cellAt(EAST_COAST.lat, EAST_COAST.lon)]);
  const ship = await post(p, '/api/ships', EAST_COAST);
  expect(ship.status).toBe(201);
  return { p, shipId: ship.body.id as string };
}

describe('sea transport', () => {
  it('is bought only on a coast the player holds or stands on', async () => {
    const p = await registerPlayer(h, 'landlubber');
    await giveCredits(h, p.id, 10_000);
    expect((await post(p, '/api/ships', { lat: 40.5, lon: 0.3 })).body.error).toBe('not_coast');
    expect((await post(p, '/api/ships', EAST_COAST)).body.error).toBe('not_your_territory');
    await armyAt(h, p.id, EAST_COAST.lat, EAST_COAST.lon, { infantry: 1 });
    expect((await post(p, '/api/ships', EAST_COAST)).status).toBe(201);
  });

  it('carries an army across the sea at 100 km/h and lands it on a neutral coast', async () => {
    const { p, shipId } = await shipOwner();
    const army = await armyAt(h, p.id, EAST_COAST.lat, EAST_COAST.lon, { infantry: 500, armor: 20 });
    const res = await post(p, `/api/ships/${shipId}/sail`, { destination: ISLAND_COAST, armyId: army });
    expect(res.status).toBe(200);
    const km = distanceM(EAST_COAST, ISLAND_COAST) / 1000;
    expect((res.body.arriveAt - res.body.departAt) / 3600_000).toBeCloseTo(km / 100, 3);
    expect((await armyRow(h, army)).status).toBe('sailing');
    await advance(h, res.body.arriveAt - h.clock.now());
    const landed = await armyRow(h, army);
    expect(landed.status).toBe('idle');
    expect(landed.ship_id).toBeNull();
    expect(distanceM(landed, ISLAND_COAST)).toBeLessThan(1);
    const ships = (await api(h, p, 'GET', '/api/ships')).body.ships;
    expect(ships[0]).toMatchObject({ status: 'idle', cargoArmyId: null });
    // reusable: sail back empty
    expect((await post(p, `/api/ships/${shipId}/sail`, { destination: EAST_COAST })).status).toBe(200);
  });

  it('rejects routes over land, inland destinations and overloaded transports', async () => {
    const { p, shipId } = await shipOwner();
    expect((await post(p, `/api/ships/${shipId}/sail`, { destination: WEST_COAST })).body.error).toBe('no_route');
    // the same trip around the mainland's southern tip is fine
    const around = await post(p, `/api/ships/${shipId}/sail`, {
      waypoints: [
        { lat: 40.15, lon: 1.05 },
        { lat: 39.95, lon: 1.05 },
        { lat: 39.95, lon: -0.05 },
        { lat: 40.15, lon: -0.05 },
      ],
      destination: WEST_COAST,
    });
    expect(around.status).toBe(200);
    await advance(h, around.body.arriveAt - h.clock.now());
    expect((await post(p, `/api/ships/${shipId}/sail`, { destination: { lat: 40.5, lon: 0.5 } })).body.error).toBe('not_coast');
    const big = await armyAt(h, p.id, WEST_COAST.lat, WEST_COAST.lon, { infantry: 10_001 });
    expect(
      (
        await post(p, `/api/ships/${shipId}/sail`, {
          waypoints: [{ lat: 40.15, lon: -0.05 }, { lat: 40.3, lon: -0.05 }],
          destination: { lat: 40.3, lon: 0.005 },
          armyId: big,
        })
      ).body.error,
    ).toBe('over_capacity');
  });

  it('lands on an enemy coast only inside a sector its side is attacking, joining that war', async () => {
    const { p, shipId } = await shipOwner();
    const rival = await registerPlayer(h, 'islander');
    const sector = block(40.15, 1.5, 3, 3);
    await giveCells(h, rival.id, sector);
    const landing = cellCenter(sector[3]!);
    const army = await armyAt(h, p.id, EAST_COAST.lat, EAST_COAST.lon, { infantry: 300 });
    expect((await post(p, `/api/ships/${shipId}/sail`, { destination: landing, armyId: army })).body.error).toBe('enemy_coast');

    await giveCredits(h, rival.id, 1000);
    await post(rival, '/api/aa', { cellId: sector[8] });
    const beachhead = await armyAt(h, p.id, 40.145, 1.52, { infantry: 50 }); // already ashore next to the sector
    const war = await post(p, '/api/wars', { sector, armyIds: [beachhead] });
    expect(war.body.status).toBe('active');
    const voyage = await post(p, `/api/ships/${shipId}/sail`, { destination: landing, armyId: army });
    expect(voyage.status).toBe(200);
    expect((await armyRow(h, army)).status).toBe('at_war');
    await advance(h, voyage.body.arriveAt - h.clock.now());
    const w = (await h.pool.query('SELECT state FROM wars WHERE id = $1', [war.body.id])).rows[0];
    expect(w.state.armies.map((a: { id: string }) => a.id)).toContain(army);
    await advance(h, 180 * 60_000);
    expect(await ownerOf(h, sector[0]!)).toBe(p.id);
  });
});

describe('alliances', () => {
  it('creates, invites, joins, hands over leadership and dissolves', async () => {
    const [a, b, c] = await Promise.all(['leader', 'second', 'third'].map((n) => registerPlayer(h, n)));
    const created = await api(h, a!, 'POST', '/api/alliances', { name: 'Iron Pact', color: '#aa3300' });
    expect(created.body.alliance).toMatchObject({ name: 'Iron Pact', leaderId: a!.id });
    expect((await api(h, b!, 'POST', '/api/alliances', { name: 'iron pact', color: '#000000' })).body.error).toBe('name_taken');
    expect((await api(h, b!, 'POST', `/api/alliances/${created.body.alliance.id}/accept`)).body.error).toBe('no_invite');
    await api(h, a!, 'POST', '/api/alliance/invite', { username: 'second' });
    await api(h, a!, 'POST', '/api/alliance/invite', { username: 'third' });
    expect((await api(h, b!, 'GET', '/api/alliance')).body.invitations).toHaveLength(1);
    await api(h, b!, 'POST', `/api/alliances/${created.body.alliance.id}/accept`);
    h.clock.advance(1000);
    await api(h, c!, 'POST', `/api/alliances/${created.body.alliance.id}/accept`);
    expect((await api(h, b!, 'POST', '/api/alliance/invite', { username: 'leader' })).body.error).toBe('forbidden');

    await giveCells(h, b!.id, [cellAt(40.3, 0.3)]);
    await api(h, a!, 'POST', '/api/alliance/leave');
    const view = (await api(h, b!, 'GET', '/api/alliance')).body.alliance;
    expect(view.leaderId).toBe(b!.id); // longest-serving member takes over
    await api(h, b!, 'POST', '/api/alliance/kick', { playerId: c!.id });
    expect((await api(h, c!, 'GET', '/api/alliance')).body.alliance).toBeNull();
    await api(h, b!, 'POST', '/api/alliance/leave');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM alliances')).rows[0].n).toBe(0);
    expect(await ownerOf(h, cellAt(40.3, 0.3))).toBe(b!.id); // leaving keeps assets
  });

  it('caps alliances at 10 members', async () => {
    const players = [];
    for (let i = 0; i < 11; i++) players.push(await registerPlayer(h, `member${i}`));
    const created = await api(h, players[0]!, 'POST', '/api/alliances', { name: 'Big Ten', color: '#00aa00' });
    for (const p of players.slice(1)) await api(h, players[0]!, 'POST', '/api/alliance/invite', { username: p.name });
    const results = [];
    for (const p of players.slice(1)) results.push(await api(h, p, 'POST', `/api/alliances/${created.body.alliance.id}/accept`));
    expect(results.slice(0, 9).every((r) => r.status === 200)).toBe(true);
    expect(results[9]!.body.error).toBe('alliance_full');
  });

  it('colours territory by alliance on the zoomed-out map', async () => {
    const a = await registerPlayer(h, 'painter');
    await api(h, a, 'POST', '/api/alliances', { name: 'Red Bloc', color: '#ff0000' });
    await giveCells(h, a.id, [cellAt(40.3, 0.3)]);
    const view = await api(h, null, 'GET', '/api/territory?west=-10&south=30&east=10&north=50&zoom=4');
    expect(view.body.owners[0]).toMatchObject({ allianceColor: '#ff0000' });
  });
});

describe('notifications and rankings', () => {
  it('stores notifications and ranks players by prestige only', async () => {
    const a = await registerPlayer(h, 'topdog');
    const b = await registerPlayer(h, 'underdog');
    await giveCells(h, a.id, block(40.3, 0.3, 2, 3));
    await giveCells(h, b.id, block(40.4, 0.4, 1, 2));
    const r = await api(h, b, 'GET', '/api/rankings?metric=territory');
    expect(r.body.rows.map((x: { name: string }) => x.name)).toEqual(['topdog', 'underdog']);
    expect(r.body.me).toEqual({ rank: 2, value: 2 });
    expect((await api(h, b, 'GET', '/api/rankings?metric=wars')).body.rows).toHaveLength(0);

    await api(h, a, 'POST', '/api/alliances', { name: 'Notes', color: '#abcdef' });
    await api(h, a, 'POST', '/api/alliance/invite', { username: 'underdog' });
    const inbox = await api(h, b, 'GET', '/api/notifications');
    expect(inbox.body.unread).toBe(1);
    expect(inbox.body.items[0]).toMatchObject({ category: 'alliance', key: 'notify.alliance.invited', read: false });
    await api(h, b, 'POST', '/api/notifications/read');
    expect((await api(h, b, 'GET', '/api/notifications')).body.unread).toBe(0);
  });
});
