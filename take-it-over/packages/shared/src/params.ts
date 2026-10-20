/**
 * Game parameters. Every leaf records whether it is an APPROVED rule from the
 * design spec or a PROVISIONAL placeholder that still needs simulation or a
 * design decision. Provisional values exist only so the game can run; they
 * are listed in docs/game-parameters.md and exposed at GET /api/params.
 *
 * The server can override any value with a JSON file (TIO_PARAMS_FILE) without
 * a code change; overrides are validated against this tree.
 */

export const UNIT_TYPES = ['infantry', 'armor', 'artillery', 'antiArmor'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const DRONE_TYPES = ['basic', 'advanced', 'longRange'] as const;
export type DroneType = (typeof DRONE_TYPES)[number];

export type ParamStatus = 'approved' | 'provisional';

export interface ParamDef<T> {
  readonly value: T;
  readonly status: ParamStatus;
  readonly note?: string;
}

const approved = <T>(value: T, note?: string): ParamDef<T> => ({ value, status: 'approved', note });
const provisional = <T>(value: T, note: string): ParamDef<T> => ({ value, status: 'provisional', note });

const PRICE_PENDING = 'Price pending balance simulations.';
const STAT_PENDING = 'Unit stats not yet approved; tune with the battle lab.';

export const PARAM_DEFS = {
  economy: {
    startingCredits: approved(1000),
    creditsPerParcelPerHour: approved(1, 'Linear, uncapped, accrues while offline. Must stay an integer (exact unit maths).'),
    explorationRewardCredits: provisional(
      10,
      'Credits for entering a never-visited 0.1° zone while holding zero parcels. Exact reward pending.',
    ),
    explorationMaxRewardsPerDay: provisional(20, 'Daily cap on exploration rewards. Pending.'),
  },
  gps: {
    maxAccuracyM: approved(20, 'Fixes with a declared accuracy worse than this are ignored.'),
    dwellMs: approved(2000, 'Continuous time in one neutral cell needed to conquer it.'),
    maxFixGapMs: provisional(
      10000,
      'Longest gap between fixes that still counts as continuous presence for the dwell timer.',
    ),
    freshFixMs: provisional(
      15000,
      'Max age of the last accepted fix for actions that need the real position (drone launch, expeditionary deployment).',
    ),
    minFixIntervalMs: provisional(250, 'Fixes arriving faster than this are dropped (rate limit).'),
    implausibleSpeedKmh: provisional(
      1200,
      'Implied speed between consecutive fixes above which an anomaly is logged. Any real speed is allowed; one jump is never proof.',
    ),
    anomalyWindowHours: provisional(24, 'Rolling window for counting anomalies.'),
    anomalyThreshold: provisional(30, 'Anomalies within the window that suspend GPS conquest.'),
    suspensionHours: provisional(12, 'Length of a GPS-conquest suspension after repeated abuse.'),
  },
  drones: {
    speedKmh: approved(300),
    maxActive: approved(10),
    maxTargets: approved(20),
    types: {
      basic: { radiusKm: approved(300), price: provisional(500, PRICE_PENDING) },
      advanced: { radiusKm: approved(600), price: provisional(2000, PRICE_PENDING) },
      longRange: { radiusKm: approved(1500), price: provisional(6000, PRICE_PENDING) },
    },
  },
  aa: {
    radiusKm: approved(5),
    price: provisional(400, PRICE_PENDING),
  },
  units: {
    infantry: {
      attack: provisional(1, STAT_PENDING),
      defense: provisional(1.2, STAT_PENDING),
      hp: provisional(10, STAT_PENDING),
      price: provisional(1, PRICE_PENDING),
    },
    armor: {
      attack: provisional(8, STAT_PENDING),
      defense: provisional(10, STAT_PENDING),
      hp: provisional(60, STAT_PENDING),
      price: provisional(14, PRICE_PENDING),
    },
    artillery: {
      attack: provisional(9, STAT_PENDING),
      defense: provisional(2, STAT_PENDING),
      hp: provisional(20, STAT_PENDING),
      price: provisional(9, PRICE_PENDING),
    },
    antiArmor: {
      attack: provisional(4, STAT_PENDING),
      defense: provisional(3, STAT_PENDING),
      hp: provisional(16, STAT_PENDING),
      price: provisional(5, PRICE_PENDING),
    },
  },
  combat: {
    bonusMultiplier: approved(1.5, '+50% damage on the approved matchups.'),
    diminishingThreshold: approved(10000, 'Power per side per front before the logarithmic curve applies.'),
    damagePerAttackPerRound: provisional(
      0.0102,
      'Damage constant. Calibrated with the battle lab so balanced 180-round wars lose ~40–60% (see docs/combat.md).',
    ),
    defenseReference: provisional(5, 'Mitigation = ref / (ref + defense).'),
    lethality: provisional(0.5, 'Share of incoming damage that lands as killing blows; the rest becomes wounds.'),
    minSurvivorHpFraction: provisional(0.1, 'Survivors never average below this HP fraction; excess becomes casualties.'),
    tacticalFocus: provisional(0.6, 'Share of fire aimed at preferred (bonus) targets; the rest is spread by headcount.'),
    variance: provisional(0.1, 'Seeded ±variance on each round of fire.'),
  },
  war: {
    durationMinutes: approved(180),
    roundSeconds: approved(60),
    maxSectorParcels: approved(100),
    autoDefenseRadiusKm: approved(100),
    frontProximityKm: provisional(2, 'An attacking army must be this close to the sector to declare war.'),
  },
  armies: {
    speedKmh: approved(100),
    operationalRadiusKm: approved(100),
    routeSampleM: provisional(50, 'Spacing of route samples checked for water and foreign territory.'),
  },
  bases: {
    price: provisional(250, PRICE_PENDING),
    repairMinutes: approved(30),
    repairCostFactor: provisional(0.5, 'Repair cost = factor × unit price × share of HP restored. Rate pending.'),
    repairCancelRefundFraction: provisional(0, 'Share refunded when an attack cancels a repair. Pending.'),
  },
  ships: {
    speedKmh: approved(100),
    capacityUnits: approved(10000),
    price: provisional(3000, PRICE_PENDING),
    routeSampleM: provisional(1000, 'Spacing of sea-route samples that must all be water.'),
    maxCoastDistanceM: provisional(1500, 'How close to water a land point must be to count as coast.'),
  },
  alliances: {
    maxMembers: approved(10),
  },
} as const;

type Widen<T> = T extends number ? number : T extends string ? string : T extends boolean ? boolean : T;
export type ParamValues<T> = T extends ParamDef<infer V> ? Widen<V> : { [K in keyof T]: ParamValues<T[K]> };
export type GameParams = ParamValues<typeof PARAM_DEFS>;

function isDef(x: unknown): x is ParamDef<unknown> {
  return typeof x === 'object' && x !== null && 'status' in x && 'value' in x;
}

function extract(node: unknown): unknown {
  if (isDef(node)) return node.value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = extract(v);
  return out;
}

export const DEFAULT_PARAMS: GameParams = Object.freeze(extract(PARAM_DEFS)) as GameParams;

export interface ParamEntry {
  path: string;
  value: unknown;
  defaultValue: unknown;
  status: ParamStatus;
  note?: string;
}

/** Flat list of every parameter with its status, for docs, the API and balance tools. */
export function paramCatalog(params: GameParams = DEFAULT_PARAMS): ParamEntry[] {
  const out: ParamEntry[] = [];
  const walk = (node: unknown, values: unknown, path: string[]) => {
    if (isDef(node)) {
      out.push({
        path: path.join('.'),
        value: values,
        defaultValue: node.value,
        status: node.status,
        ...(node.note ? { note: node.note } : {}),
      });
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, (values as Record<string, unknown>)[k], [...path, k]);
    }
  };
  walk(PARAM_DEFS, params, []);
  return out;
}

/**
 * Applies a partial override tree. Unknown keys and type changes are rejected
 * so a typo in a balance file can never silently create a new rule.
 */
export function mergeParams(base: GameParams, override: unknown): GameParams {
  const merge = (def: unknown, cur: unknown, ov: unknown, path: string): unknown => {
    if (ov === undefined) return cur;
    if (isDef(def)) {
      if (typeof ov !== typeof def.value) throw new Error(`param ${path}: expected ${typeof def.value}`);
      if (typeof ov === 'number' && !Number.isFinite(ov)) throw new Error(`param ${path}: not finite`);
      return ov;
    }
    if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) throw new Error(`param ${path}: expected object`);
    const out: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
    for (const [k, v] of Object.entries(ov)) {
      const childDef = (def as Record<string, unknown>)[k];
      if (childDef === undefined) throw new Error(`unknown param ${path ? path + '.' : ''}${k}`);
      out[k] = merge(childDef, (cur as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k);
    }
    return out;
  };
  const merged = merge(PARAM_DEFS, base, override, '') as GameParams;
  if (!Number.isInteger(merged.economy.creditsPerParcelPerHour)) {
    throw new Error('param economy.creditsPerParcelPerHour must be an integer');
  }
  return merged;
}

/** Approved +50% matchups: attacker → targets it deals bonus damage to. */
export const BONUS_TARGETS: Readonly<Record<UnitType, readonly UnitType[]>> = {
  infantry: ['antiArmor'],
  armor: ['infantry'],
  artillery: ['infantry', 'antiArmor'],
  antiArmor: ['armor'],
};

export function bonusMultiplier(attacker: UnitType, target: UnitType, params: GameParams): number {
  return BONUS_TARGETS[attacker].includes(target) ? params.combat.bonusMultiplier : 1;
}
