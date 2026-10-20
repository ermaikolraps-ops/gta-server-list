import type { Tx } from './db/pool';
import type { EventBus, PlayerEvent } from './events';

export type Tone = 'info' | 'good' | 'bad';

/**
 * Collects events produced inside a transaction and publishes them only after
 * it commits, so clients never hear about something that was rolled back.
 * Notifications are also stored, so players see them after reconnecting.
 */
export class Outbox {
  private events: { playerId: string; event: PlayerEvent }[] = [];

  push(playerIds: string | Iterable<string>, event: PlayerEvent): void {
    const ids = typeof playerIds === 'string' ? [playerIds] : [...new Set(playerIds)];
    for (const playerId of ids) this.events.push({ playerId, event });
  }

  async notify(
    tx: Tx,
    playerIds: string | Iterable<string>,
    category: string,
    key: string,
    params: Record<string, string | number>,
    atMs: number,
    tone: Tone = 'info',
  ): Promise<void> {
    const ids = typeof playerIds === 'string' ? [playerIds] : [...new Set(playerIds)];
    for (const playerId of ids) {
      await tx.query(
        `INSERT INTO notifications (player_id, category, key, params, tone, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [playerId, category, key, JSON.stringify(params), tone, new Date(atMs)],
      );
      this.events.push({ playerId, event: { type: 'notification', category, key, params, tone } });
    }
  }

  flush(bus: EventBus): void {
    for (const { playerId, event } of this.events) bus.publish(playerId, event);
    this.events = [];
  }
}
