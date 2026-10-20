import {
  type AaSite,
  cellCenter,
  clusterCenter,
  distanceM,
  DRONE_TYPES,
  type DronePreview,
  type DroneType,
  type DroneDto,
  firstInterception,
  type FlightPlan,
  isConnected,
  isValidCellId,
  largestComponent,
  type LatLon,
  type MissionDto,
  planFlight,
  type TargetStatus,
} from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable, Tx } from '../db/pool';
import { GameError } from '../errors';
import { idempotent, type Outcome } from '../idempotency';
import type { Outbox } from '../outbox';
import type { Scheduler } from '../scheduler';
import { lockPlayers, spend } from './economy';
import type { GpsService } from './gps';
import { claimNeutralCells, ownersOf } from './territory';

interface MissionRow {
  id: string;
  drone_id: string;
  owner_id: string;
  launch_lat: number;
  launch_lon: number;
  target_lat: number;
  target_lon: number;
  targets: string[];
  captured: string[];
  launched_at: Date;
  arrive_at: Date;
  return_at: Date;
  status: MissionDto['status'];
  destroyed_at: Date | null;
}

function planOf(m: MissionRow): FlightPlan {
  return {
    launch: { lat: m.launch_lat, lon: m.launch_lon },
    target: { lat: m.target_lat, lon: m.target_lon },
    launchedAt: m.launched_at.getTime(),
    arriveAt: m.arrive_at.getTime(),
    returnAt: m.return_at.getTime(),
  };
}

function missionDto(m: MissionRow): MissionDto {
  return {
    id: m.id,
    droneId: m.drone_id,
    status: m.status,
    launch: { lat: m.launch_lat, lon: m.launch_lon },
    target: { lat: m.target_lat, lon: m.target_lon },
    targets: m.targets.map(Number),
    captured: m.captured.map(Number),
    launchedAt: m.launched_at.getTime(),
    arriveAt: m.arrive_at.getTime(),
    returnAt: m.return_at.getTime(),
    destroyedAt: m.destroyed_at?.getTime() ?? null,
  };
}

/**
 * Drones capture neutral land only and never fight. A mission launches from
 * the player's real (server-held) GPS fix, flies out at 300 km/h, captures the
 * still-neutral targets that form a connected set, and flies home. Hostile AA
 * batteries anywhere along either leg destroy it. Everything is driven by
 * durable jobs, so missions continue with the app closed and across restarts.
 */
export class DroneService {
  constructor(
    private readonly ctx: GameContext,
    private readonly scheduler: Scheduler,
    private readonly gps: GpsService,
  ) {
    scheduler.register('drone_arrive', (tx, job, out) => this.onArrive(tx, job.ref, job.runAt, out));
    scheduler.register('drone_return', (tx, job, out) => this.onReturn(tx, job.ref, job.runAt, out));
    scheduler.register('drone_intercept', (tx, job, out) =>
      this.onIntercept(tx, job.ref, job.runAt, String(job.payload.batteryId), out),
    );
  }

  private radiusKm(type: DroneType): number {
    return this.ctx.params.drones.types[type].radiusKm;
  }

  async list(playerId: string): Promise<{ drones: DroneDto[]; missions: MissionDto[]; maxActive: number }> {
    const drones = await this.ctx.pool.query<{ id: string; type: DroneType; status: DroneDto['status'] }>(
      `SELECT id, type, status FROM drones WHERE owner_id = $1 AND status <> 'destroyed' ORDER BY created_at, id`,
      [playerId],
    );
    const missions = await this.ctx.pool.query<MissionRow>(
      `SELECT * FROM drone_missions WHERE owner_id = $1
        ORDER BY (status IN ('outbound', 'returning')) DESC, launched_at DESC LIMIT 30`,
      [playerId],
    );
    return {
      drones: drones.rows.map((d) => ({ ...d, radiusKm: this.radiusKm(d.type) })),
      missions: missions.rows.map(missionDto),
      maxActive: this.ctx.params.drones.maxActive,
    };
  }

  async buy(playerId: string, type: DroneType, key: string | undefined): Promise<Outcome<DroneDto>> {
    if (!DRONE_TYPES.includes(type)) throw new GameError('bad_request', 'unknown drone type', 400);
    return idempotent(this.ctx, playerId, key, 'buy_drone', async (tx) => {
      const now = this.ctx.clock.now();
      await spend(tx, this.ctx, playerId, this.ctx.params.drones.types[type].price, 'buy_drone', type, now);
      const res = await tx.query<{ id: string }>(
        `INSERT INTO drones (owner_id, type, status, created_at) VALUES ($1, $2, 'idle', $3) RETURNING id`,
        [playerId, type, new Date(now)],
      );
      return { status: 201, body: { id: res.rows[0]!.id, type, status: 'idle', radiusKm: this.radiusKm(type) } };
    });
  }

  /** Checks a target selection without launching (live feedback while selecting). */
  async preview(playerId: string, droneId: string, targets: number[]): Promise<DronePreview> {
    const drone = await this.ctx.pool.query<{ type: DroneType }>(
      'SELECT type FROM drones WHERE id = $1 AND owner_id = $2',
      [droneId, playerId],
    );
    if (!drone.rows[0]) throw new GameError('not_found', 'drone not found', 404);
    const fix = this.gps.freshFix(playerId);
    return this.validate(this.ctx.pool, targets, fix, this.radiusKm(drone.rows[0].type));
  }

  private async validate(db: Queryable, targets: number[], launch: LatLon | null, radiusKm: number): Promise<DronePreview> {
    const { maxTargets, speedKmh } = this.ctx.params.drones;
    const uniq = [...new Set(targets)];
    if (uniq.some((c) => !isValidCellId(c))) throw new GameError('invalid_targets', 'invalid cell id', 400);
    const land = await this.ctx.land.cellsOnLand(uniq);
    const owners = await ownersOf(db, uniq);
    const cells = uniq.map((cell) => {
      let status: TargetStatus = 'ok';
      if (!land.get(cell)) status = 'water';
      else if (owners.has(cell)) status = 'owned';
      else if (launch && distanceM(launch, cellCenter(cell)) > radiusKm * 1000) status = 'out_of_range';
      return { cell, status };
    });
    const connected = uniq.length > 0 && isConnected(uniq);
    const tooMany = uniq.length > maxTargets;
    const ok = !!launch && connected && !tooMany && cells.every((c) => c.status === 'ok');
    const out: DronePreview = { ok, connected, tooMany, radiusKm, launch, cells };
    if (launch && uniq.length) {
      const plan = planFlight(launch, clusterCenter(uniq), this.ctx.clock.now(), speedKmh);
      out.arriveAt = plan.arriveAt;
      out.returnAt = plan.returnAt;
    }
    return out;
  }

  async launch(playerId: string, droneId: string, targets: number[], key: string | undefined): Promise<Outcome<MissionDto>> {
    // The launch point is the server's own record of the player's live GPS, never a client claim.
    const fix = this.gps.freshFix(playerId);
    if (!fix) throw new GameError('no_fresh_gps', 'a recent GPS fix with 20 m accuracy or better is required', 409);
    return idempotent(this.ctx, playerId, key, 'launch_drone', async (tx) => {
      const now = this.ctx.clock.now();
      await lockPlayers(tx, [playerId]); // serializes the active-drone count
      const drone = await tx.query<{ type: DroneType; status: string }>(
        'SELECT type, status FROM drones WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [droneId, playerId],
      );
      const d = drone.rows[0];
      if (!d) throw new GameError('not_found', 'drone not found', 404);
      if (d.status !== 'idle') throw new GameError('drone_busy', 'that drone is not available', 409);
      const active = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM drones WHERE owner_id = $1 AND status = 'flying'`,
        [playerId],
      );
      if (Number(active.rows[0]!.n) >= this.ctx.params.drones.maxActive) {
        throw new GameError('too_many_active_drones', 'too many drones in flight', 409);
      }
      const check = await this.validate(tx, targets, fix, this.radiusKm(d.type));
      if (!check.ok) throw new GameError('invalid_targets', 'those targets are not valid', 409, { preview: check });
      const cells = check.cells.map((c) => c.cell);
      const plan = planFlight(fix, clusterCenter(cells), now, this.ctx.params.drones.speedKmh);
      const ins = await tx.query<MissionRow>(
        `INSERT INTO drone_missions
           (drone_id, owner_id, launch_lat, launch_lon, target_lat, target_lon, targets, launched_at, arrive_at, return_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'outbound') RETURNING *`,
        [
          droneId,
          playerId,
          fix.lat,
          fix.lon,
          plan.target.lat,
          plan.target.lon,
          cells,
          new Date(now),
          new Date(plan.arriveAt),
          new Date(plan.returnAt),
        ],
      );
      const m = ins.rows[0]!;
      await tx.query(`UPDATE drones SET status = 'flying' WHERE id = $1`, [droneId]);
      await this.scheduler.schedule(tx, 'drone_arrive', m.id, plan.arriveAt);
      await this.scheduler.schedule(tx, 'drone_return', m.id, plan.returnAt);
      await this.scheduleInterception(tx, m, now);
      return { status: 201, body: missionDto(m) };
    });
  }

  /** Hostile AA sites within reach of a mission's path (both legs share one great circle). */
  private async hostileSites(db: Queryable, m: MissionRow): Promise<AaSite[]> {
    const radius = this.ctx.params.aa.radiusKm * 1000;
    const res = await db.query<{ id: string; lat: number; lon: number; created_at: Date }>(
      `SELECT b.id, b.lat, b.lon, b.created_at
         FROM aa_batteries b
         JOIN players o ON o.id = b.owner_id
        WHERE b.owner_id <> $1
          AND (o.alliance_id IS NULL OR o.alliance_id IS DISTINCT FROM (SELECT alliance_id FROM players WHERE id = $1))
          AND ST_DWithin(
                b.geog,
                ST_SetSRID(ST_MakeLine(ST_MakePoint($2, $3), ST_MakePoint($4, $5)), 4326)::geography,
                $6)`,
      [m.owner_id, m.launch_lon, m.launch_lat, m.target_lon, m.target_lat, radius + 100],
    );
    return res.rows.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, createdAt: r.created_at.getTime() }));
  }

  /** (Re)computes the earliest interception of a mission from `fromMs` and schedules it. */
  private async scheduleInterception(tx: Tx, m: MissionRow, fromMs: number): Promise<void> {
    await this.scheduler.cancel(tx, 'drone_intercept', m.id);
    if (m.status !== 'outbound' && m.status !== 'returning') return;
    const hit = firstInterception(planOf(m), await this.hostileSites(tx, m), this.ctx.params.aa.radiusKm * 1000, fromMs);
    if (hit) await this.scheduler.schedule(tx, 'drone_intercept', m.id, hit.at, { batteryId: hit.batteryId });
  }

  /**
   * Re-plans interceptions after the AA map or alliances change. Pass either a
   * point (a battery appeared or vanished there) or a set of players whose
   * relations changed.
   */
  async recompute(tx: Tx, fromMs: number, scope: { near?: LatLon; players?: string[] }): Promise<void> {
    const radius = this.ctx.params.aa.radiusKm * 1000;
    let res;
    if (scope.near) {
      res = await tx.query<MissionRow>(
        `SELECT * FROM drone_missions
          WHERE status IN ('outbound', 'returning')
            AND ST_DWithin(
                  ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                  ST_SetSRID(ST_MakeLine(ST_MakePoint(launch_lon, launch_lat), ST_MakePoint(target_lon, target_lat)), 4326)::geography,
                  $3)
          FOR UPDATE`,
        [scope.near.lon, scope.near.lat, radius + 100],
      );
    } else {
      res = await tx.query<MissionRow>(
        `SELECT * FROM drone_missions WHERE status IN ('outbound', 'returning') AND owner_id = ANY($1::uuid[]) FOR UPDATE`,
        [scope.players ?? []],
      );
    }
    for (const m of res.rows) await this.scheduleInterception(tx, m, fromMs);
  }

  private async lockMission(tx: Tx, id: string): Promise<MissionRow | undefined> {
    return (await tx.query<MissionRow>('SELECT * FROM drone_missions WHERE id = $1 FOR UPDATE', [id])).rows[0];
  }

  private async onArrive(tx: Tx, missionId: string, at: number, out: Outbox): Promise<void> {
    const m = await this.lockMission(tx, missionId);
    if (!m || m.status !== 'outbound') return;
    const targets = m.targets.map(Number);
    const owners = await ownersOf(tx, targets);
    // Targets taken in flight are skipped; only a connected remainder is captured.
    const component = largestComponent(targets.filter((c) => !owners.has(c)));
    const won = await claimNeutralCells(tx, this.ctx, m.owner_id, component, 'drone', at);
    await tx.query(`UPDATE drone_missions SET status = 'returning', captured = $2 WHERE id = $1`, [m.id, won]);
    if (won.length) {
      await tx.query('UPDATE players SET drone_captures = drone_captures + $2 WHERE id = $1', [m.owner_id, won.length]);
    }
    out.push(m.owner_id, { type: 'drone_update', missionId: m.id });
    await out.notify(tx, m.owner_id, 'drones', 'notify.drone.captured', { n: won.length, skipped: targets.length - won.length }, at, won.length ? 'good' : 'info');
  }

  private async onReturn(tx: Tx, missionId: string, at: number, out: Outbox): Promise<void> {
    const m = await this.lockMission(tx, missionId);
    if (!m || (m.status !== 'returning' && m.status !== 'outbound')) return;
    await tx.query(`UPDATE drone_missions SET status = 'completed' WHERE id = $1`, [m.id]);
    await tx.query(`UPDATE drones SET status = 'idle' WHERE id = $1 AND status = 'flying'`, [m.drone_id]);
    out.push(m.owner_id, { type: 'drone_update', missionId: m.id });
    await out.notify(tx, m.owner_id, 'drones', 'notify.drone.returned', {}, at);
  }

  private async onIntercept(tx: Tx, missionId: string, at: number, batteryId: string, out: Outbox): Promise<void> {
    const m = await this.lockMission(tx, missionId);
    if (!m || (m.status !== 'outbound' && m.status !== 'returning')) return;
    // Defensive re-check: the battery must still exist and still be hostile.
    const sites = await this.hostileSites(tx, m);
    if (!sites.some((s) => s.id === batteryId)) {
      await this.scheduleInterception(tx, m, at);
      return;
    }
    await tx.query(
      `UPDATE drone_missions SET status = 'destroyed', destroyed_at = $2, destroyed_by = $3 WHERE id = $1`,
      [m.id, new Date(at), batteryId],
    );
    await tx.query(`UPDATE drones SET status = 'destroyed' WHERE id = $1`, [m.drone_id]);
    await this.scheduler.cancel(tx, 'drone_arrive', m.id);
    await this.scheduler.cancel(tx, 'drone_return', m.id);
    out.push(m.owner_id, { type: 'drone_update', missionId: m.id });
    await out.notify(tx, m.owner_id, 'drones', 'notify.drone.destroyed', {}, at, 'bad');
    const aaOwner = await tx.query<{ owner_id: string }>('SELECT owner_id FROM aa_batteries WHERE id = $1', [batteryId]);
    if (aaOwner.rows[0]) {
      await out.notify(tx, aaOwner.rows[0].owner_id, 'bases', 'notify.aa.shotDown', {}, at, 'good');
    }
  }
}
