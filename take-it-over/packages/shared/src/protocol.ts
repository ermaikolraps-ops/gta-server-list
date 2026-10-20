/**
 * Wire types shared by the server and the web client.
 */
import type { CellId } from './grid/cells';

export interface Profile {
  id: string;
  username: string;
  color: string;
  locale: string;
  allianceId: string | null;
  credits: number;
  /** Fraction of the next credit already earned (0..1). */
  creditFraction: number;
  parcels: number;
  incomePerHour: number;
  notificationPrefs: Record<string, boolean>;
  gpsSuspendedUntil: string | null;
  serverTime: number;
}

export type GpsStatus =
  | 'rate_limited'
  | 'low_accuracy'
  | 'suspended'
  | 'water'
  | 'own'
  | 'enemy'
  | 'tracking'
  | 'conquered';

export interface GpsResult {
  status: GpsStatus;
  cell?: CellId;
  dwellMs?: number;
  requiredMs: number;
  ownerId?: string;
  explorationReward?: number;
}

export interface OwnerInfo {
  id: string;
  name: string;
  color: string;
  allianceId: string | null;
  allianceColor: string | null;
}

export type TerritoryView =
  | { mode: 'cells'; cells: [CellId, number][]; owners: OwnerInfo[]; truncated: boolean }
  | {
      mode: 'zones';
      zoneDeg: number;
      /** [latBin, lonBin, ownerIndex, parcelCount]; bins are zoneDeg wide from -90/-180. */
      zones: [number, number, number, number][];
      owners: OwnerInfo[];
      truncated: boolean;
    };

export interface CellInfo {
  cellId: CellId;
  bounds: { south: number; north: number; west: number; east: number };
  center: { lat: number; lon: number };
  land: boolean;
  owner: { id: string; name: string; color: string; since: string } | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  [k: string]: unknown;
}
