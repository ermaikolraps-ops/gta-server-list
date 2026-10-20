import type { GameContext } from '../context';
import { Scheduler } from '../scheduler';
import { AllianceService } from './alliances';
import { DroneService } from './drones';
import { GpsService } from './gps';
import { MilitaryService } from './military';
import { ShipService } from './ships';
import { SocialService } from './social';
import { WarService } from './wars';

export interface Services {
  gps: GpsService;
  scheduler: Scheduler;
  drones: DroneService;
  military: MilitaryService;
  wars: WarService;
  ships: ShipService;
  alliances: AllianceService;
  social: SocialService;
  start(intervalMs: number): void;
  stop(): void;
}

export function createServices(ctx: GameContext): Services {
  const scheduler = new Scheduler(ctx);
  const gps = new GpsService(ctx);
  const drones = new DroneService(ctx, scheduler, gps);
  const military = new MilitaryService(ctx, scheduler, gps, drones);
  const wars = new WarService(ctx, scheduler, military);
  const ships = new ShipService(ctx, scheduler);
  const alliances = new AllianceService(ctx, drones);
  const social = new SocialService(ctx);
  return {
    gps,
    scheduler,
    drones,
    military,
    wars,
    ships,
    alliances,
    social,
    start: (intervalMs) => scheduler.start(intervalMs),
    stop: () => scheduler.stop(),
  };
}
