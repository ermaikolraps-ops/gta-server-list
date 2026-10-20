import {
  addArmy,
  type BattleState,
  type CellId,
  cellAt,
  cellCenter,
  clusterCenter,
  compositionPower,
  createBattle,
  decideOutcome,
  distanceM,
  estimateBand,
  firstFullRound,
  headcount,
  interpolate,
  isConnected,
  isValidCellId,
  type LatLon,
  type PublicWarDto,
  resolveRound,
  seedFromString,
  type Side,
  sidePower,
  type WarDto,
  type WarOutcome,
} from '@tio/shared';
import type { GameContext } from '../context';
import type { Queryable, Tx } from '../db/pool';
import { GameError } from '../errors';
import { idempotent, type Outcome } from '../idempotency';
import { Outbox } from '../outbox';
import type { Scheduler } from '../scheduler';
import {
  alliancesOf,
  type ArmyRow,
  checkLandRoute,
  friendlyIds,
  friendlyWith,
  lockArmy,
  parseUnits,
  requireIdle,
  unitsJson,
} from './common';
import type { MilitaryService } from './military';
import { transferCells } from './territory';

interface WarRow {
  id: string;
  attacker_id: string;
  defender_id: string;
  sector: string[];
  lat: number;
  lon: number;
  status: 'active' | 'finished';
  started_at: Date;
  ends_at: Date;
  state: BattleState;
  initial: Record<string, number>;
  winner: Side | null;
  outcome: WarOutcome | null;
  finished_at: Date | null;
}

const other = (s: Side): Side => (s === 'attacker' ? 'defender' : 'attacker');

function nearestCell(p: LatLon, cells: CellId[]): { cell: CellId; dist: number } {
  let best = { cell: cells[0]!, dist: Infinity };
  for (const c of cells) {
    const d = distanceM(p, cellCenter(c));
    if (d < best.dist) best = { cell: c, dist: d };
  }
  return best;
}

/**
 * Wars over a sector of up to 100 side-connected enemy parcels of one owner.
 * A war lasts exactly 180 minutes with one round per minute, run by durable
 * jobs so it continues across restarts and while everyone is offline.
 */
export class WarService {
  constructor(
    private readonly ctx: GameContext,
    private readonly scheduler: Scheduler,
    private readonly military: MilitaryService,
  ) {
    scheduler.register('war_round', (tx, job, out) => this.onRound(tx, job.ref, Number(job.payload.round), job.runAt, out));
    scheduler.register('war_join', (tx, job, out) => this.onJoin(tx, job.ref, String(job.payload.warId), job.runAt, out));
  }

  private get roundMs(): number {
    return this.ctx.params.war.roundSeconds * 1000;
  }

  private get totalRounds(): number {
    return Math.round((this.ctx.params.war.durationMinutes * 60) / this.ctx.params.war.roundSeconds);
  }

  // -------------------------------------------------------------- declare

  async declare(playerId: string, sector: number[], armyIds: string[], key: string | undefined): Promise<Outcome<WarDto>> {
    const out = new Outbox();
    const result = await this.declareTx(playerId, sector, armyIds, key, out);
    out.flush(this.ctx.events); // only reached if the transaction committed
    return result;
  }

  private async declareTx(
    playerId: string,
    sector: number[],
    armyIds: string[],
    key: string | undefined,
    out: Outbox,
  ): Promise<Outcome<WarDto>> {
    const { war } = this.ctx.params;
    const cells = [...new Set(sector)];
    if (!cells.length || cells.length > war.maxSectorParcels || cells.some((c) => !isValidCellId(c))) {
      throw new GameError('invalid_sector', `a sector is 1–${war.maxSectorParcels} parcels`, 400);
    }
    if (!isConnected(cells)) throw new GameError('invalid_sector', 'sector parcels must connect by their sides', 400);
    const armies = [...new Set(armyIds)].sort();
    if (!armies.length || armies.length > 50) throw new GameError('bad_request', 'choose 1–50 armies', 400);

    return idempotent(this.ctx, playerId, key, 'declare_war', async (tx) => {
      const now = this.ctx.clock.now();
      const owners = await tx.query<{ cell_id: string; owner_id: string }>(
        'SELECT cell_id, owner_id FROM parcels WHERE cell_id = ANY($1::bigint[]) ORDER BY cell_id FOR UPDATE',
        [cells],
      );
      const ownerSet = new Set(owners.rows.map((r) => r.owner_id));
      if (owners.rows.length !== cells.length || ownerSet.size !== 1) {
        throw new GameError('invalid_sector', 'every parcel must belong to the same enemy player', 409);
      }
      const defenderId = owners.rows[0]!.owner_id;
      if (defenderId === playerId) throw new GameError('invalid_sector', 'you cannot attack yourself', 409);
      const rel = await alliancesOf(tx, [playerId, defenderId]);
      if (friendlyWith(playerId, defenderId, rel)) throw new GameError('allied_target', 'you cannot attack your alliance', 409);

      // Attacking armies: at least one must already stand at the front.
      const proximity = war.frontProximityKm * 1000 + 75;
      const rows: ArmyRow[] = [];
      for (const id of armies) {
        const a = await lockArmy(tx, id, playerId);
        requireIdle(a);
        rows.push(a);
      }
      const near = rows.map((a) => ({ army: a, ...nearestCell(a, cells) }));
      if (!near.some((n) => n.dist <= proximity)) {
        throw new GameError('no_army_at_front', 'an attacking army must be at the front', 409);
      }
      const sectorSet = new Set<CellId>(cells);
      const myFriends = await friendlyIds(tx, playerId);
      const travelling: { army: ArmyRow; cell: CellId; arriveAt: number }[] = [];
      for (const n of near) {
        if (n.dist <= proximity) continue;
        const target = cellCenter(n.cell);
        const route = await checkLandRoute(tx, this.ctx, playerId, n.army, target, {
          maxM: this.ctx.params.armies.operationalRadiusKm * 1000,
          allowedCells: sectorSet,
          friendly: myFriends,
        });
        if (!route.ok) throw new GameError('no_route', 'an army has no valid route to the front', 409, { armyId: n.army.id });
        travelling.push({ army: n.army, cell: n.cell, arriveAt: now + this.travelMs(route.distanceM) });
      }

      const center = clusterCenter(cells);
      const totalRounds = this.totalRounds;
      const endsAt = now + totalRounds * this.roundMs;
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO wars (attacker_id, defender_id, sector, lat, lon, status, started_at, ends_at, state)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, '{}'::jsonb) RETURNING id`,
        [playerId, defenderId, cells, center.lat, center.lon, new Date(now), new Date(endsAt)],
      );
      const warId = ins.rows[0]!.id;
      const locked = await tx.query(
        `INSERT INTO war_cells (cell_id, war_id) SELECT c, $2 FROM unnest($1::bigint[]) AS c ON CONFLICT DO NOTHING`,
        [cells, warId],
      );
      if ((locked.rowCount ?? 0) !== cells.length) {
        throw new GameError('sector_in_war', 'part of that sector is already being fought over', 409);
      }

      // An attack on a base cancels its repairs; those troops defend as they are.
      const bases = await tx.query<{ id: string }>('SELECT id FROM bases WHERE cell_id = ANY($1::bigint[])', [cells]);
      await this.military.cancelRepairsAt(tx, bases.rows.map((b) => b.id), now, out);

      // Automatic defence: armies inside the sector fight at once; idle armies
      // within 100 km with a valid route march to the front.
      const defFriends = await friendlyIds(tx, defenderId);
      const candidates = await tx.query<ArmyRow>(
        `SELECT * FROM armies WHERE owner_id = $1 AND status = 'idle' ORDER BY id FOR UPDATE`,
        [defenderId],
      );
      const defendersPresent: ArmyRow[] = [];
      const defendersTravelling: { army: ArmyRow; cell: CellId; arriveAt: number }[] = [];
      for (const a of candidates.rows) {
        if (headcount(parseUnits(a.units)) <= 0) continue;
        if (sectorSet.has(cellAt(a.lat, a.lon))) {
          defendersPresent.push(a);
          continue;
        }
        const n = nearestCell(a, cells);
        if (n.dist > war.autoDefenseRadiusKm * 1000) continue;
        const route = await checkLandRoute(tx, this.ctx, defenderId, a, cellCenter(n.cell), {
          allowedCells: sectorSet,
          friendly: defFriends,
        });
        if (route.ok) defendersTravelling.push({ army: a, cell: n.cell, arriveAt: now + this.travelMs(route.distanceM) });
      }
      const aa = await tx.query('SELECT 1 FROM aa_batteries WHERE cell_id = ANY($1::bigint[]) LIMIT 1', [cells]);

      const present = near.filter((n) => n.dist <= proximity).map((n) => n.army);
      if (!defendersPresent.length && !defendersTravelling.length && !aa.rowCount) {
        // Undefended sector: immediate surrender to a valid military attack.
        const state = createBattle(seedFromString(warId), totalRounds);
        for (const a of present) {
          addArmy(state, { id: a.id, ownerId: a.owner_id, side: 'attacker', units: parseUnits(a.units), activeFromRound: 1 });
        }
        await tx.query('UPDATE wars SET state = $2 WHERE id = $1', [warId, JSON.stringify(state)]);
        const warRow = await this.lockWar(tx, warId);
        await this.finish(tx, warRow!, now, out, true);
      } else {
        const state = createBattle(seedFromString(warId), totalRounds);
        const initial: Record<string, number> = {};
        const join = (a: ArmyRow, side: Side, from: number) => {
          addArmy(state, { id: a.id, ownerId: a.owner_id, side, units: parseUnits(a.units), activeFromRound: from });
          initial[a.id] = headcount(parseUnits(a.units));
        };
        for (const a of present) join(a, 'attacker', 1);
        for (const a of defendersPresent) join(a, 'defender', 1);
        for (const a of [...present, ...defendersPresent]) {
          const side = a.owner_id === playerId ? 'attacker' : 'defender';
          await tx.query(`UPDATE armies SET status = 'at_war', war_id = $2, war_side = $3 WHERE id = $1`, [a.id, warId, side]);
        }
        for (const t of travelling) await this.dispatch(tx, t.army, warId, 'attacker', cellCenter(t.cell), now, t.arriveAt);
        for (const t of defendersTravelling) {
          await this.dispatch(tx, t.army, warId, 'defender', cellCenter(t.cell), now, t.arriveAt);
        }
        await tx.query('UPDATE wars SET state = $2, initial = $3 WHERE id = $1', [warId, JSON.stringify(state), JSON.stringify(initial)]);
        await this.scheduler.schedule(tx, 'war_round', warId, now + this.roundMs, { round: 1 });
        await out.notify(tx, defenderId, 'wars', 'notify.war.attacked', { n: cells.length }, now, 'bad');
        await out.notify(tx, playerId, 'wars', 'notify.war.declared', { n: cells.length }, now);
        const allies = [...defFriends].filter((id) => id !== defenderId);
        if (allies.length) await out.notify(tx, allies, 'alliance', 'notify.war.allyAttacked', { n: cells.length }, now, 'bad');
      }
      const dto = await this.dto(tx, (await this.lockWar(tx, warId))!, playerId);
      return { status: 201, body: dto };
    });
  }

  private travelMs(distM: number): number {
    return Math.ceil((distM / (this.ctx.params.armies.speedKmh * 1000)) * 3600_000);
  }

  /** Assigns an army to a war (exclusively) and sends it to the front. */
  private async dispatch(tx: Tx, a: ArmyRow, warId: string, side: Side, to: LatLon, now: number, arriveAt: number) {
    await tx.query(
      `UPDATE armies SET status = 'at_war', war_id = $2, war_side = $3,
              from_lat = lat, from_lon = lon, to_lat = $4, to_lon = $5, depart_at = $6, arrive_at = $7
        WHERE id = $1`,
      [a.id, warId, side, to.lat, to.lon, new Date(now), new Date(arriveAt)],
    );
    await this.scheduler.schedule(tx, 'war_join', a.id, arriveAt, { warId });
  }

  async reinforce(playerId: string, warId: string, armyIds: string[], key: string | undefined): Promise<Outcome<WarDto>> {
    const ids = [...new Set(armyIds)].sort();
    if (!ids.length || ids.length > 50) throw new GameError('bad_request', 'choose 1–50 armies', 400);
    return idempotent(this.ctx, playerId, key, 'reinforce', async (tx) => {
      const now = this.ctx.clock.now();
      const w = await this.lockWar(tx, warId);
      if (!w || w.status !== 'active') throw new GameError('not_found', 'war not found or over', 404);
      const rel = await alliancesOf(tx, [playerId, w.attacker_id, w.defender_id]);
      const side: Side | null = friendlyWith(playerId, w.attacker_id, rel)
        ? 'attacker'
        : friendlyWith(playerId, w.defender_id, rel)
          ? 'defender'
          : null;
      if (!side) throw new GameError('forbidden', 'only the two sides and their allies can send forces', 403);
      const cells = w.sector.map(Number);
      const sectorSet = new Set<CellId>(cells);
      const friends = await friendlyIds(tx, playerId);
      const proximity = this.ctx.params.war.frontProximityKm * 1000 + 75;
      const state = w.state;
      const initial = { ...w.initial };
      for (const id of ids) {
        const a = await lockArmy(tx, id, playerId);
        requireIdle(a);
        const n = nearestCell(a, cells);
        if (n.dist <= proximity || sectorSet.has(cellAt(a.lat, a.lon))) {
          addArmy(state, {
            id: a.id,
            ownerId: a.owner_id,
            side,
            units: parseUnits(a.units),
            activeFromRound: firstFullRound(now, w.started_at.getTime(), this.roundMs),
          });
          initial[a.id] = headcount(parseUnits(a.units));
          await tx.query(`UPDATE armies SET status = 'at_war', war_id = $2, war_side = $3 WHERE id = $1`, [a.id, warId, side]);
          continue;
        }
        const route = await checkLandRoute(tx, this.ctx, playerId, a, cellCenter(n.cell), {
          maxM: this.ctx.params.armies.operationalRadiusKm * 1000,
          allowedCells: sectorSet,
          friendly: friends,
        });
        if (!route.ok) throw new GameError('no_route', 'an army has no valid route to the front', 409, { armyId: a.id });
        const arriveAt = now + this.travelMs(route.distanceM);
        if (arriveAt > w.ends_at.getTime()) throw new GameError('too_late', 'that army would arrive after the war ends', 409);
        await this.dispatch(tx, a, warId, side, cellCenter(n.cell), now, arriveAt);
      }
      await tx.query('UPDATE wars SET state = $2, initial = $3 WHERE id = $1', [warId, JSON.stringify(state), JSON.stringify(initial)]);
      return { status: 200, body: await this.dto(tx, (await this.lockWar(tx, warId))!, playerId) };
    });
  }

  // ----------------------------------------------------------------- jobs

  private async lockWar(tx: Queryable, id: string): Promise<WarRow | undefined> {
    return (await tx.query<WarRow>('SELECT * FROM wars WHERE id = $1 FOR UPDATE', [id])).rows[0];
  }

  private async onJoin(tx: Tx, armyId: string, warId: string, at: number, out: Outbox): Promise<void> {
    const w = await this.lockWar(tx, warId);
    const a = (await tx.query<ArmyRow>('SELECT * FROM armies WHERE id = $1 FOR UPDATE', [armyId])).rows[0];
    if (!w || !a || a.war_id !== warId || w.status !== 'active' || at > w.ends_at.getTime()) return;
    const state = w.state;
    if (!state.armies.some((x) => x.id === a.id)) {
      addArmy(state, {
        id: a.id,
        ownerId: a.owner_id,
        side: a.war_side!,
        units: parseUnits(a.units),
        activeFromRound: firstFullRound(at, w.started_at.getTime(), this.roundMs),
      });
    }
    const initial = { ...w.initial, [a.id]: headcount(parseUnits(a.units)) };
    await tx.query(
      `UPDATE armies SET lat = to_lat, lon = to_lon, from_lat = NULL, from_lon = NULL, to_lat = NULL, to_lon = NULL,
              depart_at = NULL, arrive_at = NULL WHERE id = $1`,
      [a.id],
    );
    await tx.query('UPDATE wars SET state = $2, initial = $3 WHERE id = $1', [warId, JSON.stringify(state), JSON.stringify(initial)]);
    out.push(this.participants(w), { type: 'war_update', warId });
  }

  private participants(w: WarRow): string[] {
    return [...new Set([w.attacker_id, w.defender_id, ...w.state.armies.map((a) => a.ownerId)])];
  }

  private async onRound(tx: Tx, warId: string, round: number, at: number, out: Outbox): Promise<void> {
    const w = await this.lockWar(tx, warId);
    if (!w || w.status !== 'active' || w.state.round !== round - 1) return; // already applied
    const state = w.state;
    resolveRound(state, this.ctx.params);
    for (const a of state.armies) {
      await tx.query('UPDATE armies SET units = $2 WHERE id = $1', [a.id, unitsJson(a.units)]);
    }
    await tx.query('UPDATE wars SET state = $2 WHERE id = $1', [warId, JSON.stringify(state)]);
    out.push(this.participants(w), { type: 'war_update', warId, round });
    if (round >= state.totalRounds) {
      await this.finish(tx, { ...w, state }, at, out, false);
    } else {
      await this.scheduler.schedule(tx, 'war_round', warId, w.started_at.getTime() + (round + 1) * this.roundMs, {
        round: round + 1,
      });
    }
  }

  // ---------------------------------------------------------------- finish

  private async finish(tx: Tx, w: WarRow, at: number, out: Outbox, surrendered: boolean): Promise<void> {
    const state = w.state;
    const result = decideOutcome(state, this.ctx.params);
    const sector = w.sector.map(Number);
    const sectorSet = new Set<CellId>(sector);
    const casualties = { attacker: 0, defender: 0 };
    for (const a of state.armies) casualties[a.side] += Math.max(0, (w.initial[a.id] ?? headcount(a.units)) - headcount(a.units));

    // Conquest: the attackers share the parcels by contribution (provisional rule).
    let conquered: CellId[] = [];
    if (result.winner === 'attacker') {
      const shares = new Map<string, number>();
      for (const a of state.armies) {
        if (a.side === 'attacker') shares.set(a.ownerId, (shares.get(a.ownerId) ?? 0) + a.damageDealt);
      }
      if (![...shares.values()].some((v) => v > 0)) shares.set(w.attacker_id, 1);
      for (const [owner, cells] of splitByContribution(sector, shares)) {
        conquered.push(...(await transferCells(tx, this.ctx, cells, w.defender_id, owner, 'war', at)));
      }
      conquered = conquered.sort((x, y) => x - y);
      await this.military.destroyStructuresIn(tx, conquered, at, out);
      await tx.query('UPDATE players SET wars_won = wars_won + 1 WHERE id = $1', [w.attacker_id]);
      out.push([w.defender_id], { type: 'parcel_lost', cells: conquered });
    } else {
      await tx.query('UPDATE players SET wars_won = wars_won + 1 WHERE id = $1', [w.defender_id]);
    }

    // Armies: casualties are permanent and damage persists; losers retreat.
    const retreated: string[] = [];
    const destroyed: string[] = [];
    const inBattle = new Set(state.armies.map((a) => a.id));
    for (const a of state.armies) {
      const row = (await tx.query<ArmyRow>('SELECT * FROM armies WHERE id = $1 FOR UPDATE', [a.id])).rows[0];
      if (!row) continue;
      if (headcount(a.units) <= 0) {
        await tx.query('DELETE FROM armies WHERE id = $1', [a.id]);
        destroyed.push(a.id);
        continue;
      }
      await tx.query(
        `UPDATE armies SET units = $2, status = 'idle', war_id = NULL, war_side = NULL WHERE id = $1`,
        [a.id, unitsJson(a.units)],
      );
      if (a.side !== result.winner) {
        const ok = await this.retreat(tx, { ...row, units: a.units, status: 'idle' }, sectorSet, at);
        if (ok) retreated.push(a.id);
        else {
          await tx.query('DELETE FROM armies WHERE id = $1', [a.id]);
          destroyed.push(a.id);
        }
      }
    }
    // Forces still on the road stop where they are.
    const enRoute = await tx.query<ArmyRow>('SELECT * FROM armies WHERE war_id = $1 FOR UPDATE', [w.id]);
    for (const a of enRoute.rows) {
      if (inBattle.has(a.id)) continue;
      await this.scheduler.cancel(tx, 'war_join', a.id);
      const p = a.depart_at && a.arrive_at && a.to_lat !== null
        ? interpolate(
            { lat: a.from_lat!, lon: a.from_lon! },
            { lat: a.to_lat, lon: a.to_lon! },
            Math.min(1, Math.max(0, (at - a.depart_at.getTime()) / Math.max(1, a.arrive_at.getTime() - a.depart_at.getTime()))),
          )
        : { lat: a.lat, lon: a.lon };
      await tx.query(
        `UPDATE armies SET status = 'idle', war_id = NULL, war_side = NULL, lat = $2, lon = $3,
                from_lat = NULL, from_lon = NULL, to_lat = NULL, to_lon = NULL, depart_at = NULL, arrive_at = NULL
          WHERE id = $1`,
        [a.id, p.lat, p.lon],
      );
    }

    const outcome: WarOutcome = {
      winner: result.winner,
      surrendered,
      power: result.power,
      effectivePower: result.effectivePower,
      casualties,
      conquered,
      retreated,
      destroyedArmies: destroyed,
    };
    await tx.query(
      `UPDATE wars SET status = 'finished', winner = $2, outcome = $3, finished_at = $4, state = $5 WHERE id = $1`,
      [w.id, result.winner, JSON.stringify(outcome), new Date(at), JSON.stringify(state)],
    );
    await tx.query('DELETE FROM war_cells WHERE war_id = $1', [w.id]);
    const sides = new Map<string, Side>();
    sides.set(w.attacker_id, 'attacker');
    sides.set(w.defender_id, 'defender');
    for (const a of state.armies) sides.set(a.ownerId, a.side);
    for (const [pid, side] of sides) {
      const won = side === result.winner;
      await out.notify(
        tx,
        pid,
        'wars',
        surrendered ? 'notify.war.surrendered' : won ? 'notify.war.won' : 'notify.war.lost',
        { n: conquered.length },
        at,
        won ? 'good' : 'bad',
      );
    }
    out.push([...sides.keys()], { type: 'war_update', warId: w.id, finished: true });
  }

  /**
   * Defeated survivors fall back to the nearest friendly parcel they can
   * reach by a valid route within their operational radius. With no such
   * route they are destroyed.
   */
  private async retreat(tx: Tx, army: ArmyRow, sector: Set<CellId>, at: number): Promise<boolean> {
    const friends = await friendlyIds(tx, army.owner_id);
    const radius = this.ctx.params.armies.operationalRadiusKm * 1000;
    const dLat = radius / 111_195 / 0.1;
    const dLon = radius / (111_195 * Math.max(0.05, Math.cos((army.lat * Math.PI) / 180))) / 0.1;
    const zlat = Math.floor((army.lat + 90) / 0.1);
    const zlon = Math.floor((army.lon + 180) / 0.1);
    const res = await tx.query<{ cell_id: string }>(
      `SELECT cell_id FROM parcels
        WHERE owner_id = ANY($1::uuid[])
          AND zlat BETWEEN $2 AND $3
          AND (zlon BETWEEN $4 AND $5 OR zlon BETWEEN $6 AND $7 OR zlon BETWEEN $8 AND $9)
        LIMIT 20000`,
      [
        [...friends],
        Math.max(0, zlat - Math.ceil(dLat)),
        Math.min(1799, zlat + Math.ceil(dLat)),
        zlon - Math.ceil(dLon),
        zlon + Math.ceil(dLon),
        zlon - Math.ceil(dLon) + 3600,
        3599,
        0,
        zlon + Math.ceil(dLon) - 3600,
      ],
    );
    const candidates = res.rows
      .map((r) => Number(r.cell_id))
      .filter((c) => !sector.has(c))
      .map((c) => ({ c, d: distanceM(army, cellCenter(c)) }))
      .filter((x) => x.d <= radius)
      .sort((x, y) => x.d - y.d);
    for (const { c } of candidates.slice(0, 8)) {
      const dest = cellCenter(c);
      const route = await checkLandRoute(tx, this.ctx, army.owner_id, army, dest, { allowedCells: sector, friendly: friends });
      if (route.ok) {
        await this.military.startMovement(tx, army, dest, at, 'retreating');
        return true;
      }
    }
    return false;
  }

  // ----------------------------------------------------------------- views

  private async dto(db: Queryable, w: WarRow, viewerId: string): Promise<WarDto> {
    const rel = await alliancesOf(db, [viewerId, w.attacker_id, w.defender_id, ...w.state.armies.map((a) => a.ownerId)]);
    const role: Side = friendlyWith(viewerId, w.attacker_id, rel) ? 'attacker' : 'defender';
    const names = await db.query<{ id: string; username: string }>('SELECT id, username FROM players WHERE id = ANY($1::uuid[])', [
      [...new Set([w.attacker_id, w.defender_id, ...w.state.armies.map((a) => a.ownerId)])],
    ]);
    const name = new Map(names.rows.map((r) => [r.id, r.username]));
    const travelling = await db.query<{ id: string; owner_id: string; units: unknown; arrive_at: Date | null }>(
      `SELECT id, owner_id, units, arrive_at FROM armies WHERE war_id = $1 AND war_side = $2`,
      [w.id, role],
    );
    const inBattle = new Set(w.state.armies.map((a) => a.id));
    const params = this.ctx.params;
    const friendlyArmies = [
      ...w.state.armies
        .filter((a) => a.side === role)
        .map((a) => ({
          id: a.id,
          ownerName: name.get(a.ownerId) ?? '?',
          mine: a.ownerId === viewerId,
          headcount: headcount(a.units),
          power: compositionPower(a.units, params),
          arriveAt: null,
        })),
      ...travelling.rows
        .filter((a) => !inBattle.has(a.id))
        .map((a) => {
          const units = parseUnits(a.units);
          return {
            id: a.id,
            ownerName: name.get(a.owner_id) ?? '?',
            mine: a.owner_id === viewerId,
            headcount: headcount(units),
            power: compositionPower(units, params),
            arriveAt: a.arrive_at?.getTime() ?? null,
          };
        }),
    ];
    return {
      id: w.id,
      status: w.status,
      role,
      attacker: { id: w.attacker_id, name: name.get(w.attacker_id) ?? '?' },
      defender: { id: w.defender_id, name: name.get(w.defender_id) ?? '?' },
      sector: w.sector.map(Number),
      center: { lat: w.lat, lon: w.lon },
      startedAt: w.started_at.getTime(),
      endsAt: w.ends_at.getTime(),
      round: w.state.round ?? 0,
      totalRounds: w.state.totalRounds ?? this.totalRounds,
      friendly: { power: sidePower(w.state, role, params), armies: friendlyArmies },
      enemy: { band: estimateBand(sidePower(w.state, other(role), params)) },
      winner: w.winner,
      outcome: w.outcome,
    };
  }

  /** Wars the player (or their alliance) is part of, plus those finished in the last day. */
  async list(playerId: string): Promise<WarDto[]> {
    const friends = [...(await friendlyIds(this.ctx.pool, playerId))];
    const res = await this.ctx.pool.query<WarRow>(
      `SELECT w.* FROM wars w
        WHERE (w.attacker_id = ANY($1::uuid[]) OR w.defender_id = ANY($1::uuid[])
               OR EXISTS (SELECT 1 FROM armies a WHERE a.war_id = w.id AND a.owner_id = $2))
          AND (w.status = 'active' OR w.finished_at > $3)
        ORDER BY w.status, w.started_at DESC LIMIT 50`,
      [friends, playerId, new Date(this.ctx.clock.now() - 86400_000)],
    );
    return Promise.all(res.rows.map((w) => this.dto(this.ctx.pool, w, playerId)));
  }

  async get(playerId: string, warId: string): Promise<WarDto> {
    const w = (await this.ctx.pool.query<WarRow>('SELECT * FROM wars WHERE id = $1', [warId])).rows[0];
    if (!w) throw new GameError('not_found', 'war not found', 404);
    const rel = await alliancesOf(this.ctx.pool, [playerId, w.attacker_id, w.defender_id]);
    const involved =
      friendlyWith(playerId, w.attacker_id, rel) ||
      friendlyWith(playerId, w.defender_id, rel) ||
      w.state.armies?.some((a) => a.ownerId === playerId);
    if (!involved) throw new GameError('forbidden', 'not your war', 403);
    return this.dto(this.ctx.pool, w, playerId);
  }

  /** Public: where wars are being fought (no forces). */
  async publicWars(bbox: { west: number; south: number; east: number; north: number }): Promise<PublicWarDto[]> {
    const lonClause =
      bbox.west <= bbox.east ? 'w.lon BETWEEN $3 AND $4' : '(w.lon >= $3 OR w.lon <= $4)';
    const res = await this.ctx.pool.query<{
      id: string;
      lat: number;
      lon: number;
      sector: string[];
      ends_at: Date;
      a: string;
      d: string;
    }>(
      `SELECT w.id, w.lat, w.lon, w.sector, w.ends_at, pa.username AS a, pd.username AS d
         FROM wars w JOIN players pa ON pa.id = w.attacker_id JOIN players pd ON pd.id = w.defender_id
        WHERE w.status = 'active' AND w.lat BETWEEN $1 AND $2 AND ${lonClause}
        LIMIT 500`,
      [bbox.south, bbox.north, bbox.west, bbox.east],
    );
    return res.rows.map((r) => ({
      id: r.id,
      center: { lat: r.lat, lon: r.lon },
      sector: r.sector.map(Number),
      attacker: r.a,
      defender: r.d,
      endsAt: r.ends_at.getTime(),
    }));
  }
}

/**
 * PROVISIONAL shared-conquest rule (the official formula is pending): parcels
 * are split by each attacking player's share of damage dealt (largest
 * remainder), handing out cells in id order so each share is a compact band.
 */
export function splitByContribution(cells: CellId[], shares: Map<string, number>): Map<string, CellId[]> {
  const sorted = [...cells].sort((a, b) => a - b);
  const owners = [...shares.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = owners.reduce((s, [, v]) => s + v, 0);
  const exact = owners.map(([id, v]) => ({ id, x: (v / total) * sorted.length }));
  const counts = exact.map((e) => Math.floor(e.x));
  let left = sorted.length - counts.reduce((s, x) => s + x, 0);
  const order = exact.map((e, i) => [e.x - Math.floor(e.x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    counts[i]!++;
    left--;
  }
  const out = new Map<string, CellId[]>();
  let k = 0;
  owners.forEach(([id], i) => {
    out.set(id, sorted.slice(k, k + counts[i]!));
    k += counts[i]!;
  });
  return out;
}
