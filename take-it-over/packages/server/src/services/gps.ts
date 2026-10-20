import { type CellId, cellAt, distanceM, type GpsResult, type LatLon, zoneKey, zoneOf } from '@tio/shared';
import type { GameContext } from '../context';
import { withTx } from '../db/pool';
import { grant } from './economy';
import { claimNeutralCells } from './territory';

export interface GpsFix {
  lat: number;
  lon: number;
  /** Declared horizontal accuracy (metres, 68% radius as reported by the device). */
  accuracy: number;
}

export type { GpsResult, GpsStatus } from '@tio/shared';

interface Presence {
  /** Cell the dwell timer is running in, or null after a reset. */
  cell: CellId | null;
  since: number;
  lastFixAt: number;
  last: LatLon | null;
  lastAccuracy: number;
  zone: number | null;
}

export interface FreshFix extends LatLon {
  accuracy: number;
  at: number;
}

/**
 * Server-side GPS conquest. The client only reports raw fixes; the server
 * decides which cell they fall in, times the 2-second dwell with its own
 * clock, and performs the claim. Only the latest fix per player is kept, in
 * memory — no location history is stored.
 *
 * Presence lives in memory, so after a restart a player simply needs two more
 * seconds; with several instances, GPS traffic must be sticky per player.
 */
export class GpsService {
  private presence = new Map<string, Presence>();
  private suspension = new Map<string, { until: number; checkedAt: number }>();

  constructor(private readonly ctx: GameContext) {}

  /** The player's last accepted fix if it is recent and accurate enough to act on. */
  freshFix(playerId: string): FreshFix | null {
    const p = this.presence.get(playerId);
    if (!p || !p.last) return null;
    if (this.ctx.clock.now() - p.lastFixAt > this.ctx.params.gps.freshFixMs) return null;
    if (p.lastAccuracy > this.ctx.params.gps.maxAccuracyM) return null;
    return { ...p.last, accuracy: p.lastAccuracy, at: p.lastFixAt };
  }

  /** Test/admin hook: forget presence (e.g. on logout). */
  forget(playerId: string): void {
    this.presence.delete(playerId);
  }

  async handleFix(playerId: string, fix: GpsFix): Promise<GpsResult> {
    const { gps } = this.ctx.params;
    const now = this.ctx.clock.now();
    const requiredMs = gps.dwellMs;
    let p = this.presence.get(playerId);

    if (p && now - p.lastFixAt < gps.minFixIntervalMs) return { status: 'rate_limited', requiredMs };

    if (fix.accuracy > gps.maxAccuracyM) {
      // An inaccurate fix proves nothing about where the player is, so the
      // dwell timer restarts with the next good fix.
      if (p) {
        p.cell = null;
        p.lastFixAt = now;
      } else {
        this.presence.set(playerId, { cell: null, since: now, lastFixAt: now, last: null, lastAccuracy: fix.accuracy, zone: null });
      }
      return { status: 'low_accuracy', requiredMs };
    }

    const here: LatLon = { lat: fix.lat, lon: fix.lon };
    const cell = cellAt(fix.lat, fix.lon);
    let jumped = false;
    if (p?.last) {
      const dist = distanceM(p.last, here);
      const dt = Math.max(1, now - p.lastFixAt);
      const speedKmh = (dist / dt) * 3600;
      // Ignore small jitter; anything else faster than an airliner is logged.
      if (dist > 500 && speedKmh > gps.implausibleSpeedKmh) {
        jumped = true;
        void this.recordAnomaly(playerId, 'implausible_speed', {
          speedKmh: Math.round(speedKmh),
          distanceM: Math.round(dist),
          dtMs: dt,
          toCell: cell,
        });
      }
    }

    if (!p) {
      p = { cell, since: now, lastFixAt: now, last: here, lastAccuracy: fix.accuracy, zone: null };
      this.presence.set(playerId, p);
    } else {
      // Presence must be continuous: a long silence (app closed, signal lost)
      // restarts the timer even if the player reappears in the same cell.
      if (p.cell !== cell || jumped || now - p.lastFixAt > gps.maxFixGapMs) {
        p.cell = cell;
        p.since = now;
      }
      p.lastFixAt = now;
      p.last = here;
      p.lastAccuracy = fix.accuracy;
    }

    let explorationReward: number | undefined;
    const zk = zoneKey(zoneOf(here));
    if (p.zone !== zk) {
      p.zone = zk;
      explorationReward = await this.maybeRewardExploration(playerId, zk, now);
    }
    const extra = explorationReward ? { explorationReward } : {};

    const land = await this.ctx.land.cellsOnLand([cell]);
    if (!land.get(cell)) return { status: 'water', cell, requiredMs, ...extra };

    const owner = await this.ctx.pool.query<{ owner_id: string }>('SELECT owner_id FROM parcels WHERE cell_id = $1', [
      cell,
    ]);
    const ownerId = owner.rows[0]?.owner_id;
    if (ownerId === playerId) return { status: 'own', cell, requiredMs, ownerId, ...extra };
    if (ownerId) return { status: 'enemy', cell, requiredMs, ownerId, ...extra };

    if (await this.isSuspended(playerId, now)) return { status: 'suspended', cell, requiredMs, ...extra };

    const dwellMs = now - p.since;
    if (dwellMs < requiredMs) return { status: 'tracking', cell, dwellMs, requiredMs, ...extra };

    const won = await withTx(this.ctx.pool, (tx) => claimNeutralCells(tx, this.ctx, playerId, [cell], 'gps', now));
    if (won.length) {
      this.ctx.events.publish(playerId, { type: 'parcel_conquered', cells: won, via: 'gps' });
      return { status: 'conquered', cell, dwellMs, requiredMs, ...extra };
    }
    // Lost a race for this cell to someone else.
    const after = await this.ctx.pool.query<{ owner_id: string }>('SELECT owner_id FROM parcels WHERE cell_id = $1', [
      cell,
    ]);
    const winner = after.rows[0]?.owner_id;
    return { status: winner === playerId ? 'own' : 'enemy', cell, requiredMs, ...(winner ? { ownerId: winner } : {}), ...extra };
  }

  private async isSuspended(playerId: string, now: number): Promise<boolean> {
    const cached = this.suspension.get(playerId);
    if (cached && now - cached.checkedAt < 60_000) return cached.until > now;
    const res = await this.ctx.pool.query<{ gps_suspended_until: Date | null }>(
      'SELECT gps_suspended_until FROM players WHERE id = $1',
      [playerId],
    );
    const until = res.rows[0]?.gps_suspended_until?.getTime() ?? 0;
    this.suspension.set(playerId, { until, checkedAt: now });
    return until > now;
  }

  /**
   * Permissive anti-cheat: every anomaly is logged, a single one changes
   * nothing, and only repeated anomalies within the window suspend GPS
   * conquest for a while. Nothing else (drones, wars, income) is affected.
   */
  async recordAnomaly(playerId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
    const { gps } = this.ctx.params;
    const now = this.ctx.clock.now();
    try {
      await this.ctx.pool.query(
        'INSERT INTO gps_anomalies (player_id, kind, detail, created_at) VALUES ($1, $2, $3, $4)',
        [playerId, kind, JSON.stringify(detail), new Date(now)],
      );
      const count = await this.ctx.pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM gps_anomalies WHERE player_id = $1 AND created_at > $2',
        [playerId, new Date(now - gps.anomalyWindowHours * 3600_000)],
      );
      if (Number(count.rows[0]!.n) >= gps.anomalyThreshold) {
        const until = now + gps.suspensionHours * 3600_000;
        await this.ctx.pool.query(
          'UPDATE players SET gps_suspended_until = GREATEST(COALESCE(gps_suspended_until, $2), $2) WHERE id = $1',
          [playerId, new Date(until)],
        );
        this.suspension.set(playerId, { until, checkedAt: now });
        this.ctx.events.publish(playerId, { type: 'gps_suspended', until: new Date(until).toISOString() });
        this.ctx.log.warn({ playerId, anomalies: Number(count.rows[0]!.n) }, 'GPS conquest suspended');
      }
    } catch (err) {
      this.ctx.log.error({ err, playerId }, 'failed to record GPS anomaly');
    }
  }

  /** Exploration reward for territory-less players entering a never-visited zone. */
  private async maybeRewardExploration(playerId: string, zone: number, now: number): Promise<number | undefined> {
    const { economy } = this.ctx.params;
    if (economy.explorationRewardCredits <= 0) return undefined;
    return withTx(this.ctx.pool, async (tx) => {
      const pl = await tx.query<{ parcel_count: number }>('SELECT parcel_count FROM players WHERE id = $1 FOR UPDATE', [
        playerId,
      ]);
      if ((pl.rows[0]?.parcel_count ?? 1) > 0) return undefined;
      const today = await tx.query<{ n: string }>(
        'SELECT count(*) AS n FROM explored_zones WHERE player_id = $1 AND rewarded AND first_at > $2',
        [playerId, new Date(now - 86400_000)],
      );
      const reward = Number(today.rows[0]!.n) < economy.explorationMaxRewardsPerDay;
      const ins = await tx.query(
        `INSERT INTO explored_zones (player_id, zone, first_at, rewarded) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING zone`,
        [playerId, zone, new Date(now), reward],
      );
      if (!ins.rowCount || !reward) return undefined;
      await grant(tx, this.ctx, playerId, economy.explorationRewardCredits, 'exploration', String(zone), now);
      return economy.explorationRewardCredits;
    });
  }
}
