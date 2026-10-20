# Combat

The engine (`packages/shared/src/combat/engine.ts`) is pure and deterministic:
the same starting state, seed and parameters always give the same war. Its
whole state is JSON (armies, round counter, RNG state, casualty carry), so the
server saves it after every round and resumes it exactly after a restart.

## Units and armies

Four unit types (infantry, armor, artillery, anti-armor), each with attack,
defence and HP ("resistance"). The numbers are **provisional**; see
[game-parameters.md](game-parameters.md).

An army is never a list of soldiers. Per unit type it holds a **headcount**
and the **total HP missing** across the living units (its wounds). A million
soldiers cost the same to simulate as ten.

- Firepower scales with headcount: wounded units still fire.
- Staying power is the remaining HP pool.
- Casualties are permanent; wounds persist after the war until repaired.

## A round (every 60 s, 180 rounds = exactly 180 minutes)

1. **Who fights:** armies of each side that have reached the front and whose
   first full round has come. An army that arrives during round *k* counts for
   victory at once but fires from round *k + 1*.
2. **Diminishing returns:** each side's raw power *P* (all its firing armies
   together) gives an efficiency *e = P_eff / P*, where
   *P_eff = P* if *P ≤ 10,000*, else *10,000 × (1 + ln(P/10,000))*.
3. **Fire:** every attacking type fires
   `headcount × attack × K × e × v` damage, where *K* is the calibrated damage
   constant and *v* a seeded per-side variance (±10 %).
4. **Tactical targeting:** 60 % of a type's fire goes to the enemy types it has
   a bonus against (when present). The rest is spread over all enemy types by
   their share of the enemy HP pool. Bonus targets take **+50 %** (approved):
   infantry → anti-armor, armor → infantry, artillery → infantry and
   anti-armor, anti-armor → armor.
5. **Mitigation:** damage on a type is multiplied by `5 / (5 + defence)`.
6. **Simultaneous resolution:** both sides' fire is computed from the state at
   the start of the round, then applied together. A side wiped out in a round
   still fires in it.
7. **Wounds and casualties:** half of the incoming damage (the lethality) lands
   as killing blows on average-health units; the rest spreads as wounds.
   Survivors never average below 10 % HP (the excess becomes casualties).
   Fractional casualties are owed **per side and unit type** and handed out as
   whole units by largest remainder, so how a side is split into armies
   changes nothing.

A war goes on even if one side has no units left, because reinforcements may
still arrive.

## Victory

After round 180, the side with more **victory power** wins; a tie goes to the
defender. Victory power combines attack, defence and remaining resistance:

```
power(stack) = (attack + defence) / 2 × (remaining HP / HP per unit)
```

i.e. each unit counts the mean of its attack and defence, scaled by its
remaining health. Every army that has arrived counts, including one that
arrived after the last round started.

## How diminishing returns interacts with attack, defence and victory

| Aspect | Effect of the curve | Why |
|---|---|---|
| Attack | Fire scaled by *e = P_eff / P* | This is where large blobs lose efficiency. |
| Defence (mitigation) | None | Defence is per-unit protection; numbers don't make each unit tougher or softer. |
| HP / headcount | None | The rules forbid artificially reducing units or their resistance. |
| Victory | No change to the winner | *P_eff* is strictly increasing, so comparing *P_eff* gives the same winner as comparing *P*. The effective values are reported for display only. |
| Splitting armies | No effect | *e* is computed per side and front from the sum of all armies, and casualty rounding is per side. |

Tests cover each row: the fire ratio equals *e* exactly; units and HP are
untouched; five armies against one give the same final powers (within 10⁻⁴);
and effective power never flips the winner.

## Calibration

The target is about 40–60 % casualties in balanced wars. The lab bisects the
damage constant *K* until the median casualty rate in the `balanced-small`
scenario (mirror combined-arms forces of ~2,200 power) is 50 %:
*K = 0.0367* (provisional).

The provisional HP values were also rescaled so that every unit type has equal
square-law strength: `attack × HP × (5 + defence) / 5 / ((attack + defence) / 2)²`.
With that, the approved +50 % bonuses alone decide equal-power duels (see the
matchup table).

## Lab results (1,000 battles per scenario, seed 1, current defaults)

| Scenario | Attacker wins | Attacker casualties p10 / median / p90 | Defender casualties p10 / median / p90 |
|---|---|---|---|
| balanced-small (~2,200 power each) | 49.6 % | 41.7 / 49.9 / 60.8 % | 41.3 / 49.8 / 60.4 % |
| balanced-threshold (~10,000 each) | 49.3 % | 41.6 / 49.8 / 60.5 % | 41.2 / 49.5 / 60.0 % |
| balanced-large (~43,500 each) | 49.4 % | 31.1 / 34.0 / 37.4 % | 31.0 / 33.8 / 37.3 % |
| split-exploit (5 armies vs 1, same total) | 49.2 % | 33.7 / 33.9 / 34.1 % | 33.7 / 33.9 / 34.2 % |
| infantry vs armor (equal power) | 0.0 % | 40.9 / 44.4 / 48.4 % | 20.9 / 22.7 / 24.7 % |
| anti-armor vs armor | 100 % | 24.8 / 27.3 / 30.1 % | 52.4 / 58.4 / 65.5 % |
| artillery vs infantry | 100 % | 25.9 / 30.0 / 35.4 % | 100 % |
| combined arms vs all-infantry | 66.7 % | 33.1 / 35.6 / 38.4 % | 31.6 / 34.3 / 37.3 % |
| outnumbered 2 : 1 | 100 % | 7.9 / 9.9 / 12.6 % | 100 % |
| late reinforcement (half the defence arrives at round 91) | 99.9 % | 21.5 / 28.7 / 34.2 % | 52.6 / 61.8 / 73.0 % |
| empty sector, relief arrives at round 121 | 0.3 % | 16.7 / 19.0 / 22.0 % | 10.5 / 12.0 / 13.6 % |

Equal-power duels (attacker win rate; rows attack columns):

| | infantry | armor | artillery | anti-armor |
|---|---|---|---|---|
| infantry | 54 % | 0 % | 0 % | 100 % |
| armor | 100 % | 54 % | 52 % | 0 % |
| artillery | 100 % | 56 % | 56 % | 100 % |
| anti-armor | 0 % | 100 % | 0 % | 54 % |

### What the numbers say (for the designers)

- Balanced wars land on the 40–60 % casualty target below and at the
  threshold. Above it, both sides fire less efficiently, so casualties drop to
  about 34 %. That is the intended effect of diminishing returns.
- Lanchester dynamics are strong: a 2 : 1 advantage annihilates the smaller
  force while losing about 10 %, and reinforcements that arrive late are
  defeated in detail. If that is too harsh, the levers are the lethality, the
  variance and how fire is spread.
- Artillery has bonuses against two types and nothing has a bonus against it,
  so it is the strongest pure force. Its price or a counter bonus is a design
  decision pending simulation.

Reproduce with `pnpm lab run --battles 1000 --seed 1`, `pnpm lab matchups`
and `pnpm lab calibrate`.

## Enemy information

During a war, players see their own side exactly (power and each army) and the
enemy only as a power-of-two band (for example 1,024–2,048). The public map
shows where wars are fought, but not the forces.
