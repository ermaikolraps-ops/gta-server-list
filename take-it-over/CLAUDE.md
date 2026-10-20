# Take It Over! — guide for Claude

Persistent, worldwide multiplayer GPS game of territorial conquest (PWA +
Node.js + PostgreSQL/PostGIS). Read [docs/STATUS.md](docs/STATUS.md) first: it
says what is done, what is pending and what the owner has (and has not)
authorised.

## Owner's standing rules

- English is the game's default language; Spanish is a complete translation
  (`packages/web/src/i18n`). Keep both in sync.
- The server is authoritative for everything (credits, territory, GPS timing,
  drones, wars). Never move a game rule to the client.
- Pending design decisions are **provisional parameters**
  (`packages/shared/src/params.ts`), never invented rules. List new questions in
  `docs/assumptions.md`.
- Production is the owner's existing Ubuntu VPS, behind its existing reverse
  proxy and HTTPS. No external hosting (Vercel, Netlify, …). GitHub is for code
  only.
- **No deployment or production change without the owner's explicit go-ahead.**
  Inspect first (read-only), then show the exact plan/diff, then act. Never
  restart or modify the owner's other services; reload (not restart) the proxy.
- Never print, commit or paste secrets (passwords, private keys, `.env`).
- This code currently lives in a **public** repository. Keep server-specific
  operational details (IPs, service maps, runbooks) out of git: `deploy/sites/`
  is git-ignored for that reason.

## Layout

```
packages/shared   world grid (WGS84 bands, ~100 m cells), geodesy, params, economy units,
                  combat engine, drone flight maths, wire protocol types
packages/server   Fastify API + WebSocket, SQL migrations, durable job scheduler, services
packages/web      React + Vite PWA, MapLibre dark map, panels, EN/ES
packages/lab      battle lab CLI (seeded batches, calibration, matchups)
deploy/           production compose, deploy/backup scripts, VPS inspection, proxy templates
docs/             architecture, decisions, grid, combat, GPS/security, maps, assumptions, params
```

## Commands (from this folder)

```bash
pnpm install
pnpm typecheck
pnpm test        # needs PostgreSQL 16 + PostGIS 3 at TEST_DATABASE_URL
                 # (default postgres://tio:tio@localhost:5432/takeitover_test; wiped every run)
pnpm build       # web PWA -> packages/web/dist
pnpm dev:server  # :8080 (needs land data: pnpm land:fetch && pnpm land:load, or TIO_LAND_MASK=permissive)
pnpm dev:web     # :5173, proxied to the API
pnpm lab run --battles 1000 --seed 1
pnpm params:doc  # regenerate docs/game-parameters.md (a test fails if it drifts)
shellcheck -x deploy/*.sh deploy/scripts/*.sh
```

Quick database with Docker: `docker compose up -d db` (dev compose in this folder).
CI: `.github/workflows/ci.yml` (typecheck, tests against PostGIS, build, shellcheck).

## Invariants worth knowing before changing code

- Grid: cell id = row × 2^19 + col; side adjacency only; band table is frozen
  in `bandTable.generated.ts` (changing it changes every cell id). Tests in
  `packages/shared/test/grid-edges.test.ts` check it against an independent
  geometric oracle.
- Money: integer credit units (1 credit = 3,600,000 units), settled lazily at
  every change; ledger rows for every movement; idempotency keys on purchases.
- Jobs: `scheduler.ts` claims due jobs with `FOR UPDATE SKIP LOCKED` and runs
  each job in the same transaction as its effects (exactly once, catches up
  after downtime). Events go out through the outbox after commit.
- Combat: aggregated stacks, side-level casualty carry with largest remainder
  (splitting armies gains nothing), diminishing returns per side and front.
- Hosting under a path works: `TIO_PUBLIC_PATH=/takeitover/` (cookie path,
  prefix stripping), relative web build, `TIO_TRUST_PROXY=true` trusts exactly
  one proxy hop.

## Deployment kit

`deploy/README.md` is the generic plan. `deploy/scripts/deploy.sh --check` is a
read-only preflight; a deploy builds an image per commit, backs up the
database, loads land data on first install, health-checks and rolls back
automatically. `deploy/inspect-vps.sh` is a read-only server report.
