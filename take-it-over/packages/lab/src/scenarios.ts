import type { Side, UnitType } from '@tio/shared';

export interface ArmySpec {
  side: Side;
  owner?: string;
  units: Partial<Record<UnitType, number>>;
  /** First round this army fights in (reinforcements). Default 1. */
  fromRound?: number;
}

export interface Scenario {
  id: string;
  description: string;
  armies: ArmySpec[];
  /** Each battle scales every unit count by a seeded factor in [1 - jitter, 1 + jitter]. */
  jitter: number;
}

/** A combined-arms force worth ~2,175 power with the provisional stats. */
const MIXED = { infantry: 1000, armor: 50, artillery: 50, antiArmor: 100 };
const scale = (u: Partial<Record<UnitType, number>>, k: number) =>
  Object.fromEntries(Object.entries(u).map(([t, n]) => [t, Math.round(n! * k)])) as Partial<Record<UnitType, number>>;

export const SCENARIOS: Scenario[] = [
  {
    id: 'balanced-small',
    description: 'Mirror match, combined arms, well below the diminishing-returns threshold (calibration target).',
    armies: [
      { side: 'attacker', units: MIXED },
      { side: 'defender', units: MIXED },
    ],
    jitter: 0.1,
  },
  {
    id: 'balanced-threshold',
    description: 'Mirror match at ~10,000 power per side (right at the threshold).',
    armies: [
      { side: 'attacker', units: scale(MIXED, 4.6) },
      { side: 'defender', units: scale(MIXED, 4.6) },
    ],
    jitter: 0.1,
  },
  {
    id: 'balanced-large',
    description: 'Mirror match at ~43,500 power per side: both sides fire at reduced efficiency.',
    armies: [
      { side: 'attacker', units: scale(MIXED, 20) },
      { side: 'defender', units: scale(MIXED, 20) },
    ],
    jitter: 0.1,
  },
  {
    id: 'split-exploit',
    description: 'Attacker splits ~43,500 power into five armies vs one defending army of the same size.',
    armies: [
      ...Array.from({ length: 5 }, (_, i) => ({ side: 'attacker' as const, owner: `a${i}`, units: scale(MIXED, 4) })),
      { side: 'defender', units: scale(MIXED, 20) },
    ],
    jitter: 0,
  },
  {
    id: 'infantry-vs-armor',
    description: 'Equal power: 2,000 infantry attack 245 armor (armor has the bonus).',
    armies: [
      { side: 'attacker', units: { infantry: 2000 } },
      { side: 'defender', units: { armor: 245 } },
    ],
    jitter: 0.05,
  },
  {
    id: 'antiarmor-vs-armor',
    description: 'Equal power: 630 anti-armor attack 245 armor (anti-armor has the bonus).',
    armies: [
      { side: 'attacker', units: { antiArmor: 630 } },
      { side: 'defender', units: { armor: 245 } },
    ],
    jitter: 0.05,
  },
  {
    id: 'artillery-vs-infantry',
    description: 'Equal power: 400 artillery attack 2,000 infantry (artillery has the bonus).',
    armies: [
      { side: 'attacker', units: { artillery: 400 } },
      { side: 'defender', units: { infantry: 2000 } },
    ],
    jitter: 0.05,
  },
  {
    id: 'combined-vs-infantry',
    description: 'Combined arms attack an all-infantry force of equal power.',
    armies: [
      { side: 'attacker', units: MIXED },
      { side: 'defender', units: { infantry: 1977 } },
    ],
    jitter: 0.05,
  },
  {
    id: 'outnumbered-2to1',
    description: 'Attacker brings twice the defender.',
    armies: [
      { side: 'attacker', units: scale(MIXED, 2) },
      { side: 'defender', units: MIXED },
    ],
    jitter: 0.1,
  },
  {
    id: 'late-reinforcement',
    description: 'Defender holds with half its force; the other half arrives for round 91.',
    armies: [
      { side: 'attacker', units: MIXED },
      { side: 'defender', units: scale(MIXED, 0.5) },
      { side: 'defender', owner: 'ally', units: scale(MIXED, 0.5), fromRound: 91 },
    ],
    jitter: 0.1,
  },
  {
    id: 'empty-then-relief',
    description: 'Sector starts undefended; a relief force arrives for round 121.',
    armies: [
      { side: 'attacker', units: MIXED },
      { side: 'defender', units: scale(MIXED, 1.2), fromRound: 121 },
    ],
    jitter: 0.1,
  },
];

export function scenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}; try: ${SCENARIOS.map((x) => x.id).join(', ')}`);
  return s;
}
