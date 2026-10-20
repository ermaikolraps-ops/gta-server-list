# Deploying Take It Over! on your VPS (plan)

**Status: proposal.** Nothing has been installed or changed on the VPS. Each
phase below runs only after you approve it, and the domain or URL must be
confirmed first.

Everything runs on your VPS: the web app, the multiplayer server, PostgreSQL +
PostGIS, GPS processing, drones, wars and background jobs. GitHub is only used
for code: the VPS pulls the code with a read-only key, builds it locally, and
(optionally) GitHub Actions tells the VPS to deploy a commit. No external
hosting, no container registry.

Target server: **Ubuntu 26.04 LTS, 2 vCPU, 4 GB RAM**, shared with other
production services. Ubuntu 22.04 and 24.04, and ARM64 servers, work the same
way.

## 1. What I need from you

1. **The public URL**, one of:
   - a subdomain such as `https://play.yourdomain.com` (recommended: isolated
     cookies and service worker, simplest proxy change), or
   - a path of an existing site such as `https://yourdomain.com/play/`
     (supported and tested).
2. **The inspection report.** Run on the VPS and read it before sharing:
   `sudo bash deploy/inspect-vps.sh > vps-report.txt 2>&1`
   It is read-only. It shows which reverse proxy you use, free ports, Docker,
   memory and disk, existing databases and certificates (names only).
3. For a subdomain: who manages DNS (one A/AAAA record is needed).

## 2. Target layout

```
Internet ──443──▶ your existing reverse proxy (nginx / Apache / Caddy, existing HTTPS)
                     │  existing sites … unchanged
                     └─ play.yourdomain.com  or  yourdomain.com/play/
                          │
                          ▼ 127.0.0.1:8087 (loopback only, not reachable from outside)
                    ┌──────────────── compose project "takeitover" ────────────────┐
                    │ app  (Node.js: web app + API + WebSocket + job scheduler)   │
                    │ db   (PostgreSQL 16 + PostGIS 3.4, no published port)       │
                    │ volume takeitover_pgdata · network takeitover_default         │
                    └──────────────────────────────────────────────────────────────┘
```

## 3. Ubuntu 26.04 compatibility (verified)

Checked in an Ubuntu 26.04 container with the distribution's own packages.
`deploy.sh --check` reported no problems, and a full deployment then ran
through it. This was a test environment, not your VPS: Phase 1 confirms what
your server actually has.

| Need | Ubuntu 26.04 archive | Docker's apt repository | Required |
|---|---|---|---|
| Docker Engine | `docker.io` 29.1.3 | `docker-ce` 29.9 | any current version |
| Compose v2 plugin | `docker-compose-v2` 2.40.3 | `docker-compose-plugin` 5.6 | 2.20 or newer |
| buildx | `docker-buildx` 0.30.1 | `docker-buildx-plugin` 0.38 | any |
| git, curl, flock, gzip, awk | git 2.53, curl 8.18, util-linux 2.41 | | installed by default on Ubuntu Server |

- **Docker already installed?** It is used as is, whichever source it came
  from (never mix the two sources). `deploy.sh --check` verifies the versions.
- **Docker missing?** Install it from one source only, with your approval:
  - Ubuntu archive: `sudo apt install docker.io docker-compose-v2 docker-buildx`.
    It is the simplest choice, but these packages are in *universe*, where
    security fixes are best-effort without Ubuntu Pro.
  - Docker's official repository: newer and patched promptly. This is my
    recommendation for a production server.
- **PostgreSQL / PostGIS** run inside the `db` container (PostgreSQL 16 +
  PostGIS 3.4), not from Ubuntu packages. A PostgreSQL already on the host
  (Ubuntu 26.04 ships 18) is not touched, and its port 5432 stays its own.
  The database image is `postgis/postgis:16-3.4` on x86_64. That image does
  not exist for ARM64, so `deploy.sh` picks `imresamu/postgis:16-3.4` there
  (same versions; the full test suite passes against it).
- **26.04 specifics:** Ubuntu 26.04 replaces GNU coreutils with the Rust
  *uutils*, and `sudo` with *sudo-rs*. The scripts were run on uutils, and
  the Phase 2 and Phase 5 setup commands with sudo-rs 0.2.13 and adduser
  3.153.
- **Firewall:** no new public port. Docker's published-port rules bypass
  `ufw`, which is why the game binds only to `127.0.0.1`.
- **Effect of installing Docker:** if Docker has to be installed, it turns on
  IP forwarding and sets the iptables `FORWARD` policy to `DROP`. Web sites
  are unaffected. Check first if the VPS routes traffic for other things (a
  WireGuard/OpenVPN server, LXD or KVM guests). The inspection report shows
  this.

## 4. Resources on a 2 vCPU / 4 GB server

Measured on the production compose stack.

| Situation | App | Database | Notes |
|---|---|---|---|
| Idle | 45 MiB | 85 MiB | the job scheduler polls every 0.5 s; CPU stays near 0 |
| 100 players, one GPS fix per second each, plus map loads | ≤190 MiB, ≤1 CPU (mean 0.25) | ≤140 MiB, ≤0.45 CPU (mean 0.08) | 6,000 of 6,000 fixes accepted; p50 5 ms, p95 98 ms |
| Caps (in `deploy/.env`) | 512 MiB, 1.0 CPU | 768 MiB, 0.5 CPU | the game never uses more than 1.5 of the 2 CPUs |
| Build (each deployment) | peak ≈ 650 MiB; 37 s from scratch on 4 cores here, so expect 1–2 min on 2 vCPU | | refused when less than `TIO_MIN_BUILD_MEM_MB` (1000 MiB) is free |

The 100-player test above ran with these caps in place.

- **Disk:** about 0.65 GB per app image (the last 3 are kept for rollback,
  sharing most layers), 0.85 GB for the database image, about 130 MB for the
  database volume with Natural Earth land loaded, and backups (a few KB to MB
  each; land data is excluded). Preflight requires 4 GB free. OSM land
  polygons (better coastlines, optional) add 2–3 GB.
- **Memory:** in normal use the game needs about 150–350 MiB, with hard caps
  of 1.28 GiB. A deployment briefly adds the build (about 650 MiB).
- **Swap:** many VPS images have none. If the report shows little available
  memory (under about 1.5 GB) or no swap, I suggest a 2 GB swap file as a
  safety net for build peaks. It is a host change, so it is only done with
  your approval.
- **Network:** about 15 MB once (land data), plus the base images and npm
  packages on the first build (a few hundred MB).

## 5. Exactly what would change on the VPS

**Added**
- Directory `/opt/take-it-over` (a git clone of the private repo).
- A system user `takeitover` that owns it. It is in the `docker` group, which
  is root-equivalent, so its SSH key is restricted to the deploy command.
- Docker compose project `takeitover`: two containers, one volume, one network,
  and images `takeitover-app:<commit>`.
- One reverse-proxy change:
  - a new `server` block (subdomain), or
  - one `location` block in an existing site (path),
  - plus the small WebSocket `map` if you don't already have it.
  Templates: [proxy/](proxy/).
- A certificate for the new subdomain, issued the same way as your existing
  ones (e.g. `certbot --nginx -d play.yourdomain.com`).
- Backups in `/var/backups/takeitover` and one cron line for them.
- For automatic deployments: one SSH public key, restricted to a single
  deploy command, in the deploy user's `authorized_keys`.

**Possibly added (only if the report shows it is missing, and only with your
approval):** Docker Engine, Compose and buildx (see section 3), and a swap
file.

**Not touched:** your other sites and their configuration blocks, other
certificates, existing databases (the game has its own PostgreSQL), firewall
rules (no new public port), and other containers and compose projects. No
existing service is restarted. The proxy is *reloaded*, not restarted.

Proxy changes are applied with `nginx -t` then `systemctl reload nginx`
(graceful, no dropped connections), after copying the file being edited to a
`.bak`.

## 6. Phases (each needs your go-ahead)

### Phase 1: inspect (read-only)
Run `inspect-vps.sh`. Together we pick the URL, the proxy template and a free
local port (default 8087), and decide on Docker and swap if they are missing.

### Phase 2: prepare (no effect on existing services)
```bash
# A dedicated user (a real shell is needed for the SSH forced command later)
sudo adduser --system --group --shell /bin/bash --home /home/takeitover takeitover
sudo usermod -aG docker takeitover
sudo install -d -o takeitover -g takeitover /opt/take-it-over

# Read-only deploy key for the private repo; add the .pub at
# GitHub → take-it-over → Settings → Deploy keys (leave "write access" off)
sudo -u takeitover ssh-keygen -t ed25519 -f /home/takeitover/.ssh/github_ro -N '' -C take-it-over-vps
sudo -u takeitover git -c core.sshCommand='ssh -i ~/.ssh/github_ro -o IdentitiesOnly=yes' \
  clone git@github.com:<owner>/take-it-over.git /opt/take-it-over
sudo -u takeitover git -C /opt/take-it-over config core.sshCommand 'ssh -i ~/.ssh/github_ro -o IdentitiesOnly=yes'

cd /opt/take-it-over
sudo -u takeitover cp deploy/.env.production.example deploy/.env
sudo -u takeitover chmod 600 deploy/.env   # then set POSTGRES_PASSWORD, TIO_PORT and the URL settings

# Read-only readiness check: OS, tools, Docker/Compose/buildx versions,
# .env values, CPU architecture, free memory and disk, port. Changes nothing.
sudo -u takeitover deploy/scripts/deploy.sh --check
```

### Phase 3: first start, reachable only from the VPS itself
```bash
sudo -u takeitover deploy/scripts/deploy.sh      # builds, loads land data once, starts, health-checks
curl -s http://127.0.0.1:8087/api/health
```

### Phase 4: publish through the existing proxy
Copy the matching template from `proxy/` into your configuration (a new file
for a subdomain, or one `location` block for a path). Then run
`sudo nginx -t && sudo systemctl reload nginx`. For a subdomain, issue its
certificate with the tool you already use.

The game trusts exactly one proxy hop for the client address
(`TIO_TRUST_PROXY=true`), which matches a proxy on the same machine. If
another proxy or CDN sits in front of it (e.g. Cloudflare), tell me: the hop
count changes, and getting it wrong would weaken the per-IP rate limits.

### Phase 5: backups and automatic deployments
```bash
# daily backup at 03:17, kept 14 days
echo '17 3 * * * takeitover /opt/take-it-over/deploy/scripts/backup.sh daily' | sudo tee /etc/cron.d/takeitover-backup
```
Automatic deployments:
1. Create a second SSH key for GitHub Actions and add its public half to
   `~takeitover/.ssh/authorized_keys` with the forced command shown in
   `scripts/deploy-from-ssh.sh`.
2. Add the four secrets listed in `github/deploy.yml`.
3. Move `github/deploy.yml` to `.github/workflows/deploy.yml`.

Start with manual runs ("Run workflow"). Enable deploy-on-green-CI later if you
want it. A `production` environment with required reviewers adds a
manual-approval click before every deployment.

### Phase 6: verify
- The game URL loads over HTTPS, asks for location, and captures a parcel.
- The status shows the live connection (WebSocket through the proxy).
- Every existing site still answers as before (checked before and after the
  reload).
- `docker compose -p takeitover ps` shows both containers *healthy*.

## 7. Rollback and removal

- **Bad release:** `deploy.sh` health-checks every release and restarts the
  previous one automatically if the new one fails. A crash loop is detected
  within seconds. Manual: `deploy/scripts/deploy.sh --rollback`.
- **Every deployment backs up the database first**, to
  `/var/backups/takeitover`. Restore:
  ```bash
  C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"
  $C stop app
  $C exec -T db dropdb -U tio takeitover && $C exec -T db createdb -U tio takeitover
  gunzip -c /var/backups/takeitover/<file>.sql.gz | $C exec -T db psql -q -U tio -d takeitover
  $C run --rm land          # land polygons are not in backups; reload them
  $C start app
  ```
- **Remove the game entirely:**
  1. Delete the proxy block and reload the proxy.
  2. `docker compose -p takeitover down` (add `-v` to also delete game data).
  3. Delete `/opt/take-it-over`, `/etc/cron.d/takeitover-backup` and the
     backups.
  Nothing else on the server depends on it.

## 8. Operations

| Task | Command (from the clone) |
|---|---|
| Readiness check | `deploy/scripts/deploy.sh --check` |
| Status | `docker compose -p takeitover ps` |
| Resource use | `docker stats takeitover-app-1 takeitover-db-1` |
| Logs | `docker compose -p takeitover logs -f --tail 100 app` |
| Deploy a commit | `deploy/scripts/deploy.sh <commit>` |
| Backup now | `deploy/scripts/backup.sh manual` |
| Better coastlines | load OSM land polygons ([../docs/maps-and-land.md](../docs/maps-and-land.md)) |
| Uptime monitoring | point any monitor at `https://<game-url>/api/health` |

## 9. Open questions

- Which URL: subdomain or path, and which domain?
- Which reverse proxy does the VPS use (the report will tell)? Is there a CDN
  or a second proxy in front of it?
- Is Docker already installed? If not, may I add it from Docker's official
  repository (or the Ubuntu archive, if you prefer)?
- How much memory do your current services use, and is there swap? The caps
  above need about 1.3 GB at most, plus 0.65 GB during a deployment.
- Should automatic deployments run after every green CI on `main`, or only
  when started by hand?
