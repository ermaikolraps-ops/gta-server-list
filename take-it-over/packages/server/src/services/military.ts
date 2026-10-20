import {
  type AaDto,
  type ArmyDto,
  type BaseDto,
  type CellId,
  cellAt,
  cellCenter,
  compositionPower,
  distanceM,
  emptyComposition,
  headcount,
  isValidCellId,
  type LatLon,
  UNIT_TYPES,
  type UnitType,
} from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable, Tx } from '../db/pool';
import { GameError } from '../errors';
import { idempotent, type Outcome } from '../idempotency';
import type { Outbox } from '../outbox';
import type { Scheduler } from '../scheduler';
import {
  type ArmyRow,
  checkLandRoute,
  costOfUnits,
  friendlyIds,
  healthOf,
  lockArmy,
  parseUnits,
  repairCost,
  requireIdle,
  unitsJson,
  validUnitsInput,
} from './common';
import type { DroneService } from './drones';
import { grant, lockPlayers, spend } from './economy';
import type { GpsService } from './gps';

/**
 * Bases, AA batteries, recruitment, expeditionary forces, army movement and
 * repairs. Armies are aggregates (counts + damage per unit type), never
 * individual soldiers.
 */
export class MilitaryService {
  constructor(
    private readonly ctx: GameContext,
    private readonly scheduler: Scheduler,
    private readonly gps: GpsService,
    private readonly drones: DroneService,
  ) {
    scheduler.register('army_arrive', (tx, job, out) => this.onArrive(tx, job.ref, job.runAt, out));
    scheduler.register('repair_done', (tx, job, out) => this.onRepairDone(tx, job.ref, job.runAt, out));
  }

  // ----------------------------------------------------------------- views

  async armyDtos(db: Queryable, rows: ArmyRow[]): Promise<ArmyDto[]> {
    if (!rows.length) return [];
    const cells = rows.map((r) => cellAt(r.lat, r.lon));
    const bases = await db.query<{ id: string; cell_id: string }>(
      'SELECT id, cell_id FROM bases WHERE cell_id = ANY($1::bigint[])',
      [cells],
    );
    const baseByCell = new Map(bases.rows.map((b) => [Number(b.cell_id), b.id]));
    const repairs = await db.query<{ army_id: string; base_id: string; finishes_at: Date; cost: number }>(
      'SELECT army_id, base_id, finishes_at, cost FROM repairs WHERE army_id = ANY($1::uuid[])',
      [rows.map((r) => r.id)],
    );
    const repairByArmy = new Map(repairs.rows.map((r) => [r.army_id, r]));
    return rows.map((r, i) => {
      const units = parseUnits(r.units);
      const rep = repairByArmy.get(r.id);
      return {
        id: r.id,
        status: r.status,
        lat: r.lat,
        lon: r.lon,
        units,
        headcount: headcount(units),
        power: compositionPower(units, this.ctx.params),
        health: healthOf(units, this.ctx),
        movement:
          r.depart_at && r.arrive_at && r.to_lat !== null
            ? {
                from: { lat: r.from_lat!, lon: r.from_lon! },
                to: { lat: r.to_lat, lon: r.to_lon! },
                departAt: r.depart_at.getTime(),
                arriveAt: r.arrive_at.getTime(),
              }
            : null,
        warId: r.war_id,
        warSide: r.war_side,
        shipId: r.ship_id,
        repair: rep ? { baseId: rep.base_id, finishesAt: rep.finishes_at.getTime(), cost: rep.cost } : null,
        baseId: baseByCell.get(cells[i]!) ?? null,
      };
    });
  }

  async listArmies(playerId: string): Promise<ArmyDto[]> {
    const rows = await this.ctx.pool.query<ArmyRow>('SELECT * FROM armies WHERE owner_id = $1 ORDER BY created_at, id', [
      playerId,
    ]);
    return this.armyDtos(this.ctx.pool, rows.rows);
  }

  /** Own bases plus allied ones (allies may repair at each other's bases). */
  async listBases(playerId: string): Promise<BaseDto[]> {
    const friends = [...(await friendlyIds(this.ctx.pool, playerId))];
    const res = await this.ctx.pool.query<{ id: string; cell_id: string; lat: number; lon: number; owner_id: string; username: string }>(
      `SELECT b.id, b.cell_id, b.lat, b.lon, b.owner_id, p.username
         FROM bases b JOIN players p ON p.id = b.owner_id
        WHERE b.owner_id = ANY($1::uuid[]) ORDER BY b.created_at, b.id`,
      [friends],
    );
    return res.rows.map((b) => ({
      id: b.id,
      cellId: Number(b.cell_id),
      lat: b.lat,
      lon: b.lon,
      ownerId: b.owner_id,
      ownerName: b.username,
      mine: b.owner_id === playerId,
    }));
  }

  async listAa(playerId: string): Promise<AaDto[]> {
    const res = await this.ctx.pool.query<{ id: string; cell_id: string; lat: number; lon: number }>(
      'SELECT id, cell_id, lat, lon FROM aa_batteries WHERE owner_id = $1 ORDER BY created_at, id',
      [playerId],
    );
    return res.rows.map((r) => ({ id: r.id, cellId: Number(r.cell_id), lat: r.lat, lon: r.lon }));
  }

  // ------------------------------------------------------------- structures

  private async requireOwnCell(tx: Tx, playerId: string, cellId: number): Promise<void> {
    if (!isValidCellId(cellId)) throw new GameError('bad_cell', 'invalid cell', 400);
    const own = await tx.query('SELECT 1 FROM parcels WHERE cell_id = $1 AND owner_id = $2 FOR UPDATE', [cellId, playerId]);
    if (!own.rowCount) throw new GameError('not_your_territory', 'you can only build on your own territory', 409);
    const war = await tx.query('SELECT 1 FROM war_cells WHERE cell_id = $1', [cellId]);
    if (war.rowCount) throw new GameError('under_attack', 'you cannot build on a parcel under attack', 409);
  }

  async buildBase(playerId: string, cellId: number, key: string | undefined): Promise<Outcome<BaseDto>> {
    return idempotent(this.ctx, playerId, key, 'build_base', async (tx) => {
      const now = this.ctx.clock.now();
      await this.requireOwnCell(tx, playerId, cellId);
      const c = cellCenter(cellId);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO bases (owner_id, cell_id, lat, lon, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cell_id) DO NOTHING RETURNING id`,
        [playerId, cellId, c.lat, c.lon, new Date(now)],
      );
      if (!ins.rows[0]) throw new GameError('already_built', 'there is already a base here', 409);
      await spend(tx, this.ctx, playerId, this.ctx.params.bases.price, 'build_base', String(cellId), now);
      const name = await tx.query<{ username: string }>('SELECT username FROM players WHERE id = $1', [playerId]);
      return {
        status: 201,
        body: { id: ins.rows[0].id, cellId, lat: c.lat, lon: c.lon, ownerId: playerId, ownerName: name.rows[0]!.username, mine: true },
      };
    });
  }

  async buildAa(playerId: string, cellId: number, key: string | undefined): Promise<Outcome<AaDto>> {
    return idempotent(this.ctx, playerId, key, 'build_aa', async (tx) => {
      const now = this.ctx.clock.now();
      await this.requireOwnCell(tx, playerId, cellId);
      const c = cellCenter(cellId);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO aa_batteries (owner_id, cell_id, lat, lon, geog, created_at)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5)
         ON CONFLICT (cell_id) DO NOTHING RETURNING id`,
        [playerId, cellId, c.lat, c.lon, new Date(now)],
      );
      if (!ins.rows[0]) throw new GameError('already_built', 'there is already an AA battery here', 409);
      await spend(tx, this.ctx, playerId, this.ctx.params.aa.price, 'build_aa', String(cellId), now);
      // Drones already in flight may now cross this battery's radius.
      await this.drones.recompute(tx, now, { near: c });
      return { status: 201, body: { id: ins.rows[0].id, cellId, lat: c.lat, lon: c.lon } };
    });
  }

  /** Removes bases and AA batteries on cells that changed hands. */
  async destroyStructuresIn(tx: Tx, cells: CellId[], at: number, out: Outbox): Promise<void> {
    if (!cells.length) return;
    const bases = await tx.query<{ id: string; owner_id: string }>(
      'DELETE FROM bases WHERE cell_id = ANY($1::bigint[]) RETURNING id, owner_id',
      [cells],
    );
    for (const b of bases.rows) await out.notify(tx, b.owner_id, 'bases', 'notify.base.destroyed', {}, at, 'bad');
    const aa = await tx.query<{ id: string; owner_id: string; lat: number; lon: number }>(
      'DELETE FROM aa_batteries WHERE cell_id = ANY($1::bigint[]) RETURNING id, owner_id, lat, lon',
      [cells],
    );
    for (const a of aa.rows) {
      await out.notify(tx, a.owner_id, 'bases', 'notify.aa.destroyed', {}, at, 'bad');
      await this.drones.recompute(tx, at, { near: { lat: a.lat, lon: a.lon } });
    }
  }

  // ------------------------------------------------------------------ armies

  async recruit(
    playerId: string,
    baseId: string,
    units: Partial<Record<UnitType, number>>,
    key: string | undefined,
  ): Promise<Outcome<ArmyDto>> {
    validUnitsInput(units);
    return idempotent(this.ctx, playerId, key, 'recruit', async (tx) => {
      const now = this.ctx.clock.now();
      const base = await tx.query<{ cell_id: string; lat: number; lon: number }>(
        'SELECT cell_id, lat, lon FROM bases WHERE id = $1 AND owner_id = $2',
        [baseId, playerId],
      );
      const b = base.rows[0];
      if (!b) throw new GameError('not_found', 'base not found', 404);
      await spend(tx, this.ctx, playerId, costOfUnits(units, this.ctx), 'recruit', baseId, now);
      // New units join an idle garrison at this base, or form one.
      const garrison = await tx.query<ArmyRow>(
        `SELECT * FROM armies WHERE owner_id = $1 AND status = 'idle' ORDER BY created_at, id FOR UPDATE`,
        [playerId],
      );
      const here = garrison.rows.find((a) => cellAt(a.lat, a.lon) === Number(b.cell_id));
      const comp = here ? parseUnits(here.units) : emptyComposition();
      for (const t of UNIT_TYPES) comp[t].count += units[t] ?? 0;
      let row: ArmyRow;
      if (here) {
        row = (
          await tx.query<ArmyRow>('UPDATE armies SET units = $2 WHERE id = $1 RETURNING *', [here.id, unitsJson(comp)])
        ).rows[0]!;
      } else {
        row = (
          await tx.query<ArmyRow>(
            `INSERT INTO armies (owner_id, units, status, lat, lon, created_at) VALUES ($1, $2, 'idle', $3, $4, $5) RETURNING *`,
            [playerId, unitsJson(comp), b.lat, b.lon, new Date(now)],
          )
        ).rows[0]!;
      }
      return { status: 201, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  /**
   * A player with no territory may buy an army at their real GPS position,
   * without a base, to try to take a first enemy sector.
   */
  async deployExpedition(
    playerId: string,
    units: Partial<Record<UnitType, number>>,
    key: string | undefined,
  ): Promise<Outcome<ArmyDto>> {
    validUnitsInput(units);
    const fix = this.gps.freshFix(playerId);
    if (!fix) throw new GameError('no_fresh_gps', 'a recent accurate GPS fix is required', 409);
    return idempotent(this.ctx, playerId, key, 'expedition', async (tx) => {
      const now = this.ctx.clock.now();
      await lockPlayers(tx, [playerId]);
      const p = await tx.query<{ parcel_count: number }>('SELECT parcel_count FROM players WHERE id = $1', [playerId]);
      if (p.rows[0]!.parcel_count > 0) {
        throw new GameError('has_territory', 'expeditionary forces are only for players without territory', 409);
      }
      const [land] = await this.ctx.land.pointsOnLand([fix]);
      if (!land) throw new GameError('water', 'you must be on land', 409);
      await spend(tx, this.ctx, playerId, costOfUnits(units, this.ctx), 'expedition', null, now);
      const comp = emptyComposition();
      for (const t of UNIT_TYPES) comp[t].count = units[t] ?? 0;
      const row = (
        await tx.query<ArmyRow>(
          `INSERT INTO armies (owner_id, units, status, lat, lon, created_at) VALUES ($1, $2, 'idle', $3, $4, $5) RETURNING *`,
          [playerId, unitsJson(comp), fix.lat, fix.lon, new Date(now)],
        )
      ).rows[0]!;
      return { status: 201, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  /** Starts a timed movement along a validated route; arrival is a durable job. */
  async startMovement(
    tx: Tx,
    army: ArmyRow,
    to: LatLon,
    departAt: number,
    status: 'moving' | 'retreating',
  ): Promise<number> {
    const from = { lat: army.lat, lon: army.lon };
    const ms = Math.ceil((distanceM(from, to) / (this.ctx.params.armies.speedKmh * 1000)) * 3600_000);
    const arriveAt = departAt + ms;
    await tx.query(
      `UPDATE armies SET status = $2, from_lat = $3, from_lon = $4, to_lat = $5, to_lon = $6, depart_at = $7, arrive_at = $8
        WHERE id = $1`,
      [army.id, status, from.lat, from.lon, to.lat, to.lon, new Date(departAt), new Date(arriveAt)],
    );
    await this.scheduler.schedule(tx, 'army_arrive', army.id, arriveAt);
    return arriveAt;
  }

  async moveArmy(playerId: string, armyId: string, to: LatLon, key: string | undefined): Promise<Outcome<ArmyDto>> {
    return idempotent(this.ctx, playerId, key, 'move_army', async (tx) => {
      const now = this.ctx.clock.now();
      const army = await lockArmy(tx, armyId, playerId);
      requireIdle(army);
      const route = await checkLandRoute(tx, this.ctx, playerId, army, to, {
        maxM: this.ctx.params.armies.operationalRadiusKm * 1000,
      });
      if (!route.ok) throw new GameError(route.problem === 'too_far' ? 'out_of_range' : 'no_route', 'no valid route', 409, { problem: route.problem });
      await this.startMovement(tx, army, to, now, 'moving');
      const row = await lockArmy(tx, armyId);
      return { status: 200, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  private async onArrive(tx: Tx, armyId: string, at: number, out: Outbox): Promise<void> {
    const res = await tx.query<ArmyRow>('SELECT * FROM armies WHERE id = $1 FOR UPDATE', [armyId]);
    const a = res.rows[0];
    if (!a || (a.status !== 'moving' && a.status !== 'retreating') || a.arrive_at?.getTime() !== at) return;
    await tx.query(
      `UPDATE armies SET status = 'idle', lat = to_lat, lon = to_lon,
              from_lat = NULL, from_lon = NULL, to_lat = NULL, to_lon = NULL, depart_at = NULL, arrive_at = NULL
        WHERE id = $1`,
      [armyId],
    );
    out.push(a.owner_id, { type: 'army_update', armyId });
    await out.notify(tx, a.owner_id, 'armies', 'notify.army.arrived', {}, at);
  }

  async splitArmy(
    playerId: string,
    armyId: string,
    units: Partial<Record<UnitType, number>>,
    key: string | undefined,
  ): Promise<Outcome<ArmyDto>> {
    validUnitsInput(units);
    return idempotent(this.ctx, playerId, key, 'split_army', async (tx) => {
      const now = this.ctx.clock.now();
      const army = await lockArmy(tx, armyId, playerId);
      requireIdle(army);
      const comp = parseUnits(army.units);
      const part = emptyComposition();
      for (const t of UNIT_TYPES) {
        const n = units[t] ?? 0;
        if (n > comp[t].count) throw new GameError('bad_units', 'not enough units to split off', 409);
        // Damage moves with the units, in proportion.
        const dmg = comp[t].count ? (comp[t].damage * n) / comp[t].count : 0;
        part[t] = { count: n, damage: dmg };
        comp[t] = { count: comp[t].count - n, damage: comp[t].damage - dmg };
      }
      if (headcount(comp) === 0) throw new GameError('bad_units', 'leave at least one unit behind', 409);
      await tx.query('UPDATE armies SET units = $2 WHERE id = $1', [armyId, unitsJson(comp)]);
      const row = (
        await tx.query<ArmyRow>(
          `INSERT INTO armies (owner_id, units, status, lat, lon, created_at) VALUES ($1, $2, 'idle', $3, $4, $5) RETURNING *`,
          [playerId, unitsJson(part), army.lat, army.lon, new Date(now)],
        )
      ).rows[0]!;
      return { status: 201, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  async mergeArmies(playerId: string, armyId: string, otherId: string, key: string | undefined): Promise<Outcome<ArmyDto>> {
    if (armyId === otherId) throw new GameError('bad_request', 'cannot merge an army with itself', 400);
    return idempotent(this.ctx, playerId, key, 'merge_army', async (tx) => {
      const [first, second] = [armyId, otherId].sort();
      const a1 = await lockArmy(tx, first!, playerId);
      const a2 = await lockArmy(tx, second!, playerId);
      const keep = a1.id === armyId ? a1 : a2;
      const other = a1.id === armyId ? a2 : a1;
      requireIdle(keep);
      requireIdle(other);
      if (cellAt(keep.lat, keep.lon) !== cellAt(other.lat, other.lon)) {
        throw new GameError('not_together', 'armies must be in the same parcel to merge', 409);
      }
      const c = parseUnits(keep.units);
      const d = parseUnits(other.units);
      for (const t of UNIT_TYPES) c[t] = { count: c[t].count + d[t].count, damage: c[t].damage + d[t].damage };
      await tx.query('DELETE FROM armies WHERE id = $1', [other.id]);
      const row = (await tx.query<ArmyRow>('UPDATE armies SET units = $2 WHERE id = $1 RETURNING *', [keep.id, unitsJson(c)]))
        .rows[0]!;
      return { status: 200, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  // ----------------------------------------------------------------- repairs

  /** Repairs take 30 minutes at an own or allied base; the price is proportional to damage. */
  async startRepair(playerId: string, armyId: string, key: string | undefined): Promise<Outcome<ArmyDto>> {
    return idempotent(this.ctx, playerId, key, 'repair', async (tx) => {
      const now = this.ctx.clock.now();
      const army = await lockArmy(tx, armyId, playerId);
      requireIdle(army);
      const friends = [...(await friendlyIds(tx, playerId))];
      const base = await tx.query<{ id: string }>(
        'SELECT id FROM bases WHERE cell_id = $1 AND owner_id = ANY($2::uuid[])',
        [cellAt(army.lat, army.lon), friends],
      );
      const baseId = base.rows[0]?.id;
      if (!baseId) throw new GameError('no_base', 'repairs need an own or allied base', 409);
      const cost = repairCost(parseUnits(army.units), this.ctx);
      if (cost <= 0) throw new GameError('nothing_to_repair', 'this army is not damaged', 409);
      await spend(tx, this.ctx, playerId, cost, 'repair', armyId, now);
      const finishesAt = now + this.ctx.params.bases.repairMinutes * 60_000;
      await tx.query(
        `INSERT INTO repairs (army_id, base_id, owner_id, cost, started_at, finishes_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [armyId, baseId, playerId, cost, new Date(now), new Date(finishesAt)],
      );
      await tx.query(`UPDATE armies SET status = 'repairing' WHERE id = $1`, [armyId]);
      await this.scheduler.schedule(tx, 'repair_done', armyId, finishesAt);
      const row = await lockArmy(tx, armyId);
      return { status: 201, body: (await this.armyDtos(tx, [row]))[0]! };
    });
  }

  private async onRepairDone(tx: Tx, armyId: string, at: number, out: Outbox): Promise<void> {
    const rep = await tx.query<{ owner_id: string }>('DELETE FROM repairs WHERE army_id = $1 RETURNING owner_id', [armyId]);
    if (!rep.rows[0]) return; // cancelled by an attack
    const army = await lockArmy(tx, armyId);
    const c = parseUnits(army.units);
    for (const t of UNIT_TYPES) c[t].damage = 0;
    await tx.query(`UPDATE armies SET units = $2, status = 'idle' WHERE id = $1`, [armyId, unitsJson(c)]);
    out.push(army.owner_id, { type: 'army_update', armyId });
    await out.notify(tx, army.owner_id, 'bases', 'notify.repair.done', {}, at, 'good');
  }

  /**
   * An attack on a base cancels its repairs at once with no progress kept;
   * the troops defend with their current damage.
   */
  async cancelRepairsAt(tx: Tx, baseIds: string[], at: number, out: Outbox): Promise<string[]> {
    if (!baseIds.length) return [];
    const res = await tx.query<{ army_id: string; owner_id: string; cost: number }>(
      'DELETE FROM repairs WHERE base_id = ANY($1::uuid[]) RETURNING army_id, owner_id, cost',
      [baseIds],
    );
    for (const r of res.rows) {
      await tx.query(`UPDATE armies SET status = 'idle' WHERE id = $1 AND status = 'repairing'`, [r.army_id]);
      await this.scheduler.cancel(tx, 'repair_done', r.army_id);
      const refund = Math.floor(r.cost * this.ctx.params.bases.repairCancelRefundFraction);
      if (refund > 0) await grant(tx, this.ctx, r.owner_id, refund, 'repair_refund', r.army_id, at);
      await out.notify(tx, r.owner_id, 'bases', 'notify.repair.cancelled', {}, at, 'bad');
    }
    return res.rows.map((r) => r.army_id);
  }
}
