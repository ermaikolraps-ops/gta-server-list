import { cellAt, distanceM, headcount, type LatLon, type ShipDto } from '@tio/shared';
import type { GameContext } from '../context';
import type { Tx } from '../db/pool';
import { GameError } from '../errors';
import { idempotent, type Outcome } from '../idempotency';
import type { Outbox } from '../outbox';
import type { Scheduler } from '../scheduler';
import { alliancesOf, type ArmyRow, checkSeaRoute, friendlyWith, isCoastal, lockArmy, parseUnits, requireIdle } from './common';
import { spend } from './economy';

interface ShipRow {
  id: string;
  owner_id: string;
  status: 'idle' | 'sailing';
  lat: number;
  lon: number;
  route: LatLon[] | null;
  depart_at: Date | null;
  arrive_at: Date | null;
}

/**
 * Reusable sea transports: 100 km/h, 10,000 units, embark from any coast, no
 * ports. Routes are great-circle legs through player-chosen waypoints and are
 * verified to stay on water; travel time follows the real distance. Ships are
 * invulnerable at sea and land their troops instantly.
 */
export class ShipService {
  constructor(
    private readonly ctx: GameContext,
    private readonly scheduler: Scheduler,
  ) {
    scheduler.register('ship_arrive', (tx, job, out) => this.onArrive(tx, job.ref, job.runAt, out));
  }

  async list(playerId: string): Promise<ShipDto[]> {
    const ships = await this.ctx.pool.query<ShipRow>('SELECT * FROM ships WHERE owner_id = $1 ORDER BY created_at, id', [playerId]);
    const cargo = await this.ctx.pool.query<{ id: string; ship_id: string }>(
      'SELECT id, ship_id FROM armies WHERE ship_id = ANY($1::uuid[])',
      [ships.rows.map((s) => s.id)],
    );
    const byShip = new Map(cargo.rows.map((c) => [c.ship_id, c.id]));
    return ships.rows.map((s) => ({
      id: s.id,
      status: s.status,
      lat: s.lat,
      lon: s.lon,
      route: s.route,
      departAt: s.depart_at?.getTime() ?? null,
      arriveAt: s.arrive_at?.getTime() ?? null,
      cargoArmyId: byShip.get(s.id) ?? null,
    }));
  }

  /** Ships are bought on a coastal point of the player's territory or where one of their armies stands. */
  async buy(playerId: string, at: LatLon, key: string | undefined): Promise<Outcome<ShipDto>> {
    if (!(await isCoastal(this.ctx, at))) throw new GameError('not_coast', 'ships must be bought on a coast', 409);
    return idempotent(this.ctx, playerId, key, 'buy_ship', async (tx) => {
      const now = this.ctx.clock.now();
      const cell = cellAt(at.lat, at.lon);
      const own = await tx.query('SELECT 1 FROM parcels WHERE cell_id = $1 AND owner_id = $2', [cell, playerId]);
      if (!own.rowCount) {
        const armies = await tx.query<{ lat: number; lon: number }>('SELECT lat, lon FROM armies WHERE owner_id = $1 AND status = $2', [
          playerId,
          'idle',
        ]);
        if (!armies.rows.some((a) => cellAt(a.lat, a.lon) === cell)) {
          throw new GameError('not_your_territory', 'buy ships on your own coast or where your army stands', 409);
        }
      }
      await spend(tx, this.ctx, playerId, this.ctx.params.ships.price, 'buy_ship', null, now);
      const res = await tx.query<{ id: string }>(
        `INSERT INTO ships (owner_id, status, lat, lon, created_at) VALUES ($1, 'idle', $2, $3, $4) RETURNING id`,
        [playerId, at.lat, at.lon, new Date(now)],
      );
      return {
        status: 201,
        body: { id: res.rows[0]!.id, status: 'idle', lat: at.lat, lon: at.lon, route: null, departAt: null, arriveAt: null, cargoArmyId: null },
      };
    });
  }

  async sail(
    playerId: string,
    shipId: string,
    waypoints: LatLon[],
    destination: LatLon,
    armyId: string | undefined,
    key: string | undefined,
  ): Promise<Outcome<ShipDto>> {
    if (waypoints.length > 30) throw new GameError('bad_request', 'at most 30 waypoints', 400);
    if (!(await isCoastal(this.ctx, destination))) throw new GameError('not_coast', 'the destination must be a coast', 409);
    return idempotent(this.ctx, playerId, key, 'sail', async (tx) => {
      const now = this.ctx.clock.now();
      const ship = (await tx.query<ShipRow>('SELECT * FROM ships WHERE id = $1 AND owner_id = $2 FOR UPDATE', [shipId, playerId]))
        .rows[0];
      if (!ship) throw new GameError('not_found', 'ship not found', 404);
      if (ship.status !== 'idle') throw new GameError('ship_busy', 'that ship is at sea', 409);
      const start = { lat: ship.lat, lon: ship.lon };
      const route = [start, ...waypoints, destination];
      const check = await checkSeaRoute(this.ctx, route);
      if (!check.ok) throw new GameError('no_route', 'that route crosses land', 409, { problem: check.problem });
      const arriveAt = now + Math.ceil((check.distanceM / (this.ctx.params.ships.speedKmh * 1000)) * 3600_000);

      let army: ArmyRow | null = null;
      let warId: string | null = null;
      if (armyId) {
        army = await lockArmy(tx, armyId, playerId);
        requireIdle(army);
        if (distanceM(army, start) > this.ctx.params.ships.maxCoastDistanceM + 500) {
          throw new GameError('not_together', 'the army must be at the ship to embark', 409);
        }
        if (headcount(parseUnits(army.units)) > this.ctx.params.ships.capacityUnits) {
          throw new GameError('over_capacity', `a transport carries at most ${this.ctx.params.ships.capacityUnits} units`, 409);
        }
        warId = await this.landingWar(tx, playerId, destination);
      }

      await tx.query(
        `UPDATE ships SET status = 'sailing', route = $2, depart_at = $3, arrive_at = $4 WHERE id = $1`,
        [shipId, JSON.stringify(route), new Date(now), new Date(arriveAt)],
      );
      await this.scheduler.schedule(tx, 'ship_arrive', shipId, arriveAt);
      if (army) {
        if (warId) {
          // Landing inside a declared war sector: the army joins that war on landing.
          await tx.query(
            `UPDATE armies SET status = 'at_war', war_id = $2, war_side = 'attacker', ship_id = $3,
                    from_lat = $4, from_lon = $5, to_lat = $6, to_lon = $7, depart_at = $8, arrive_at = $9
              WHERE id = $1`,
            [army.id, warId, shipId, start.lat, start.lon, destination.lat, destination.lon, new Date(now), new Date(arriveAt)],
          );
          await this.scheduler.schedule(tx, 'war_join', army.id, arriveAt, { warId });
        } else {
          await tx.query(
            `UPDATE armies SET status = 'sailing', ship_id = $2,
                    from_lat = $3, from_lon = $4, to_lat = $5, to_lon = $6, depart_at = $7, arrive_at = $8
              WHERE id = $1`,
            [army.id, shipId, start.lat, start.lon, destination.lat, destination.lon, new Date(now), new Date(arriveAt)],
          );
        }
      }
      return {
        status: 200,
        body: { id: shipId, status: 'sailing', lat: ship.lat, lon: ship.lon, route, departAt: now, arriveAt, cargoArmyId: army?.id ?? null },
      };
    });
  }

  /**
   * Troops may land on their own, allied or neutral coast; on an enemy coast
   * only inside a sector of an active war their side declared. Returns that
   * war's id when landing into one.
   */
  private async landingWar(tx: Tx, playerId: string, dest: LatLon): Promise<string | null> {
    const cell = cellAt(dest.lat, dest.lon);
    const owner = (await tx.query<{ owner_id: string }>('SELECT owner_id FROM parcels WHERE cell_id = $1', [cell])).rows[0]
      ?.owner_id;
    if (!owner) return null;
    const rel = await alliancesOf(tx, [playerId, owner]);
    if (friendlyWith(playerId, owner, rel)) return null;
    const war = await tx.query<{ id: string; attacker_id: string; ends_at: Date }>(
      `SELECT w.id, w.attacker_id, w.ends_at FROM war_cells c JOIN wars w ON w.id = c.war_id
        WHERE c.cell_id = $1 AND w.status = 'active'`,
      [cell],
    );
    const w = war.rows[0];
    if (w) {
      const rel2 = await alliancesOf(tx, [playerId, w.attacker_id]);
      if (friendlyWith(playerId, w.attacker_id, rel2)) return w.id;
    }
    throw new GameError('enemy_coast', 'you can only land on an enemy coast inside a sector your side is attacking', 409);
  }

  private async onArrive(tx: Tx, shipId: string, at: number, out: Outbox): Promise<void> {
    const ship = (await tx.query<ShipRow>('SELECT * FROM ships WHERE id = $1 FOR UPDATE', [shipId])).rows[0];
    if (!ship || ship.status !== 'sailing' || ship.arrive_at?.getTime() !== at) return;
    const dest = ship.route![ship.route!.length - 1]!;
    await tx.query(
      `UPDATE ships SET status = 'idle', lat = $2, lon = $3, route = NULL, depart_at = NULL, arrive_at = NULL WHERE id = $1`,
      [shipId, dest.lat, dest.lon],
    );
    const cargo = await tx.query<ArmyRow>('SELECT * FROM armies WHERE ship_id = $1 FOR UPDATE', [shipId]);
    for (const a of cargo.rows) {
      if (a.status === 'at_war') {
        await tx.query('UPDATE armies SET ship_id = NULL WHERE id = $1', [a.id]); // war_join lands it in the battle
      } else {
        await tx.query(
          `UPDATE armies SET status = 'idle', ship_id = NULL, lat = $2, lon = $3,
                  from_lat = NULL, from_lon = NULL, to_lat = NULL, to_lon = NULL, depart_at = NULL, arrive_at = NULL
            WHERE id = $1`,
          [a.id, dest.lat, dest.lon],
        );
      }
    }
    out.push(ship.owner_id, { type: 'army_update', shipId });
    await out.notify(tx, ship.owner_id, 'armies', 'notify.ship.arrived', {}, at);
  }
}
