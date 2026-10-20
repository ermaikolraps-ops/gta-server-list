import type { GameParams } from '@tio/shared';
import type { Clock } from './clock';
import type { Pool } from './db/pool';
import type { EventBus } from './events';
import type { LandMask } from './land';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything a service needs; built once at startup and passed explicitly. */
export interface GameContext {
  pool: Pool;
  clock: Clock;
  params: GameParams;
  land: LandMask;
  events: EventBus;
  log: Logger;
  sessionTtlMs: number;
}
