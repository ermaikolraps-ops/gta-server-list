# Assumptions, interpretations and open questions

The design spec leaves some rules open or ambiguous. To build a working game,
each gap was filled with the simplest reading consistent with the spec. None of
these is meant as an official rule: each one is listed here so it can be
confirmed or changed. Numeric values are parameters, marked *provisional* in
[game-parameters.md](game-parameters.md).

## Pending decisions from the spec (implemented as provisional parameters)

| Topic | Provisional choice | Where |
|---|---|---|
| Prices of units, bases, AA, drones, ships | about 1 credit per point of unit power; base 250, AA 400, drones 500/2,000/6,000, ship 3,000 | `units.*.price`, `bases.price`, `aa.price`, `drones.types.*.price`, `ships.price` |
| Unit statistics | attack/defence kept, HP rescaled for equal square-law strength | `units.*` and [combat.md](combat.md) |
| Damage constants and normalisation | K = 0.0367 (calibrated to 50 % median casualties), mitigation reference 5, lethality 0.5, survivor HP floor 10 %, tactical focus 60 %, variance ±10 % | `combat.*` |
| Exploration reward for players with no territory | 10 credits per new 0.1° zone, at most 20 per day | `economy.exploration*` |
| Shared conquest formula | parcels split by damage dealt (largest remainder), handed out in cell id order | `splitByContribution` in `server/src/services/wars.ts` |
| Repair price | 0.5 × unit price × share of HP restored | `bases.repairCostFactor` |
| Refund when an attack cancels repairs | none | `bases.repairCancelRefundFraction` |

## Interpretations

### World and GPS
1. A parcel is land when its centre point is on land.
2. A fix worse than 20 m restarts the 2-second timer (it proves nothing about
   presence); so does a silence longer than 10 s, or an implausible jump.
3. Exploration rewards count 0.1° zones (about 11 km), tracked only while the
   player holds no territory, to avoid storing location history.

### Drones
4. The drone radius is measured from the launch point to each target cell's centre.
5. The flight is launch → centre of the target group → launch, on great
   circles. The few seconds spent over a ≤2 km group are folded into the
   arrival instant.
6. If some targets are taken while the drone flies, the remaining targets may
   split into pieces. The drone captures the **largest** connected piece (ties:
   the piece with the lowest cell id) and leaves the rest.
7. A battery fires only from the moment it is built. A battery built while a
   drone is already inside its radius fires at once. An interception on the
   way back keeps the parcels already captured.
8. AA battery positions are private: other players are not shown them.

### Armies and movement
9. A route is the straight great-circle line between two points. Every cell it
   crosses must be land and neutral, own or allied (plus the war sector when
   heading into a war). The army's own starting cell is exempt. There is no
   automatic pathfinding: players move in legs.
10. The 100 km operational radius limits one movement order and the distance
    from which an army can join a war.
11. Recruits join an idle army standing on the base's parcel, or form one.
    Splitting moves damage with the units, proportionally.
12. Expeditionary forces: only for players with zero parcels, placed exactly at
    their current server-verified GPS position.

### Wars
13. A "valid military attack" needs at least one attacking army within 2 km of
    the sector at declaration. Other armies within 100 km may be sent and join
    when they arrive.
14. Automatic defence uses the **defender's own** idle armies (not moving, not
    repairing elsewhere, not in another war) within 100 km and with a valid
    route. Allies are not dispatched automatically; they can reinforce by hand.
15. An AA battery in the sector prevents the immediate surrender, but has no
    strength in the ground battle.
16. Only parcels the defender still owns when the war ends change hands. Bases
    and AA batteries on conquered parcels are destroyed, not captured.
17. Winners stay where they are (attackers at the front). Defeated survivors
    retreat to the nearest own or allied parcel within 100 km with a valid
    route; leaving the war sector is allowed. With no such route, they are
    destroyed.
18. Reinforcements still on the road when the war ends stop where they are;
    troops still at sea stay aboard and land normally.
19. Diminishing returns reduce fire only. Defence, HP and the winner
    comparison are unaffected (see [combat.md](combat.md)).
20. Victory power is `(attack + defence) / 2 × remaining HP fraction` per
    unit. The spec says it combines all three; the exact formula is provisional.
21. The enemy estimate shown during a war is a power-of-two band.

### Ships and alliances
22. Ships are bought on a coastal parcel the player owns, or where one of their
    armies stands. An army embarks when it stands within about 2 km of the ship.
23. Landing inside a sector of an active war that the player's side is
    attacking makes the landed army join that war on landing.
24. Only the alliance leader invites and removes members. A leader who leaves
    hands over to the longest-serving member; the last member to leave
    dissolves the alliance. Becoming allies does not end a war already under
    way.

### Notifications
25. Every notification is stored. Per-category settings control the live
    pop-ups. Push notifications while the app is closed are not implemented
    yet.

## Questions for the design team

- Should AA batteries take part in ground battles (they currently only block
  surrender and shoot drones)?
- Should allies auto-defend each other, or only by explicit reinforcement?
- Is the late-reinforcement outcome (defeated in detail) acceptable, or should
  armies arriving late get a defensive bonus?
- Artillery is the strongest pure force with the provisional stats (bonuses on
  two types, no counter). Should something counter it?
- Should GPS capture in the background be supported through a native app
  wrapper?
