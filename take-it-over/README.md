# Take It Over!

A persistent, world-wide multiplayer game of territorial conquest played on the
real map. Walk onto 100 × 100 m parcels to capture them with GPS, send drones to
grab neutral land up to 1,500 km away, raise armies, and wage 180-minute wars
over enemy sectors. Every parcel earns 1 credit per hour, forever.

The game runs as an installable mobile web app (PWA) backed by an authoritative
Node.js server and PostgreSQL + PostGIS. English is the default language; a
complete Spanish translation is included.

> Status: playable development build. All three implementation phases work and
> are tested, but many balance values are **provisional** placeholders (see
> [docs/game-parameters.md](docs/game-parameters.md)). Nothing has been deployed
> to production.

## What works

| Phase | Feature | State |
|---|---|---|
| A | Accounts (scrypt passwords, http-only sessions, CSRF and rate limits) | ✅ |
| A | World grid of ~100 m parcels on the WGS84 ellipsoid, side-only adjacency | ✅ |
| A | Land/water mask (PostGIS, Natural Earth by default, OSM-ready) | ✅ |
| A | Persistent economy: 1,000 starting credits, 1 credit/parcel/hour, offline income | ✅ |
| A | GPS capture: 2 s server-timed dwell, ≤20 m accuracy, permissive anti-cheat | ✅ |
| A | Dark military map (MapLibre) with live territory, alliance colours when zoomed out | ✅ |
| B | Deterministic combat engine: 180 rounds, bonuses, wounds, reinforcements, ties | ✅ |
| B | Diminishing returns per side and front; splitting armies gains nothing | ✅ |
| B | Battle lab: thousands of seeded battles, calibration, matchup matrix | ✅ |
| C | Drones: 300/600/1,500 km, 300 km/h, 10 in flight, 20 targets, AA on both legs | ✅ |
| C | Bases, instant recruitment, 30-minute repairs, AA batteries, expeditionary forces | ✅ |
| C | Wars: auto-defence within 100 km, surrender, retreat, shared conquest | ✅ |
| C | Sea transport with water-verified routes; alliances of up to 10 | ✅ |
| C | WebSocket live updates, stored notifications with per-category settings, rankings | ✅ |

Test suite: 149 automated tests (shared 65, server 75, lab 5, web 4), most of
them integration tests against a real PostgreSQL + PostGIS database, including
server restarts in the middle of drone flights and wars.

## Quick start with Docker

Requires Docker with Compose v2.

```bash
cd take-it-over
docker compose up -d db
docker compose run --rm land     # once: downloads Natural Earth land/lakes (~15 MB) and loads it
docker compose up -d app         # http://localhost:8080
```

Open http://localhost:8080 on a phone or desktop browser, create an account and
press **Start GPS**. Browsers only give location to secure origins, so on a
phone use HTTPS (see *Putting it on your website*) or `localhost` with port
forwarding.

## Local development without Docker

Requires Node.js 22+, pnpm 10 (`corepack enable`), and PostgreSQL 16 with
PostGIS 3.

```bash
cd take-it-over
pnpm install
createdb takeitover                 # and a role matching DATABASE_URL (see .env.example)
pnpm land:fetch && pnpm land:load   # land mask (or set TIO_LAND_MASK=permissive to skip)
pnpm dev:server                     # API on :8080, migrations run automatically
pnpm dev:web                        # PWA on :5173, proxied to the API
```

## Tests

```bash
createdb takeitover_test            # wiped and rebuilt on every run — never point it at real data
pnpm test                           # all packages
pnpm typecheck
```

The server tests read `TEST_DATABASE_URL`
(default `postgres://tio:tio@localhost:5432/takeitover_test`) and load a small
synthetic world (a mainland with a lake, an island and a far continent) into
PostGIS, so they need no downloads.

## Battle lab

```bash
pnpm lab list                          # scenarios
pnpm lab run --battles 1000 --seed 1   # metrics table + JSON in lab-output/
pnpm lab calibrate                     # damage constant for ~50% casualties in balanced wars
pnpm lab matchups                      # equal-power duels between unit types
pnpm lab run --params my-balance.json  # try a parameter override
```

Every battle is reproducible from (scenario, seed, parameters). See
[docs/combat.md](docs/combat.md) for the model and the current results.

## Putting it on your website

The game is not a static site: the server is the only authority over credits,
territory, drones and wars, so it needs a host that runs a Node.js process (or
Docker) next to PostgreSQL + PostGIS. A small VPS is enough to start.

1. Run the Docker image (or `pnpm build` then `pnpm --filter @tio/server start`
   with `TIO_WEB_DIST=packages/web/dist`). It serves the PWA, the API and the
   WebSocket on one port.
2. Put it behind HTTPS on your domain, for example `play.yourdomain.com`, with
   a reverse proxy (Caddy, nginx, Traefik). HTTPS is mandatory: browsers block
   GPS and service workers on insecure origins. Forward WebSocket upgrades for
   `/ws`.
3. Set `NODE_ENV=production` (secure cookies), `TIO_TRUST_PROXY=true` behind the
   proxy, strong database credentials, and back up the database.
4. Load land data once. For accurate coastlines load OSM land polygons (see
   [docs/maps-and-land.md](docs/maps-and-land.md)).
5. Review the map-tile provider's terms for your traffic, or self-host tiles.

To link it from an existing site, a plain link or a button to the game URL
works; embedding it in an iframe is not recommended (GPS permission prompts are
restricted in cross-origin frames).

## Configuration

All settings are environment variables; see [.env.example](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://tio:tio@localhost:5432/takeitover` | PostgreSQL + PostGIS |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP and WebSocket listener |
| `TIO_LAND_MASK` | `postgis` | `permissive` treats everything as land (development only) |
| `TIO_WEB_DIST` | — | Directory of the built PWA to serve |
| `TIO_COOKIE_SECURE` | `true` in production | Secure session cookies |
| `TIO_ALLOWED_ORIGINS` | — | Extra origins allowed to send state-changing requests |
| `TIO_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` from a reverse proxy |
| `TIO_PARAMS_FILE` | — | JSON overrides of game parameters (validated) |
| `TIO_RATE_LIMIT_GLOBAL` / `_AUTH` / `_GPS` | 300 / 10 / 600 | Requests per minute |
| `VITE_MAP_TILEJSON` / `VITE_MAP_GLYPHS` | OpenFreeMap | Vector tiles and fonts (build time) |

## Project layout

```
take-it-over/
  packages/
    shared/   grid, geodesy, parameters, economy units, combat engine, drone flight maths, wire types
    server/   Fastify API + WebSocket, Postgres migrations, durable job scheduler, game services
    web/      React + Vite PWA, MapLibre map, panels, EN/ES translations
    lab/      battle lab CLI
  docs/       architecture, decisions, assumptions, rules and parameters
  scripts/    land data download
```

## Documentation

- [Architecture](docs/architecture.md): components, authority model, persistence, scaling
- [Decisions](docs/decisions.md): the main technical choices and why
- [World grid](docs/world-grid.md): how 100 m parcels are laid out on the ellipsoid
- [Combat](docs/combat.md): the engine, diminishing returns, calibration, lab results
- [GPS and security](docs/gps-and-security.md): GPS limits, PWA background limits, anti-cheat, security
- [Maps and land data](docs/maps-and-land.md): tile providers, attribution, land mask sources
- [Assumptions and open questions](docs/assumptions.md): interpretations of the spec and pending decisions
- [Game parameters](docs/game-parameters.md): every value, approved or provisional (generated)

## Known limitations

- Balance values (prices, unit stats, exploration reward, shared-conquest
  formula) are provisional; see the parameters doc.
- Land and sea routes are straight great-circle legs; there is no automatic
  pathfinding around obstacles (players add waypoints or move in legs).
- The default Natural Earth coastline is accurate to roughly 1 km; production
  should load OSM land polygons.
- GPS capture only works while the app is open and on screen (a PWA limit).
- Push notifications while the app is closed are not implemented yet; players
  see stored notifications when they come back.
- Single-instance defaults: rate limits, GPS presence and WebSocket fan-out are
  in memory. Scaling out needs sticky GPS routing and a shared pub/sub (see the
  architecture doc). The scheduler itself is already multi-instance safe.

## Credits

Map data © OpenStreetMap contributors (ODbL), tiles by OpenFreeMap /
OpenMapTiles. Land mask from Natural Earth (public domain). Map rendering by
MapLibre GL JS (BSD-3-Clause).
