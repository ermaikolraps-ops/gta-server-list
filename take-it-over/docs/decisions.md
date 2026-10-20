# Technical decisions

Short records of the main choices. Each says what was decided, why, and what
was traded away.

## 1. A pnpm monorepo inside the existing repository

The repository already held an unrelated Python desktop app (GTA Server
List), so the game lives in `take-it-over/` without touching it. Four
packages: `shared` (pure rules and maths), `server`, `web`, `lab`.
*Trade-off:* one repo, two products; CI and docs are scoped to the folder.

## 2. TypeScript everywhere; the server runs with tsx

One language for rules shared by server, client and lab. The server runs its
TypeScript directly with `tsx`, so there is no server build step to drift.
*Trade-off:* a slightly larger runtime image.

## 3. Fastify, `pg` and hand-written SQL; no ORM

Transactions, row locks, `SKIP LOCKED`, `ON CONFLICT` and PostGIS functions
are the heart of the consistency guarantees. Writing them as SQL keeps them
explicit and reviewable. Validation uses zod.

## 4. PostgreSQL + PostGIS as the single source of truth

Everything persistent is in Postgres; only owned parcels are stored (neutral
land is the absence of a row). PostGIS serves the land mask, the AA
proximity queries and line-to-point distances.

## 5. A banded WGS84 grid of ~100 m cells

Rows by true meridian distance; columns per latitude band so cells stay within
±1 % of 100 m wide; side-only adjacency, including partial sides across band
seams. The band table is frozen in the code. See [world-grid.md](world-grid.md).

## 6. Integer credit units with lazy settlement

1 credit = 3,600,000 units (one parcel-millisecond at 1 credit/hour), so
accrual is exact integer maths, settled at every change of credits or
territory. Balances are never stored as floats.

## 7. A durable job scheduler in Postgres

Timed events (drones, wars, repairs, movements, voyages) are rows run in the
same transaction as their effects: exactly-once, restart-safe,
multi-instance-safe with `SKIP LOCKED`, and replayed in event-time order after
downtime. No Redis or separate queue to operate. *Trade-off:* polling (default
every 500 ms) instead of push.

## 8. Aggregated armies and a pure, serializable combat engine

Armies are counts plus total wounds per unit type. The engine's full state
(including RNG and casualty carry) is JSON, saved after every round. Casualty
rounding is per side, so splitting armies is neutral. The same engine powers
the server and the lab.

## 9. The server owns GPS timing and position

Dwell is measured with the server clock; drones and expeditions launch from
the server's own record of the latest fix. The client cannot claim a capture
or a launch position.

## 10. Cookie sessions with a custom-header CSRF guard

HttpOnly cookies avoid exposing tokens to scripts; a required custom header
plus an Origin check stops cross-site requests. Sessions are revocable rows.

## 11. A parameter registry with approved / provisional status

Every number lives in one tree with its status and a note; overrides come from
a validated JSON file; the docs table is generated from it and tested for
drift. This keeps pending decisions visible instead of silently becoming rules.

## 12. Open map data, self-hostable

MapLibre with a custom dark style over OpenMapTiles-schema vector tiles
(OpenFreeMap by default, configurable). Land mask from Natural Earth by
default, OSM land polygons for production. See [maps-and-land.md](maps-and-land.md).

## 13. English by default, typed translations

All UI strings live in an English dictionary; the Spanish dictionary must
cover every key (a type error otherwise), and a test checks that every
notification and error code the server sends has a translation.
