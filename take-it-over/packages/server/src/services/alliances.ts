import type { AllianceDto, MyAllianceView } from '@tio/shared';
import type { GameContext } from '../context';
import { type Tx, withTx } from '../db/pool';
import { GameError } from '../errors';
import { Outbox } from '../outbox';
import type { DroneService } from './drones';

const NAME_RE = /^[A-Za-z0-9 _-]{3,24}$/;

/**
 * Alliances of up to 10 players: shared movement, no AA fire on allied
 * drones, joint wars, no attacks inside the alliance. Leaving keeps all
 * assets. Any membership change re-plans drone interceptions, because it
 * changes which batteries are hostile.
 */
export class AllianceService {
  constructor(
    private readonly ctx: GameContext,
    private readonly drones: DroneService,
  ) {}

  async view(playerId: string): Promise<MyAllianceView> {
    const me = await this.ctx.pool.query<{ alliance_id: string | null }>('SELECT alliance_id FROM players WHERE id = $1', [playerId]);
    const allianceId = me.rows[0]?.alliance_id ?? null;
    const invitations = await this.ctx.pool.query<{ alliance_id: string; name: string; color: string }>(
      `SELECT i.alliance_id, a.name, a.color FROM alliance_invites i JOIN alliances a ON a.id = i.alliance_id
        WHERE i.player_id = $1 ORDER BY i.created_at`,
      [playerId],
    );
    return {
      alliance: allianceId ? await this.dto(allianceId) : null,
      invitations: invitations.rows.map((r) => ({ allianceId: r.alliance_id, name: r.name, color: r.color })),
      maxMembers: this.ctx.params.alliances.maxMembers,
    };
  }

  private async dto(id: string): Promise<AllianceDto> {
    const a = (
      await this.ctx.pool.query<{ id: string; name: string; color: string; leader_id: string }>(
        'SELECT id, name, color, leader_id FROM alliances WHERE id = $1',
        [id],
      )
    ).rows[0]!;
    const members = await this.ctx.pool.query<{ id: string; username: string; color: string; parcel_count: number }>(
      'SELECT id, username, color, parcel_count FROM players WHERE alliance_id = $1 ORDER BY alliance_joined_at, id',
      [id],
    );
    const invites = await this.ctx.pool.query<{ player_id: string; username: string }>(
      `SELECT i.player_id, p.username FROM alliance_invites i JOIN players p ON p.id = i.player_id WHERE i.alliance_id = $1`,
      [id],
    );
    return {
      id: a.id,
      name: a.name,
      color: a.color,
      leaderId: a.leader_id,
      members: members.rows.map((m) => ({ id: m.id, name: m.username, color: m.color, parcels: m.parcel_count })),
      invites: invites.rows.map((i) => ({ playerId: i.player_id, name: i.username })),
    };
  }

  private async run<T>(fn: (tx: Tx, out: Outbox, now: number) => Promise<T>): Promise<T> {
    const out = new Outbox();
    const now = this.ctx.clock.now();
    const result = await withTx(this.ctx.pool, (tx) => fn(tx, out, now));
    out.flush(this.ctx.events);
    return result;
  }

  private async membersOf(tx: Tx, allianceId: string): Promise<string[]> {
    const r = await tx.query<{ id: string }>('SELECT id FROM players WHERE alliance_id = $1', [allianceId]);
    return r.rows.map((x) => x.id);
  }

  private async requireLeader(tx: Tx, playerId: string): Promise<string> {
    const r = await tx.query<{ id: string; leader_id: string }>(
      `SELECT a.id, a.leader_id FROM alliances a JOIN players p ON p.alliance_id = a.id WHERE p.id = $1 FOR UPDATE OF a`,
      [playerId],
    );
    const a = r.rows[0];
    if (!a) throw new GameError('no_alliance', 'you are not in an alliance', 409);
    if (a.leader_id !== playerId) throw new GameError('forbidden', 'only the leader can do that', 403);
    return a.id;
  }

  async create(playerId: string, name: string, color: string): Promise<MyAllianceView> {
    if (!NAME_RE.test(name)) throw new GameError('invalid_name', 'alliance names are 3–24 letters, digits, spaces, _ or -', 400);
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new GameError('invalid_color', 'colour must be #rrggbb', 400);
    await this.run(async (tx, out, now) => {
      const me = await tx.query<{ alliance_id: string | null }>('SELECT alliance_id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
      if (me.rows[0]?.alliance_id) throw new GameError('already_in_alliance', 'leave your alliance first', 409);
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO alliances (name, name_lower, color, leader_id, created_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name_lower) DO NOTHING RETURNING id`,
        [name, name.toLowerCase(), color, playerId, new Date(now)],
      );
      if (!ins.rows[0]) throw new GameError('name_taken', 'that alliance name is taken', 409);
      await tx.query('UPDATE players SET alliance_id = $2, alliance_joined_at = $3 WHERE id = $1', [playerId, ins.rows[0].id, new Date(now)]);
      await tx.query('DELETE FROM alliance_invites WHERE player_id = $1', [playerId]);
      await this.drones.recompute(tx, now, { players: [playerId] });
      out.push(playerId, { type: 'alliance_update' });
    });
    return this.view(playerId);
  }

  async invite(playerId: string, username: string): Promise<MyAllianceView> {
    await this.run(async (tx, out, now) => {
      const allianceId = await this.requireLeader(tx, playerId);
      const target = await tx.query<{ id: string; alliance_id: string | null }>(
        'SELECT id, alliance_id FROM players WHERE username_lower = $1',
        [username.toLowerCase()],
      );
      const t = target.rows[0];
      if (!t) throw new GameError('not_found', 'player not found', 404);
      if (t.alliance_id === allianceId) throw new GameError('already_member', 'already a member', 409);
      await tx.query(
        `INSERT INTO alliance_invites (alliance_id, player_id, invited_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [allianceId, t.id, playerId, new Date(now)],
      );
      out.push(t.id, { type: 'alliance_update' });
      await out.notify(tx, t.id, 'alliance', 'notify.alliance.invited', {}, now);
    });
    return this.view(playerId);
  }

  async accept(playerId: string, allianceId: string): Promise<MyAllianceView> {
    await this.run(async (tx, out, now) => {
      const a = await tx.query('SELECT id FROM alliances WHERE id = $1 FOR UPDATE', [allianceId]);
      if (!a.rowCount) throw new GameError('not_found', 'alliance not found', 404);
      const inv = await tx.query('DELETE FROM alliance_invites WHERE alliance_id = $1 AND player_id = $2 RETURNING 1', [
        allianceId,
        playerId,
      ]);
      if (!inv.rowCount) throw new GameError('no_invite', 'you were not invited', 403);
      const me = await tx.query<{ alliance_id: string | null }>('SELECT alliance_id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
      if (me.rows[0]?.alliance_id) throw new GameError('already_in_alliance', 'leave your alliance first', 409);
      const members = await this.membersOf(tx, allianceId);
      if (members.length >= this.ctx.params.alliances.maxMembers) throw new GameError('alliance_full', 'that alliance is full', 409);
      await tx.query('UPDATE players SET alliance_id = $2, alliance_joined_at = $3 WHERE id = $1', [playerId, allianceId, new Date(now)]);
      await this.drones.recompute(tx, now, { players: [...members, playerId] });
      out.push([...members, playerId], { type: 'alliance_update' });
      await out.notify(tx, members, 'alliance', 'notify.alliance.joined', {}, now, 'good');
    });
    return this.view(playerId);
  }

  async decline(playerId: string, allianceId: string): Promise<MyAllianceView> {
    await this.ctx.pool.query('DELETE FROM alliance_invites WHERE alliance_id = $1 AND player_id = $2', [allianceId, playerId]);
    return this.view(playerId);
  }

  /** Leaving keeps every asset. A departing leader hands over to the longest-serving member. */
  async leave(playerId: string): Promise<MyAllianceView> {
    await this.run(async (tx, out, now) => {
      const me = await tx.query<{ alliance_id: string | null }>('SELECT alliance_id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
      const allianceId = me.rows[0]?.alliance_id;
      if (!allianceId) throw new GameError('no_alliance', 'you are not in an alliance', 409);
      await this.removeMember(tx, out, allianceId, playerId, now);
    });
    return this.view(playerId);
  }

  async kick(playerId: string, memberId: string): Promise<MyAllianceView> {
    if (memberId === playerId) return this.leave(playerId);
    await this.run(async (tx, out, now) => {
      const allianceId = await this.requireLeader(tx, playerId);
      const m = await tx.query('SELECT 1 FROM players WHERE id = $1 AND alliance_id = $2 FOR UPDATE', [memberId, allianceId]);
      if (!m.rowCount) throw new GameError('not_found', 'not a member', 404);
      await this.removeMember(tx, out, allianceId, memberId, now);
      await out.notify(tx, memberId, 'alliance', 'notify.alliance.removed', {}, now, 'bad');
    });
    return this.view(playerId);
  }

  private async removeMember(tx: Tx, out: Outbox, allianceId: string, playerId: string, now: number): Promise<void> {
    const before = await this.membersOf(tx, allianceId);
    await tx.query('UPDATE players SET alliance_id = NULL, alliance_joined_at = NULL WHERE id = $1', [playerId]);
    const rest = before.filter((id) => id !== playerId);
    const a = (await tx.query<{ leader_id: string }>('SELECT leader_id FROM alliances WHERE id = $1 FOR UPDATE', [allianceId]))
      .rows[0]!;
    if (!rest.length) {
      await tx.query('DELETE FROM alliances WHERE id = $1', [allianceId]);
    } else if (a.leader_id === playerId) {
      const next = await tx.query<{ id: string }>(
        'SELECT id FROM players WHERE alliance_id = $1 ORDER BY alliance_joined_at, id LIMIT 1',
        [allianceId],
      );
      await tx.query('UPDATE alliances SET leader_id = $2 WHERE id = $1', [allianceId, next.rows[0]!.id]);
    }
    await this.drones.recompute(tx, now, { players: before });
    out.push(before, { type: 'alliance_update' });
  }
}
