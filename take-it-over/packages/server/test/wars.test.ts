import { cellAt, cellCenter, DEFAULT_PARAMS, mergeParams } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { splitByContribution } from '../src/services/wars';
import {
  advance,
  api,
  armyAt,
  armyRow,
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
  if (!h) h = await harness({ params: mergeParams(DEFAULT_PARAMS, { combat: { variance: 0 } }) });
  else await resetGameTables(h.pool);
  h.clock.set(T0);
  h.services.gps['presence'].clear();
});
afterAll(async () => h.close());

const MIN = 60_000;
const SECTOR = () => block(40.6, 0.6, 5, 5); // 25 parcels
const FRONT = { lat: 40.595, lon: 0.602 }; // ~550 m south of the sector

const post = (p: TestPlayer, url: string, body?: unknown) => api(h, p, 'POST', url, body ?? {}, { 'idempotency-key': key() });
const declare = (p: TestPlayer, sector: number[], armyIds: string[]) => post(p, '/api/wars', { sector, armyIds });
const warRow = async (id: string) => (await h.pool.query('SELECT * FROM wars WHERE id = $1', [id])).rows[0];

async function setup() {
  const att = await registerPlayer(h, 'attacker');
  const def = await registerPlayer(h, 'defender');
  const sector = SECTOR();
  await giveCells(h, def.id, sector);
  await giveCells(h, att.id, block(40.55, 0.55, 3, 3)); // attacker's home, ~6 km away
  return { att, def, sector };
}

describe('declaring war', () => {
  it('takes an undefended sector at once (surrender)', async () => {
    const { att, def, sector } = await setup();
    const base = await post(def, '/api/bases', { cellId: sector[0] });
    expect(base.status).toBe(201);
    const army = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 50 });
    h.clock.advance(3600_000);
    const res = await declare(att, sector, [army]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'finished', winner: 'attacker' });
    expect(res.body.outcome.surrendered).toBe(true);
    for (const c of sector) expect(await ownerOf(h, c)).toBe(att.id);
    expect((await api(h, def, 'GET', '/api/bases')).body.bases).toHaveLength(0); // base destroyed
    // income moved at the moment of conquest
    expect((await api(h, def, 'GET', '/api/me')).body.parcels).toBe(0);
    h.clock.advance(3600_000);
    expect((await api(h, att, 'GET', '/api/me')).body.incomePerHour).toBe(9 + 25);
    expect((await armyRow(h, army)).status).toBe('idle');
  });

  it('does not surrender while an AA battery stands, and fights for exactly 180 minutes', async () => {
    const { att, def, sector } = await setup();
    await post(def, '/api/aa', { cellId: sector[12] });
    const army = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 50 });
    const res = await declare(att, sector, [army]);
    expect(res.body.status).toBe('active');
    expect(res.body.endsAt - res.body.startedAt).toBe(180 * MIN);
    await advance(h, 179 * MIN);
    const mid = await warRow(res.body.id);
    expect(mid.status).toBe('active');
    expect(mid.state.round).toBe(179);
    await advance(h, MIN);
    const end = await warRow(res.body.id);
    expect(end.status).toBe('finished');
    expect(end.state.round).toBe(180);
    expect(end.winner).toBe('attacker');
    expect(await ownerOf(h, sector[12]!)).toBe(att.id);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM aa_batteries')).rows[0].n).toBe(0);
  });

  it('rejects bad sectors and attacks without an army at the front', async () => {
    const { att, def, sector } = await setup();
    const other = await registerPlayer(h, 'third');
    await giveCells(h, other.id, [cellAt(40.61, 0.6)]);
    const army = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 50 });
    const far = await armyAt(h, att.id, 40.3, 0.3, { infantry: 50 });
    expect((await declare(att, [...sector, cellAt(40.61, 0.6)], [army])).body.error).toBe('invalid_sector'); // two owners
    expect((await declare(att, [sector[0]!, sector[24]!], [army])).body.error).toBe('invalid_sector'); // not connected
    expect((await declare(att, block(40.55, 0.55, 3, 3), [army])).body.error).toBe('invalid_sector'); // own land
    expect((await declare(att, block(40.6, 0.6, 11, 10), [army])).status).toBe(400); // > 100 parcels
    expect((await declare(att, sector, [far])).body.error).toBe('no_army_at_front');
    const a = await api(h, def, 'POST', '/api/alliances', { name: 'Pact', color: '#123456' });
    await api(h, def, 'POST', '/api/alliance/invite', { username: 'attacker' });
    await api(h, att, 'POST', `/api/alliances/${a.body.alliance.id}/accept`);
    expect((await declare(att, sector, [army])).body.error).toBe('allied_target');
  });

  it('never lets two wars fight over the same parcel or share an army', async () => {
    const { att, def, sector } = await setup();
    await post(def, '/api/aa', { cellId: sector[0] });
    const a1 = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 50 });
    const a2 = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 50 });
    expect((await declare(att, sector, [a1])).status).toBe(201);
    expect((await declare(att, sector.slice(0, 5), [a2])).body.error).toBe('sector_in_war');
    expect((await declare(att, sector.slice(0, 5), [a1])).body.error).toBe('army_busy');
  });
});

describe('automatic defence and combat', () => {
  it('sends idle defenders within 100 km to the front; they fight from their next full round', async () => {
    const { att, def, sector } = await setup();
    const near = await armyAt(h, def.id, 40.5, 0.6, { infantry: 400 }); // ~11 km away
    const far = await armyAt(h, def.id, 40.3, 0.3 + 1.6, { infantry: 400 }); // across the sea, no land route
    const attacker = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 300, armor: 30 });
    const res = await declare(att, sector, [attacker]);
    expect(res.body.status).toBe('active'); // reinforcements on the way: no surrender
    const n = await armyRow(h, near);
    expect(n.status).toBe('at_war');
    expect(n.war_side).toBe('defender');
    expect((await armyRow(h, far)).status).toBe('idle');
    const arrive = n.arrive_at.getTime();
    await advance(h, arrive - h.clock.now());
    const w = await warRow(res.body.id);
    const joined = w.state.armies.find((a: { id: string }) => a.id === near);
    const expectedRound = Math.ceil((arrive - res.body.startedAt) / MIN) + 1;
    expect(joined.activeFromRound).toBe(expectedRound);
    await advance(h, 180 * MIN);
    const end = await warRow(res.body.id);
    expect(end.status).toBe('finished');
    // permanent casualties and persistent damage written back to the armies
    const att2 = await armyRow(h, attacker);
    if (att2) {
      const total = att2.units.infantry.count + att2.units.armor.count;
      expect(total).toBeLessThan(330);
    }
  });

  it('gives a tie to the defender and sends the attacker back home', async () => {
    const { att, def, sector } = await setup();
    const c = cellCenter(sector[0]!);
    const defender = await armyAt(h, def.id, c.lat, c.lon, { infantry: 200 });
    const attacker = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 200 });
    const res = await declare(att, sector, [attacker]);
    await advance(h, 180 * MIN);
    const w = await warRow(res.body.id);
    expect(w.outcome.power.attacker).toBeCloseTo(w.outcome.power.defender, 6);
    expect(w.winner).toBe('defender');
    for (const cell of sector) expect(await ownerOf(h, cell)).toBe(def.id);
    const a = await armyRow(h, attacker);
    expect(a.status).toBe('retreating');
    expect(w.outcome.retreated).toContain(attacker);
    // casualties are real and survivors keep their wounds
    expect(a.units.infantry.count).toBeLessThan(200);
    expect(a.units.infantry.damage).toBeGreaterThan(0);
    await advance(h, a.arrive_at.getTime() - h.clock.now());
    const home = await armyRow(h, attacker);
    expect(home.status).toBe('idle');
    expect(await ownerOf(h, cellAt(home.lat, home.lon))).toBe(att.id);
    expect((await armyRow(h, defender)).status).toBe('idle');
  });

  it('destroys defeated survivors with nowhere to retreat (failed expedition)', async () => {
    const att = await registerPlayer(h, 'nomad');
    const def = await registerPlayer(h, 'fortress');
    const sector = SECTOR();
    await giveCells(h, def.id, sector);
    const c = cellCenter(sector[12]!);
    await armyAt(h, def.id, c.lat, c.lon, { infantry: 2000, armor: 100 });
    await fixAt(h, att, FRONT.lat, FRONT.lon);
    const exp = await post(att, '/api/armies/expedition', { units: { infantry: 300 } });
    const res = await declare(att, sector, [exp.body.id]);
    await advance(h, 180 * MIN);
    const w = await warRow(res.body.id);
    expect(w.winner).toBe('defender');
    expect(await armyRow(h, exp.body.id)).toBeUndefined();
    expect(w.outcome.destroyedArmies).toContain(exp.body.id);
  });

  it('cancels repairs at an attacked base; troops defend with their current damage', async () => {
    const { att, def, sector } = await setup();
    await giveCredits(h, def.id, 1000);
    const base = await post(def, '/api/bases', { cellId: sector[12] });
    const c = cellCenter(sector[12]!);
    const garrison = await armyAt(h, def.id, c.lat, c.lon, { infantry: 100 });
    await h.pool.query(`UPDATE armies SET units = jsonb_set(units, '{infantry,damage}', '400') WHERE id = $1`, [garrison]);
    expect((await post(def, `/api/armies/${garrison}/repair`)).status).toBe(201);
    const attacker = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 100 });
    const res = await declare(att, sector, [attacker]);
    expect(res.body.status).toBe('active');
    expect((await h.pool.query('SELECT count(*)::int AS n FROM repairs')).rows[0].n).toBe(0);
    const g = await armyRow(h, garrison);
    expect(g.status).toBe('at_war');
    const w = await warRow(res.body.id);
    expect(w.state.armies.find((a: { id: string }) => a.id === garrison).units.infantry.damage).toBe(400);
    const notes = (await api(h, def, 'GET', '/api/notifications')).body.items.map((n: { key: string }) => n.key);
    expect(notes).toContain('notify.repair.cancelled');
    void base;
  });

  it('lets allies reinforce and shares the conquest by contribution', async () => {
    const { att, def, sector } = await setup();
    const ally = await registerPlayer(h, 'ally');
    const a = await api(h, att, 'POST', '/api/alliances', { name: 'Coalition', color: '#ff8800' });
    await api(h, att, 'POST', '/api/alliance/invite', { username: 'ally' });
    await api(h, ally, 'POST', `/api/alliances/${a.body.alliance.id}/accept`);
    await post(def, '/api/aa', { cellId: sector[0] });
    const c = cellCenter(sector[12]!);
    await armyAt(h, def.id, c.lat, c.lon, { infantry: 100 });
    const mine = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 400 });
    const theirs = await armyAt(h, ally.id, 40.58, 0.602, { infantry: 400 }); // ~2.2 km away
    const res = await declare(att, sector, [mine]);
    const r = await post(ally, `/api/wars/${res.body.id}/reinforce`, { armyIds: [theirs] });
    expect(r.status).toBe(200);
    await advance(h, 180 * MIN);
    const w = await warRow(res.body.id);
    expect(w.winner).toBe('attacker');
    const owners = await Promise.all(sector.map((cell) => ownerOf(h, cell)));
    expect(owners.filter((o) => o === att.id).length).toBeGreaterThan(0);
    expect(owners.filter((o) => o === ally.id).length).toBeGreaterThan(0);
    expect(owners.every((o) => o === att.id || o === ally.id)).toBe(true);
  });

  it('shows exact own forces and only an estimate of the enemy', async () => {
    const { att, def, sector } = await setup();
    const c = cellCenter(sector[12]!);
    await armyAt(h, def.id, c.lat, c.lon, { infantry: 1000 });
    const attacker = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 300 });
    const res = await declare(att, sector, [attacker]);
    const view = (await api(h, att, 'GET', `/api/wars/${res.body.id}`)).body;
    expect(view.role).toBe('attacker');
    expect(view.friendly.power).toBeCloseTo(300 * 1.1, 6);
    expect(view.friendly.armies[0]).toMatchObject({ id: attacker, mine: true, headcount: 300 });
    expect(view.enemy.power).toBeUndefined();
    expect(view.enemy.band).toEqual([1024, 2048]); // 1,100 power
    const outsider = await registerPlayer(h, 'outsider');
    expect((await api(h, outsider, 'GET', `/api/wars/${res.body.id}`)).status).toBe(403);
    const pub = await api(h, outsider, 'GET', '/api/wars/public?west=0&south=40&east=1&north=41');
    expect(pub.body.wars).toHaveLength(1);
    expect(pub.body.wars[0].attacker).toBe('attacker');
  });

  it('keeps fighting across a server restart', async () => {
    const { att, def, sector } = await setup();
    await post(def, '/api/aa', { cellId: sector[0] });
    const attacker = await armyAt(h, att.id, FRONT.lat, FRONT.lon, { infantry: 100 });
    const res = await declare(att, sector, [attacker]);
    await advance(h, 30 * MIN);
    const clock = h.clock;
    await h.close();
    clock.advance(200 * MIN);
    h = await harness({ reset: false, clock, params: mergeParams(DEFAULT_PARAMS, { combat: { variance: 0 } }) });
    await h.services.scheduler.runDue();
    const w = await warRow(res.body.id);
    expect(w.status).toBe('finished');
    expect(w.state.round).toBe(180);
    expect(w.finished_at.getTime()).toBe(res.body.endsAt); // resolved at its own end time
  });
});

describe('shared conquest (provisional formula)', () => {
  it('splits parcels by contribution with largest remainder', () => {
    const cells = Array.from({ length: 10 }, (_, i) => i + 1);
    const split = splitByContribution(cells, new Map([['a', 2], ['b', 1]]));
    expect(split.get('a')).toHaveLength(7);
    expect(split.get('b')).toHaveLength(3);
    expect([...split.values()].flat().sort((x, y) => x - y)).toEqual(cells);
  });
});
