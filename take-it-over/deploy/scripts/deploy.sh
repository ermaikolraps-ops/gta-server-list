#!/usr/bin/env bash
# Take It Over! — deploy a git ref on the VPS, with preflight checks, health
# check and automatic rollback. Only the "takeitover" compose project is touched.
#
#   deploy/scripts/deploy.sh --check         # read-only readiness check; changes nothing
#   deploy/scripts/deploy.sh                 # deploy origin/main
#   deploy/scripts/deploy.sh <commit|ref>    # deploy a specific commit or ref
#   deploy/scripts/deploy.sh --rollback      # go back to the previous successful release
#
# Deploy steps: preflight → fetch → build image tagged with the commit → back
# up the database → (first install: load land data) → start the new image →
# wait for /api/health → record the release. If the health check fails, the
# previous image is started again.
#
# Supported: Ubuntu 22.04, 24.04 and 26.04 (x86_64 or ARM64) with Docker Engine,
# the Compose v2 plugin (2.20 or newer) and buildx.
set -euo pipefail

main() {
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  deploy="$root/deploy"
  env_file="$deploy/.env"
  releases="$deploy/.releases"

  if [ "${1:-}" = "--check" ]; then
    preflight check
    return $?
  fi

  exec 9>"${TMPDIR:-/tmp}/takeitover-deploy.lock"
  flock -n 9 || die "another deployment is already running"
  preflight deploy || die "preflight failed; nothing was changed"

  if [ "${1:-}" = "--rollback" ]; then
    local prev
    prev="$(tail -n 2 "$releases" 2>/dev/null | head -n 1)"
    if [ -z "$prev" ] || [ "$prev" = "$(tail -n 1 "$releases")" ]; then
      die "no previous release recorded"
    fi
    log "rolling back to $prev"
    git -C "$root" checkout --quiet --detach "$prev" || die "cannot check out $prev (uncommitted changes in $root?)"
    if ! { activate "$prev" && healthy; }; then
      die "the previous release is not healthy either; check: docker compose -p takeitover logs app"
    fi
    echo "$prev" >>"$releases"
    docker tag "takeitover-app:$prev" takeitover-app:current
    log "rolled back to $prev"
    return 0
  fi

  local ref="${1:-origin/main}" sha prev
  cd "$root"
  git fetch --quiet --prune origin
  sha="$(git rev-parse --verify "${ref}^{commit}")"
  prev="$(tail -n 1 "$releases" 2>/dev/null || true)"
  if [ "$sha" = "$prev" ]; then
    log "$sha is already deployed"
    return 0
  fi

  git checkout --quiet --detach "$sha" || die "cannot check out $sha (uncommitted changes in $root?)"
  log "building takeitover-app:$sha"
  # shellcheck disable=SC2086  # flags are intentionally word-split
  docker build $build_flags -t "takeitover-app:$sha" "$root"

  if compose ps --status running --services 2>/dev/null | grep -qx db; then
    log "backing up the database before migrating"
    "$deploy/scripts/backup.sh" pre-deploy || die "backup failed; the running release was not changed"
  fi

  # First install: the server refuses to start without a land mask, so load it once.
  compose up -d --wait db
  if [ "$(compose exec -T db psql -U tio -d takeitover -tAc 'SELECT EXISTS (SELECT 1 FROM land_polygons)' 2>/dev/null)" != "t" ]; then
    log "no land data yet: downloading and loading Natural Earth land/lakes (one time)"
    TIO_IMAGE_TAG="$sha" compose run --rm land
  fi

  log "starting $sha"
  if activate "$sha" && healthy; then
    echo "$sha" >>"$releases"
    docker tag "takeitover-app:$sha" takeitover-app:current
    prune_images
    log "deployed $sha"
    return 0
  fi

  log "new release failed its health check"
  compose logs --tail 80 app || true
  if [ -n "$prev" ]; then
    log "restoring previous release $prev"
    git checkout --quiet --detach "$prev" || log "could not check out $prev; starting its image anyway"
    if activate "$prev" && healthy; then log "previous release $prev is running again"; fi
  fi
  die "deployment of $sha failed"
}

# ---------------------------------------------------------------- preflight

# Verifies the host before anything is changed. In "check" mode every result
# is printed and nothing is modified. Sets: port, build_flags, TIO_DB_IMAGE.
preflight() {
  local mode="$1" errors=0 warnings=0
  ok() { if [ "$mode" = check ]; then printf '  ok    %s\n' "$*"; fi; }
  warn() { printf '  WARN  %s\n' "$*"; warnings=$((warnings + 1)); }
  fail() { printf '  FAIL  %s\n' "$*"; errors=$((errors + 1)); }
  if [ "$mode" = check ]; then echo "Take It Over! preflight (read-only)"; fi

  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    ok "OS: $(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")"
  fi

  local cmd
  for cmd in git docker curl flock gzip awk; do
    if command -v "$cmd" >/dev/null 2>&1; then ok "$cmd found"; else fail "$cmd is not installed"; fi
  done

  if [ -f "$env_file" ]; then
    ok "deploy/.env present"
    [ "$(stat -c %a "$env_file" 2>/dev/null)" = 600 ] || warn "deploy/.env should be chmod 600 (it holds the database password)"
    local pw origins
    pw="$(env_get POSTGRES_PASSWORD)"
    origins="$(env_get TIO_ALLOWED_ORIGINS)"
    if [ -z "$pw" ] || [ "$pw" = change-me ] || [ "${#pw}" -lt 16 ]; then
      fail "POSTGRES_PASSWORD in deploy/.env must be set to a long random value (openssl rand -base64 32)"
    else ok "POSTGRES_PASSWORD set"; fi
    case "$origins" in
      https://*) ok "TIO_ALLOWED_ORIGINS=$origins" ;;
      "") fail "TIO_ALLOWED_ORIGINS must be the game's public origin, e.g. https://play.example.com" ;;
      *) warn "TIO_ALLOWED_ORIGINS=$origins is not https:// (browsers need HTTPS for GPS)" ;;
    esac
  else
    fail "missing deploy/.env (copy deploy/.env.production.example and fill it in)"
  fi
  port="$(env_get TIO_PORT)"
  port="${port:-8087}"
  build_flags="$(env_get TIO_DOCKER_BUILD_FLAGS)"

  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "Docker daemon reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
    else
      fail "cannot reach the Docker daemon (is this user in the docker group?)"
    fi
    local cv major minor
    cv="$(docker compose version --short 2>/dev/null || true)"
    if [ -z "$cv" ]; then
      fail "the Docker Compose v2 plugin is missing (Ubuntu: docker-compose-v2, Docker repo: docker-compose-plugin)"
    else
      cv="${cv#v}"
      major="${cv%%.*}"
      minor="$(echo "$cv" | cut -d. -f2)"
      if [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 20 ]; }; then
        ok "Docker Compose $cv"
      else
        fail "Docker Compose $cv is too old (need 2.20 or newer)"
      fi
    fi
    if docker buildx version >/dev/null 2>&1; then
      ok "buildx $(docker buildx version 2>/dev/null | awk '{print $2}')"
    else
      fail "buildx is missing (Ubuntu: docker-buildx, Docker repo: docker-buildx-plugin)"
    fi
  fi

  local arch db_image
  arch="$(uname -m)"
  db_image="$(env_get TIO_DB_IMAGE)"
  case "$arch" in
    x86_64 | amd64) db_image="${db_image:-postgis/postgis:16-3.4}" ;;
    aarch64 | arm64) db_image="${db_image:-imresamu/postgis:16-3.4}" ;;
    *) fail "unsupported CPU architecture $arch (x86_64 or ARM64 only)" ;;
  esac
  export TIO_DB_IMAGE="$db_image"
  ok "architecture $arch -> database image $db_image"

  local avail_mb min_mb
  avail_mb="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)"
  min_mb="$(env_get TIO_MIN_BUILD_MEM_MB)"
  min_mb="${min_mb:-1000}"
  if [ "$avail_mb" -ge "$min_mb" ]; then
    ok "available memory ${avail_mb} MiB (a build needs ${min_mb})"
  else
    fail "only ${avail_mb} MiB of memory available; a build needs ${min_mb} MiB (add swap or free memory first)"
  fi

  local docker_dir free_mb
  docker_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  [ -d "$docker_dir" ] || docker_dir=/
  free_mb="$(df -Pk "$docker_dir" 2>/dev/null | awk 'NR == 2 {print int($4 / 1024)}')"
  if [ "${free_mb:-0}" -ge 4096 ]; then
    ok "free disk for Docker ${free_mb} MiB"
  else
    fail "only ${free_mb:-?} MiB free for Docker in $docker_dir; need at least 4096 MiB"
  fi

  if port_in_use "$port"; then
    if docker ps --filter label=com.docker.compose.project=takeitover --format '{{.Ports}}' 2>/dev/null | grep -q "127.0.0.1:${port}->"; then
      ok "port 127.0.0.1:$port is used by this game"
    else
      fail "port $port is already used by another service; set a free TIO_PORT in deploy/.env"
    fi
  else
    ok "port 127.0.0.1:$port is free"
  fi

  if [ "$mode" = check ]; then
    echo "Result: $errors problem(s), $warnings warning(s). Nothing was changed."
  fi
  [ "$errors" -eq 0 ]
}

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

# ------------------------------------------------------------------ helpers

# Reads KEY from the .env file as plain text (never executes it); strips optional quotes.
env_get() {
  local line
  [ -f "$env_file" ] || return 0
  line="$(grep -E "^[[:space:]]*$1=" "$env_file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

log() { printf '[deploy %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

compose() { docker compose -f "$deploy/docker-compose.prod.yml" --env-file "$env_file" "$@"; }

activate() {
  TIO_IMAGE_TAG="$1" compose up -d --no-build --remove-orphans db app
}

healthy() {
  local id state
  id="$(compose ps -q app 2>/dev/null || true)"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    # Fail fast on a crash loop instead of waiting out the whole timeout.
    state="$(docker inspect -f '{{.RestartCount}} {{.State.Status}}' "$id" 2>/dev/null || echo '0 unknown')"
    if [ "${state%% *}" -gt 0 ] || [ "${state#* }" = exited ]; then return 1; fi
    sleep 2
  done
  return 1
}

# Keep the images of the last three releases (for rollback), delete older ones.
prune_images() {
  local keep
  keep="$(tail -n 3 "$releases" | sort -u)"
  docker image ls takeitover-app --format '{{.Tag}}' | while read -r tag; do
    [ "$tag" = current ] && continue
    grep -qx "$tag" <<<"$keep" || docker image rm "takeitover-app:$tag" >/dev/null 2>&1 || true
  done
}

main "$@"
exit $?
