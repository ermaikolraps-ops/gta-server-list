import { cellAt, cellCenter } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
  registerPlayer,
  resetGameTables,
  T0,
} from './helpers';

let h: Harness;
beforeEach(async () => {
  if (!h) h = await harness();
  else await resetGameTables(h.pool);
  h.clock.set(T0);
  h.services.gps['presence'].clear();
});
afterAll(async () => h.close());

const post = (p: Parameters<typeof api>[1], url: string, body?: unknown) =>
  api(h, p, 'POST', url, body ?? {}, { 'idempotency-key': key() });

describe('bases and recruitment', () => {
  it('builds bases only on own territory and recruits into a garrison', async () => {
    const p = await registerPlayer(h, 'builder');
    const cell = cellAt(40.3, 0.3);
    expect((await post(p, '/api/bases', { cellId: cell })).body.error).toBe('not_your_territory');
    await giveCells(h, p.id, [cell]);
    const base = await post(p, '/api/bases', { cellId: cell });
    expect(base.status).toBe(201);
    expect((await post(p, '/api/bases', { cellId: cell })).body.error).toBe('already_built');
    expect((await api(h, p, 'GET', '/api/me')).body.credits).toBe(1000 - 250);

    const r1 = await post(p, `/api/bases/${base.body.id}/recruit`, { units: { infantry: 100, armor: 10 } });
    expect(r1.status).toBe(201);
    expect(r1.body.units.infantry.count).toBe(100);
    expect(r1.body.baseId).toBe(base.body.id);
    const r2 = await post(p, `/api/bases/${base.body.id}/recruit`, { units: { infantry: 50 } });
    expect(r2.body.id).toBe(r1.body.id); // same garrison
    expect(r2.body.units.infantry.count).toBe(150);
    expect((await api(h, p, 'GET', '/api/me')).body.credits).toBe(750 - (100 * 1 + 10 * 9) - 50);
    expect((await post(p, `/api/bases/${base.body.id}/recruit`, { units: { armor: 1000 } })).body.error).toBe(
      'insufficient_credits',
    );
    expect((await post(p, `/api/bases/${base.body.id}/recruit`, { units: { infantry: -1 } })).status).toBe(400);
  });

  it('lets territory-less players deploy an expeditionary force at their real position', async () => {
    const p = await registerPlayer(h, 'nomad');
    expect((await post(p, '/api/armies/expedition', { units: { infantry: 100 } })).body.error).toBe('no_fresh_gps');
    await fixAt(h, p, 40.3, 0.3);
    const dep = await post(p, '/api/armies/expedition', { units: { infantry: 100 } });
    expect(dep.status).toBe(201);
    expect(dep.body.lat).toBeCloseTo(40.3, 6);
    await giveCells(h, p.id, [cellAt(40.9, 0.9)]);
    await fixAt(h, p, 40.3, 0.3);
    expect((await post(p, '/api/armies/expedition', { units: { infantry: 1 } })).body.error).toBe('has_territory');
  });
});

describe('army movement', () => {
  it('marches at 100 km/h over neutral and own land', async () => {
    const p = await registerPlayer(h, 'marcher');
    const id = await armyAt(h, p.id, 40.3, 0.3, { infantry: 10 });
    const res = await post(p, `/api/armies/${id}/move`, { lat: 40.3, lon: 0.42 }); // ~10.2 km
    expect(res.status).toBe(200);
    const ms = res.body.movement.arriveAt - res.body.movement.departAt;
    expect(ms / 60_000).toBeCloseTo(6.1, 0);
    expect((await post(p, `/api/armies/${id}/move`, { lat: 40.3, lon: 0.5 })).body.error).toBe('army_busy');
    await advance(h, ms);
    const row = await armyRow(h, id);
    expect(row.status).toBe('idle');
    expect(row.lon).toBeCloseTo(0.42, 6);
  });

  it('refuses routes over water, through foreign territory or beyond 100 km', async () => {
    const p = await registerPlayer(h, 'marcher');
    const rival = await registerPlayer(h, 'wall');
    const id = await armyAt(h, p.id, 40.51, 0.48, { infantry: 10 });
    const lake = await post(p, `/api/armies/${id}/move`, { lat: 40.51, lon: 0.54 });
    expect(lake.body).toMatchObject({ error: 'no_route', problem: 'water' });
    await giveCells(h, rival.id, block(40.45, 0.474, 1, 10)); // an east–west wall across the path
    const wall = await post(p, `/api/armies/${id}/move`, { lat: 40.4, lon: 0.48 });
    expect(wall.body).toMatchObject({ error: 'no_route', problem: 'foreign_territory' });
    expect((await post(p, `/api/armies/${id}/move`, { lat: 40.51, lon: 0.48 + 1.3 })).body.error).toBe('out_of_range');
    // through an ally's land is fine
    const a = await api(h, p, 'POST', '/api/alliances', { name: 'Open Gates', color: '#3366ff' });
    await api(h, p, 'POST', '/api/alliance/invite', { username: 'wall' });
    await api(h, rival, 'POST', `/api/alliances/${a.body.alliance.id}/accept`);
    expect((await post(p, `/api/armies/${id}/move`, { lat: 40.4, lon: 0.48 })).status).toBe(200);
  });

  it('splits and merges armies without losing damage', async () => {
    const p = await registerPlayer(h, 'splitter');
    const id = await armyAt(h, p.id, 40.3, 0.3, { infantry: 100, armor: 10 });
    await h.pool.query(`UPDATE armies SET units = jsonb_set(units, '{infantry,damage}', '200') WHERE id = $1`, [id]);
    const part = await post(p, `/api/armies/${id}/split`, { units: { infantry: 25 } });
    expect(part.status).toBe(201);
    expect(part.body.units.infantry).toEqual({ count: 25, damage: 50 });
    expect((await post(p, `/api/armies/${id}/split`, { units: { infantry: 75, armor: 10 } })).body.error).toBe('bad_units');
    const merged = await post(p, `/api/armies/${id}/merge`, { otherId: part.body.id });
    expect(merged.body.units.infantry).toEqual({ count: 100, damage: 200 });
    expect(await armyRow(h, part.body.id)).toBeUndefined();
  });
});

describe('repairs', () => {
  async function damagedArmyAtBase(owner: { id: string }, baseOwner: { id: string; cookie: string; name: string }) {
    const cell = cellAt(40.3, 0.3);
    await giveCells(h, baseOwner.id, [cell]);
    const base = await post(baseOwner, '/api/bases', { cellId: cell });
    const c = cellCenter(cell);
    const id = await armyAt(h, owner.id, c.lat, c.lon, { infantry: 100, armor: 10 });
    await h.pool.query(
      `UPDATE armies SET units = jsonb_set(jsonb_set(units, '{infantry,damage}', '500'), '{armor,damage}', '70') WHERE id = $1`,
      [id],
    );
    return { id, baseId: base.body.id as string };
  }

  it('repairs damage in 30 minutes for a price proportional to the damage', async () => {
    const p = await registerPlayer(h, 'medic');
    const { id } = await damagedArmyAtBase(p, p);
    const before = (await api(h, p, 'GET', '/api/me')).body.credits;
    const res = await post(p, `/api/armies/${id}/repair`);
    expect(res.status).toBe(201);
    // infantry: 500/10 hp × 1 credit × 0.5 = 25; armor: 70/35 × 9 × 0.5 = 9
    expect(res.body.repair.cost).toBe(34);
    expect((await api(h, p, 'GET', '/api/me')).body.credits).toBe(before - 34);
    await advance(h, 29 * 60_000);
    expect((await armyRow(h, id)).status).toBe('repairing');
    await advance(h, 60_000);
    const row = await armyRow(h, id);
    expect(row.status).toBe('idle');
    expect(row.units.infantry.damage).toBe(0);
    expect(row.units.armor.damage).toBe(0);
    expect((await post(p, `/api/armies/${id}/repair`)).body.error).toBe('nothing_to_repair');
  });

  it('works at allied bases but not away from a base', async () => {
    const p = await registerPlayer(h, 'guest');
    const host = await registerPlayer(h, 'host');
    await giveCredits(h, host.id, 1000);
    const { id } = await damagedArmyAtBase(p, host);
    expect((await post(p, `/api/armies/${id}/repair`)).body.error).toBe('no_base');
    const a = await api(h, host, 'POST', '/api/alliances', { name: 'Field Hospital', color: '#ffffff' });
    await api(h, host, 'POST', '/api/alliance/invite', { username: 'guest' });
    await api(h, p, 'POST', `/api/alliances/${a.body.alliance.id}/accept`);
    expect((await post(p, `/api/armies/${id}/repair`)).status).toBe(201);
  });
});
