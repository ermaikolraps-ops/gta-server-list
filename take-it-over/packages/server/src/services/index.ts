import type { GameContext } from '../context';
import { GpsService } from './gps';

export interface Services {
  gps: GpsService;
}

export function createServices(ctx: GameContext): Services {
  return { gps: new GpsService(ctx) };
}
