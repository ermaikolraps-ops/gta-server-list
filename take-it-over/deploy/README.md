# Deploying Take It Over! on your VPS (plan)

**Status: proposal.** Nothing has been installed or changed on the VPS. Each
phase below runs only after you approve it, and the domain or URL must be
confirmed first.

Everything runs on your VPS: the web app, the multiplayer server, PostgreSQL +
PostGIS, GPS processing, drones, wars and background jobs. GitHub is only used
for code: the VPS pulls the code with a read-only key, builds it locally, and
(optionally) GitHub Actions tells the VPS to deploy a commit. No external
hosting, no container registry.

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
                    │ db   (PostgreSQL 16 + PostGIS 3, no published port)          │
                    │ volume takeitover_pgdata · network takeitover_default         │
                    └──────────────────────────────────────────────────────────────┘
```

## 3. Exactly what would change on the VPS

**Added**
- Directory `/opt/take-it-over` (a git clone of the private repo).
- Optionally a system user `takeitover` (in the `docker` group) that owns it.
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
approval):** Docker Engine and the Compose plugin from Docker's official apt
repository.

**Not touched:** your other sites and their configuration blocks, other
certificates, existing databases (the game has its own PostgreSQL), firewall
rules (no new public port), other containers and compose projects.

Proxy changes are applied with `nginx -t` then `systemctl reload nginx`
(graceful, no dropped connections), after copying the file being edited to a
`.bak`.

## 4. Resources

| | Default | Notes |
|---|---|---|
| RAM | app ≤ 512 MB, db ≤ 768 MB | caps in `deploy/.env`; idle use is lower |
| Disk | ~0.7 GB image + ~1–2 GB database | more with OSM land polygons (+2–3 GB) |
| CPU | ~2 min of build per deployment | idle game load is light (scheduler polls every 0.5 s) |
| Network | ~15 MB once (land data) | |

## 5. Phases (each needs your go-ahead)

### Phase 1: inspect (read-only)
Run `inspect-vps.sh`; together we pick the URL, the proxy template and a free
local port (default 8087).

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

## 6. Rollback and removal

- **Bad release:** `deploy.sh` health-checks every release and restarts the
  previous one automatically if the new one fails. Manual:
  `deploy/scripts/deploy.sh --rollback`.
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

## 7. Operations

| Task | Command (from the clone) |
|---|---|
| Status | `docker compose -p takeitover ps` |
| Logs | `docker compose -p takeitover logs -f --tail 100 app` |
| Deploy a commit | `deploy/scripts/deploy.sh <commit>` |
| Backup now | `deploy/scripts/backup.sh manual` |
| Better coastlines | load OSM land polygons ([../docs/maps-and-land.md](../docs/maps-and-land.md)) |
| Uptime monitoring | point any monitor at `https://<game-url>/api/health` |

## 8. Open questions

- Which URL: subdomain or path, and which domain?
- Which reverse proxy does the VPS use (the report will tell)?
- Is Docker already installed? If not, may I add Docker Engine from Docker's
  official repository?
- Is there enough free RAM for about 1.3 GB of caps (the report shows current
  use)?
- Should automatic deployments run after every green CI on `main`, or only
  when started by hand?
