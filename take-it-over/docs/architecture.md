# Architecture

## Components

```
 Phone / desktop browser (PWA)                         Server (Node.js, one process)
 ┌──────────────────────────────┐   HTTPS JSON     ┌──────────────────────────────────────┐
 │ React UI, MapLibre map       │ ───────────────▶ │ Fastify routes (zod-validated)       │
 │ GPS tracker (watchPosition)  │   WebSocket /ws  │ Auth (scrypt, session cookie, CSRF)  │
 │ i18n EN (default) / ES       │ ◀──────────────▶ │ Game services                        │
 │ Service worker (app shell)   │                  │   gps · economy · territory · drones │
 └──────────────────────────────┘                  │   military · wars · ships · alliances│
                                                   │ Durable job scheduler                │
                                                   │ Event outbox → WebSocket fan-out     │
                                                   └──────────────┬───────────────────────┘
                                                                  │ SQL
                                                   ┌──────────────▼───────────────────────┐
                                                   │ PostgreSQL 16 + PostGIS 3            │
                                                   │ players, parcels, armies, wars, jobs │
                                                   │ land_polygons, water_polygons        │
                                                   └──────────────────────────────────────┘
```

`packages/shared` holds everything both sides must agree on and that is pure
and deterministic: the world grid, geodesy, the parameter registry, credit
unit maths, the combat engine and drone flight maths. The server imports it
for authority, the client for display and instant feedback, and the lab for
simulation.

## Authority model

The server is the only authority over credits, positions, captures,
movements, wars and damage. Clients send *intentions* and *raw observations*
only:

- **GPS:** the client sends raw fixes (lat, lon, declared accuracy). The server
  maps them to cells, times the 2-second dwell with its own clock, and decides
  captures. Drone launches and expeditionary deployments use the server's
  record of the last accepted fix, never a position in the request.
- **Actions** (buy, launch, move, declare war…) are validated against the
  database inside one transaction. Nothing computed by the client (costs,
  routes, arrival times, damage) is trusted.
- **Combat** runs only on the server; clients get their own side's exact
  numbers and a power-of-two band for the enemy.

## Persistence and time

Everything that must survive a restart lives in PostgreSQL. In-memory state is
limited to things that may be lost safely: GPS presence (a player just needs
another 2 seconds), caches (land per cell), and rate-limit counters.

**Lazy economy.** A player row stores its balance at `settled_at` and its
parcel count. Income is computed on read and *settled* (written) whenever
credits or the parcel count change, at the exact instant of the change, so a
parcel that changes hands splits its income precisely. Credits are integers
in units of 1/3,600,000 credit (one parcel-millisecond), so settlement never
rounds.

**Durable timers.** Drone arrivals and returns, interceptions, army
arrivals, repairs, war rounds, ship arrivals and housekeeping are rows in the
`jobs` table. The scheduler claims one due job at a time with
`FOR UPDATE SKIP LOCKED` and runs its handler *in the same transaction* as
the job's completion, so effects happen exactly once even if the process
dies mid-way. Handlers use the job's scheduled time as the event time, so
after downtime the backlog replays in chronological order with correct
timestamps. A war's full state (including its RNG state) is saved after every
round, so a restart resumes it exactly.

## Consistency rules

- **No double claims:** parcels have the cell id as primary key; claims are
  `INSERT … ON CONFLICT DO NOTHING`.
- **No double spending:** spending locks the player row (`FOR UPDATE`) and
  checks the settled balance in the same transaction.
- **No duplicate actions:** purchases, launches, moves and war declarations
  accept an `Idempotency-Key`; the key is stored in the same transaction as
  the effect and replays the original response.
- **Exclusive armies:** an army has one status; `at_war` requires a `war_id`
  (a check constraint). Only idle armies can be given orders.
- **One war per parcel:** `war_cells` has the cell id as primary key.
- **Deadlocks:** player rows are always locked in id order; deadlocks and
  serialization failures are retried.

## Real-time updates

Services collect events in an *outbox* during their transaction and publish
them only after commit. The WebSocket hub forwards each event to the
player's open sockets. Notifications are also stored, so a player who was
offline sees them on return. Each player chooses per category which events
raise a toast.

## Security

- Passwords: scrypt (N=2^15, r=8, p=1, 16-byte salt), constant-time compare,
  dummy hash for unknown users (no username probing via timing).
- Sessions: 256-bit random tokens; only SHA-256 hashes are stored;
  `HttpOnly`, `SameSite=Lax`, `Secure` in production; 30-day expiry.
- CSRF: state-changing API calls require an `X-TIO-Client` header (cannot be
  sent cross-site without a CORS preflight, which is never granted), and the
  `Origin`, when present, must match. WebSocket handshakes check the origin.
- Input: every body and query is validated with zod; cell ids, coordinates
  and unit counts are range-checked.
- Rate limits: global per player/IP, stricter on login/registration, GPS
  fixes throttled per player.
- Privacy: no GPS trail is stored. Only the latest fix is kept, in memory.
  Anomaly records hold derived numbers (speed, distance, cell id) and are
  deleted after 30 days. Exploration tracking stores coarse 0.1° zone ids only
  while a player holds no territory.

## Scaling notes

The current build targets a single server instance. The pieces that would
change to scale out:

| Concern | Now | Scale-out path |
|---|---|---|
| Scheduler | Postgres jobs, `SKIP LOCKED` | already multi-instance safe |
| GPS presence | in memory | route each player's GPS to one instance (sticky WebSocket) or move presence to Redis |
| WebSocket fan-out | in-process event bus | Postgres `LISTEN/NOTIFY` or Redis pub/sub |
| Rate limits | in memory | `@fastify/rate-limit` Redis store |
| Territory reads | indexed queries on `parcels` | read replicas, vector tiles of territory for low zoom |
| Land checks | PostGIS + LRU cache | precomputed land bitmap per grid band |

Only owned parcels are stored; the ~1.5 × 10¹⁰ neutral land cells never are.
Armies are aggregates (count and damage per unit type), never individual
soldiers.
