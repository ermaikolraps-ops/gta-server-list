import type { NotificationDto, RankingDto, RankingMetric } from '@tio/shared';
import type { GameContext } from '../context';
import { GameError } from '../errors';

const COLUMN: Record<RankingMetric, string> = {
  territory: 'parcel_count',
  wars: 'wars_won',
  drones: 'drone_captures',
};

/** Notification inbox and prestige rankings (no gameplay bonuses). */
export class SocialService {
  constructor(private readonly ctx: GameContext) {}

  async notifications(playerId: string): Promise<{ items: NotificationDto[]; unread: number }> {
    const res = await this.ctx.pool.query<{
      id: string;
      category: string;
      key: string;
      params: Record<string, string | number>;
      tone: NotificationDto['tone'];
      created_at: Date;
      read_at: Date | null;
    }>('SELECT * FROM notifications WHERE player_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [playerId]);
    const unread = await this.ctx.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM notifications WHERE player_id = $1 AND read_at IS NULL',
      [playerId],
    );
    return {
      items: res.rows.map((r) => ({
        id: Number(r.id),
        category: r.category,
        key: r.key,
        params: r.params,
        tone: r.tone,
        createdAt: r.created_at.getTime(),
        read: r.read_at !== null,
      })),
      unread: Number(unread.rows[0]!.n),
    };
  }

  async markRead(playerId: string): Promise<void> {
    await this.ctx.pool.query('UPDATE notifications SET read_at = $2 WHERE player_id = $1 AND read_at IS NULL', [
      playerId,
      new Date(this.ctx.clock.now()),
    ]);
  }

  async rankings(playerId: string, metric: RankingMetric): Promise<RankingDto> {
    const col = COLUMN[metric];
    if (!col) throw new GameError('bad_request', 'unknown ranking', 400);
    const top = await this.ctx.pool.query<{ id: string; username: string; color: string; value: number }>(
      `SELECT id, username, color, ${col} AS value FROM players WHERE ${col} > 0 ORDER BY ${col} DESC, created_at LIMIT 50`,
    );
    const me = await this.ctx.pool.query<{ value: number; rank: string }>(
      `SELECT ${col} AS value, (SELECT count(*) + 1 FROM players o WHERE o.${col} > p.${col}) AS rank FROM players p WHERE id = $1`,
      [playerId],
    );
    return {
      metric,
      rows: top.rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.username, color: r.color, value: r.value })),
      me: me.rows[0] ? { rank: Number(me.rows[0].rank), value: me.rows[0].value } : null,
    };
  }
}
