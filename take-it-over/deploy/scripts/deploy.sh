#!/usr/bin/env bash
# Take It Over! — deploy a git ref on the VPS, with health check and automatic rollback.
#
#   deploy/scripts/deploy.sh                 # deploy origin/main
#   deploy/scripts/deploy.sh <commit|ref>    # deploy a specific commit or ref
#   deploy/scripts/deploy.sh --rollback      # go back to the previous successful release
#
# Steps: fetch → build image tagged with the commit → back up the database →
# start the new image → wait for /api/health → record the release.
# If the health check fails, the previous image is started again.
# Only the "takeitover" compose project is touched.
set -euo pipefail

main() {
  local root deploy env_file releases
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  deploy="$root/deploy"
  env_file="$deploy/.env"
  releases="$deploy/.releases"

  exec 9>"${TMPDIR:-/tmp}/takeitover-deploy.lock"
  flock -n 9 || die "another deployment is already running"
  [ -f "$env_file" ] || die "missing $env_file (copy deploy/.env.production.example)"
  local port build_flags
  port="$(env_get TIO_PORT)"
  port="${port:-8087}"
  build_flags="$(env_get TIO_DOCKER_BUILD_FLAGS)"
  compose() { docker compose -f "$deploy/docker-compose.prod.yml" --env-file "$env_file" "$@"; }

  if [ "${1:-}" = "--rollback" ]; then
    local prev
    prev="$(tail -n 2 "$releases" 2>/dev/null | head -n 1)"
    if [ -z "$prev" ] || [ "$prev" = "$(tail -n 1 "$releases")" ]; then
      die "no previous release recorded"
    fi
    log "rolling back to $prev"
    git -C "$root" checkout --quiet --detach "$prev"
    if ! { activate "$prev" && healthy "$port"; }; then
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

  git checkout --quiet --detach "$sha"
  log "building takeitover-app:$sha"
  # shellcheck disable=SC2086  # flags are intentionally word-split
  docker build $build_flags -t "takeitover-app:$sha" "$root"

  if compose ps --status running --services 2>/dev/null | grep -qx db; then
    log "backing up the database before migrating"
    "$deploy/scripts/backup.sh" pre-deploy || die "backup failed; nothing was changed"
  fi

  # First install: the server refuses to start without a land mask, so load it once.
  compose up -d --wait db
  if [ "$(compose exec -T db psql -U tio -d takeitover -tAc 'SELECT EXISTS (SELECT 1 FROM land_polygons)' 2>/dev/null)" != "t" ]; then
    log "no land data yet: downloading and loading Natural Earth land/lakes (one time)"
    TIO_IMAGE_TAG="$sha" compose run --rm land
  fi

  log "starting $sha"
  if activate "$sha" && healthy "$port"; then
    echo "$sha" >>"$releases"
    docker tag "takeitover-app:$sha" takeitover-app:current
    prune_images "$releases"
    log "deployed $sha"
    return 0
  fi

  log "new release failed its health check"
  compose logs --tail 80 app || true
  if [ -n "$prev" ]; then
    log "restoring previous release $prev"
    git checkout --quiet --detach "$prev"
    if activate "$prev" && healthy "$port"; then log "previous release $prev is running again"; fi
  fi
  die "deployment of $sha failed"
}

# Reads KEY from the .env file as plain text (never executes it); strips optional quotes.
env_get() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$env_file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

log() { printf '[deploy %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

activate() {
  TIO_IMAGE_TAG="$1" compose up -d --no-build --remove-orphans db app
}

healthy() {
  local port="$1"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Keep the images of the last three releases (for rollback), delete older ones.
prune_images() {
  local keep
  keep="$(tail -n 3 "$1" | sort -u)"
  docker image ls takeitover-app --format '{{.Tag}}' | while read -r tag; do
    [ "$tag" = current ] && continue
    grep -qx "$tag" <<<"$keep" || docker image rm "takeitover-app:$tag" >/dev/null 2>&1 || true
  done
}

main "$@"
exit $?
