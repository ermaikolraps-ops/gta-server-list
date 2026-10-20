/**
 * Wire types shared by the server and the web client.
 */
import type { Composition, Side } from './combat/engine';
import type { CellId } from './grid/cells';
import type { DroneType } from './params';

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

// ---------------------------------------------------------------- Phase C


export interface LatLonDto {
  lat: number;
  lon: number;
}

export interface DroneDto {
  id: string;
  type: DroneType;
  status: 'idle' | 'flying' | 'destroyed';
  radiusKm: number;
}

export interface MissionDto {
  id: string;
  droneId: string;
  status: 'outbound' | 'returning' | 'completed' | 'destroyed';
  launch: LatLonDto;
  target: LatLonDto;
  targets: CellId[];
  captured: CellId[];
  launchedAt: number;
  arriveAt: number;
  returnAt: number;
  destroyedAt: number | null;
}

export type TargetStatus = 'ok' | 'water' | 'owned' | 'out_of_range';

export interface DronePreview {
  ok: boolean;
  connected: boolean;
  tooMany: boolean;
  radiusKm: number;
  launch: LatLonDto | null;
  cells: { cell: CellId; status: TargetStatus }[];
  arriveAt?: number;
  returnAt?: number;
}

export interface MovementDto {
  from: LatLonDto;
  to: LatLonDto;
  departAt: number;
  arriveAt: number;
}

export interface ArmyDto {
  id: string;
  status: 'idle' | 'moving' | 'at_war' | 'repairing' | 'sailing' | 'retreating';
  lat: number;
  lon: number;
  units: Composition;
  headcount: number;
  power: number;
  /** Remaining HP as a share of full health (0..1). */
  health: number;
  movement: MovementDto | null;
  warId: string | null;
  warSide: Side | null;
  shipId: string | null;
  repair: { baseId: string; finishesAt: number; cost: number } | null;
  baseId: string | null;
}

export interface BaseDto {
  id: string;
  cellId: CellId;
  lat: number;
  lon: number;
  ownerId: string;
  ownerName: string;
  mine: boolean;
}

export interface AaDto {
  id: string;
  cellId: CellId;
  lat: number;
  lon: number;
}

export interface ShipDto {
  id: string;
  status: 'idle' | 'sailing';
  lat: number;
  lon: number;
  route: LatLonDto[] | null;
  departAt: number | null;
  arriveAt: number | null;
  cargoArmyId: string | null;
}

export interface WarSideView {
  /** Exact for the viewer's side. */
  power?: number;
  /** Coarse band for the other side. */
  band?: [number, number];
  armies?: { id: string; ownerName: string; mine: boolean; headcount: number; power: number; arriveAt: number | null }[];
}

export interface WarDto {
  id: string;
  status: 'active' | 'finished';
  role: Side;
  attacker: { id: string; name: string };
  defender: { id: string; name: string };
  sector: CellId[];
  center: LatLonDto;
  startedAt: number;
  endsAt: number;
  round: number;
  totalRounds: number;
  friendly: WarSideView;
  enemy: WarSideView;
  winner: Side | null;
  outcome: WarOutcome | null;
}

export interface WarOutcome {
  winner: Side;
  surrendered: boolean;
  power: Record<Side, number>;
  effectivePower: Record<Side, number>;
  casualties: Record<Side, number>;
  conquered: CellId[];
  retreated: string[];
  destroyedArmies: string[];
}

export interface PublicWarDto {
  id: string;
  center: LatLonDto;
  sector: CellId[];
  attacker: string;
  defender: string;
  endsAt: number;
}

export interface AllianceDto {
  id: string;
  name: string;
  color: string;
  leaderId: string;
  members: { id: string; name: string; color: string; parcels: number }[];
  invites: { playerId: string; name: string }[];
}

export interface MyAllianceView {
  alliance: AllianceDto | null;
  invitations: { allianceId: string; name: string; color: string }[];
  maxMembers: number;
}

export interface NotificationDto {
  id: number;
  category: string;
  key: string;
  params: Record<string, string | number>;
  tone: 'info' | 'good' | 'bad';
  createdAt: number;
  read: boolean;
}

export type RankingMetric = 'territory' | 'wars' | 'drones';

export interface RankingDto {
  metric: RankingMetric;
  rows: { rank: number; id: string; name: string; color: string; value: number }[];
  me: { rank: number; value: number } | null;
}
