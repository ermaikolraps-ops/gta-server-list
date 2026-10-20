import { EventEmitter } from 'node:events';

/** A message pushed to a player's open WebSocket connections. */
export interface PlayerEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * In-process fan-out of events to players. Services publish only after their
 * transaction commits. With several server instances this would sit on
 * Postgres LISTEN/NOTIFY or Redis; see docs/architecture.md.
 */
export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(0);
  }
  publish(playerId: string, event: PlayerEvent): void {
    this.emitter.emit('player', playerId, event);
  }
  publishMany(playerIds: Iterable<string>, event: PlayerEvent): void {
    for (const id of new Set(playerIds)) this.publish(id, event);
  }
  broadcast(event: PlayerEvent): void {
    this.emitter.emit('broadcast', event);
  }
  onPlayer(fn: (playerId: string, event: PlayerEvent) => void): () => void {
    this.emitter.on('player', fn);
    return () => this.emitter.off('player', fn);
  }
  onBroadcast(fn: (event: PlayerEvent) => void): () => void {
    this.emitter.on('broadcast', fn);
    return () => this.emitter.off('broadcast', fn);
  }
}
