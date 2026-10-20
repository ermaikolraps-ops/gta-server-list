import { cellAt, cellCenter } from '@tio/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool';
import { claimNeutralCells } from '../src/services/territory';
import { api, harness, type Harness, registerPlayer } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.close());

describe('territory map', () => {
  it('returns individual cells close up and aggregated zones far away', async () => {
    const a = await registerPlayer(h, 'red');
    const b = await registerPlayer(h, 'blue');
    const mine = Array.from({ length: 20 }, (_, i) => cellAt(40.3, 0.3 + i * 0.0012));
    const theirs = Array.from({ length: 5 }, (_, i) => cellAt(40.302, 0.3 + i * 0.0012));
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, a.id, mine, 'gps', h.clock.now()));
    await withTx(h.pool, (tx) => claimNeutralCells(tx, h.ctx, b.id, theirs, 'gps', h.clock.now()));

    const close = await api(h, null, 'GET', '/api/territory?west=0.29&south=40.29&east=0.33&north=40.31&zoom=15');
    expect(close.body.mode).toBe('cells');
    expect(close.body.cells).toHaveLength(25);
    const ownerNames = close.body.owners.map((o: { name: string }) => o.name).sort();
    expect(ownerNames).toEqual(['blue', 'red']);
    const [cell, idx] = close.body.cells.find((c: number[]) => c[0] === mine[0]);
    expect(close.body.owners[idx].id).toBe(a.id);
    expect(cellCenter(cell).lat).toBeCloseTo(40.3, 2);

    const far = await api(h, null, 'GET', '/api/territory?west=-10&south=30&east=10&north=50&zoom=6');
    expect(far.body.mode).toBe('zones');
    expect(far.body.zones).toHaveLength(1);
    const [, , ownerIdx, total] = far.body.zones[0];
    expect(total).toBe(25);
    expect(far.body.owners[ownerIdx].name).toBe('red'); // dominant owner
  });

  it('handles bboxes across the antimeridian', async () => {
    const res = await api(h, null, 'GET', '/api/territory?west=179.9&south=-17&east=-179.9&north=-16.9&zoom=14');
    expect(res.status).toBe(200);
    const world = await api(h, null, 'GET', '/api/territory?west=170&south=-60&east=-170&north=60&zoom=2');
    expect(world.status).toBe(200);
  });

  it('describes a cell with its land status and owner', async () => {
    const lake = await api(h, null, 'GET', `/api/cells/${cellAt(40.51, 0.51)}`);
    expect(lake.body.land).toBe(false);
    const land = await api(h, null, 'GET', `/api/cells/${cellAt(40.3, 0.3)}`);
    expect(land.body.land).toBe(true);
    expect(land.body.owner.name).toBe('red');
    expect((await api(h, null, 'GET', '/api/cells/-5')).status).toBe(400);
  });
});
