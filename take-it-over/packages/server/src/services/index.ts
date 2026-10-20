import type { GameContext } from '../context';
import { Scheduler } from '../scheduler';
import { AllianceService } from './alliances';
import { DroneService } from './drones';
import { GpsService } from './gps';
import { MaintenanceService } from './maintenance';
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
  maintenance: MaintenanceService;
  start(intervalMs: number): Promise<void>;
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
  const maintenance = new MaintenanceService(ctx, scheduler);
  return {
    gps,
    scheduler,
    drones,
    military,
    wars,
    ships,
    alliances,
    social,
    maintenance,
    start: async (intervalMs) => {
      await maintenance.ensureScheduled();
      scheduler.start(intervalMs);
    },
    stop: () => scheduler.stop(),
  };
}
