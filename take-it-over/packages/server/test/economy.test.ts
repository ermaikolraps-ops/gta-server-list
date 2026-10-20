import { cellAt, creditsToUnits } from '@tio/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool';
import { readBalance, spend } from '../src/services/economy';
import { claimNeutralCells, transferCells } from '../src/services/territory';
import { api, harness, type Harness, registerPlayer, resetGameTables, T0 } from './helpers';

let h: Harness;
beforeEach(async () => {
  if (!h) h = await harness();
  else await resetGameTables(h.pool);
  h.clock.set(T0);
});
afterAll(async () => h.close());

const cells = (n: number, row = 0) => Array.from({ length: n }, (_, i) => cellAt(40.3 + row * 0.001, 0.3 + i * 0.0012));
const balance = async (id: string) => (await readBalance(h.pool, h.ctx, id, h.clock.now())).credits;

describe('economy', () => {
  it('earns 1 credit per parcel per hour, linearly and while offline', async () => {
    const p = await registerPlayer(h, 'player1');
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, p.id, cells(3), 'gps', h.clock.now()));
    h.clock.advance(2 * 3600_000);
    expect(await balance(p.id)).toBe(1006);
    h.clock.advance(30 * 60_000);
    expect((await readBalance(h.pool, h.ctx, p.id, h.clock.now())).fraction).toBeCloseTo(0.5, 6);
    const me = await api(h, p, 'GET', '/api/me');
    expect(me.body.incomePerHour).toBe(3);
    h.clock.advance(1000 * 3600_000);
    expect(await balance(p.id)).toBe(4007); // 1000 + 3 parcels × 1002.5 h, uncapped
  });

  it('does not pay new parcels retroactively', async () => {
    const p = await registerPlayer(h, 'player1');
    h.clock.advance(5 * 3600_000);
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, p.id, cells(10), 'gps', h.clock.now()));
    expect(await balance(p.id)).toBe(1000);
    h.clock.advance(3600_000);
    expect(await balance(p.id)).toBe(1010);
  });

  it('splits income exactly at the moment ownership changes', async () => {
    const a = await registerPlayer(h, 'attacker');
    const b = await registerPlayer(h, 'defender');
    const cs = cells(5);
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, b.id, cs, 'gps', h.clock.now()));
    h.clock.advance(3600_000);
    await withTx(h.pool, (tx) => transferCells(tx, h.ctx, cs.slice(0, 2), b.id, a.id, 'war', h.clock.now()));
    h.clock.advance(3600_000);
    expect(await balance(b.id)).toBe(1000 + 5 + 3);
    expect(await balance(a.id)).toBe(1000 + 2);
    const counts = await h.pool.query(
      'SELECT p.id, p.parcel_count, (SELECT count(*)::int FROM parcels WHERE owner_id = p.id) AS real FROM players p',
    );
    for (const r of counts.rows) expect(r.parcel_count).toBe(r.real);
  });

  it('only transfers parcels the loser still owns', async () => {
    const a = await registerPlayer(h, 'alpha');
    const b = await registerPlayer(h, 'bravo');
    const c = await registerPlayer(h, 'charlie');
    const cs = cells(4);
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, b.id, cs.slice(0, 2), 'gps', h.clock.now()));
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, c.id, cs.slice(2), 'gps', h.clock.now()));
    const moved = await withTx(h.pool, (tx) => transferCells(tx, h.ctx, cs, b.id, a.id, 'war', h.clock.now()));
    expect(moved.sort()).toEqual(cs.slice(0, 2).sort());
  });

  it('refuses to overspend and leaves the balance untouched', async () => {
    const p = await registerPlayer(h, 'player1');
    await expect(withTx(h.pool, (tx) => spend(tx, h.ctx, p.id, 1001, 'test', null, h.clock.now()))).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    expect(await balance(p.id)).toBe(1000);
  });

  it('prevents double spending under concurrency', async () => {
    const p = await registerPlayer(h, 'player1');
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => withTx(h.pool, (tx) => spend(tx, h.ctx, p.id, 400, 'test', null, h.clock.now()))),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(2);
    expect(await balance(p.id)).toBe(200);
    const ledger = await h.pool.query("SELECT sum(delta_units)::text AS s FROM ledger WHERE player_id = $1", [p.id]);
    expect(BigInt(ledger.rows[0].s)).toBe(creditsToUnits(200));
  });

  it('never claims the same cell twice under concurrency', async () => {
    const players = await Promise.all(['racer1', 'racer2', 'racer3', 'racer4'].map((n) => registerPlayer(h, n)));
    const cell = cells(1)[0]!;
    const results = await Promise.all(
      players.map((p) => withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, p.id, [cell], 'gps', h.clock.now()))),
    );
    expect(results.filter((r) => r.length === 1)).toHaveLength(1);
    const total = await h.pool.query('SELECT sum(parcel_count)::int AS s FROM players');
    expect(total.rows[0].s).toBe(1);
  });
});
