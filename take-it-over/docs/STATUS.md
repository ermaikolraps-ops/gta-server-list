# Project status and how to continue

Snapshot: 20 October 2026. Code: repository `ermaikolraps-ops/gta-server-list`,
branch `ccr-de69c801-k4cdlt`, folder `take-it-over/`.

## Done

- All three phases of the spec (A: accounts, grid, land mask, economy, GPS
  capture, dark map; B: combat engine and battle lab; C: drones, bases, AA,
  armies, wars, ships, alliances, WebSocket, notifications, rankings).
- 176 automated tests (shared 89, server 78, lab 5, web 4); typecheck clean;
  GitHub CI green.
- Hosting under a path of an existing site (`TIO_PUBLIC_PATH`), verified through
  a real nginx.
- Production kit in `deploy/` (compose project `takeitover`, loopback port,
  memory/CPU caps, preflight `--check`, per-commit images, backup before every
  deploy, health check, automatic and manual rollback, read-only VPS
  inspection). Verified in a sandbox on Ubuntu 26.04 packages (Docker 29.1,
  Compose 2.40, uutils, sudo-rs) and with Docker's own packages. Measured:
  idle ~130 MiB; 100 players with GPS every second ~330 MiB, all requests
  served (p95 98 ms) under the default caps (app 1 CPU, db 0.5 CPU).

## Not done / pending

1. **Deployment: NOT deployed, VPS not inspected yet.**
   - Target confirmed by the owner: **https://gamerol.online/takeitover**
     (`TIO_PUBLIC_PATH=/takeitover/`, `TIO_ALLOWED_ORIGINS=https://gamerol.online`,
     `TIO_PORT=8087` if free).
   - The cloud session could not reach the VPS (outbound SSH blocked), so the
     deployment continues from a session on the owner's PC, which holds the
     SSH key. Server-specific notes and the step-by-step runbook are kept out
     of git (`deploy/sites/`, git-ignored) and are shared privately.
   - Order: read the owner's VPS notes and the server's own work rules →
     read-only inspection (`deploy/inspect-vps.sh`) → show the owner the exact
     plan and nginx diff → only then install.
   - The nginx block must use `location ^~ /takeitover/` (see
     `deploy/proxy/nginx-subpath.conf`): a plain prefix loses to the site's
     regex locations.
2. **Private repository.** The owner wants the game in its own private repo
   `ermaikolraps-ops/take-it-over`. The cloud session was not allowed to create
   it. To move it (history preserved), after creating an EMPTY private repo:
   ```bash
   git subtree split --prefix=take-it-over -b tio-split    # in a gta-server-list clone
   git push git@github.com:ermaikolraps-ops/take-it-over.git tio-split:main
   ```
   (or clone the `take-it-over.bundle` from the shared zip and push its `main`).
   `gta-server-list` is **public**: the owner should decide whether to make it
   private or remove this branch after the move. Nothing in it has been deleted.
3. **Owner decisions** still open: install Docker if the VPS lacks it (Docker's
   official repository recommended); a swap file if memory is tight; whether a
   CDN/second proxy sits in front (changes `TIO_TRUST_PROXY` hops); whether
   `www.gamerol.online` serves or redirects; automatic deployments from GitHub
   (template in `deploy/github/deploy.yml`, inactive) or manual only.
4. **Game design**: balance values marked *provisional* in
   [game-parameters.md](game-parameters.md) and the questions in
   [assumptions.md](assumptions.md) need the owner's decisions.
5. Known limitations: see the README (no push notifications while the app is
   closed, GPS only with the app open, Natural Earth coastline ~1 km until OSM
   land polygons are loaded, single-instance in-memory rate limits).

## How to continue in another place

- **Same conversation, on your computer**: in a terminal, inside a clone of
  `gta-server-list`, signed in to the same claude.ai account, with a clean
  working tree: run `claude --teleport` and pick this session (or use
  *Open in > Terminal* on the session page at claude.ai/code to copy the exact
  command). It checks out the branch and loads the whole conversation.
- **Fresh session**: clone the repo (or the bundle), open `take-it-over/`, and
  start Claude Code there. It reads `CLAUDE.md` and this file. For the
  deployment, also give it the private notes from the shared zip.
