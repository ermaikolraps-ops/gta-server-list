#!/usr/bin/env bash
# Take It Over! — compressed database backup (game data only).
#
#   deploy/scripts/backup.sh [label]
#   cron, daily at 03:17:  17 3 * * * /opt/take-it-over/deploy/scripts/backup.sh daily
#
# Land/water polygons are left out (they are reloaded with the `land` job),
# which keeps backups small. Files older than TIO_BACKUP_DAYS are removed.
# Restore: see deploy/README.md.
set -euo pipefail

main() {
  local root deploy env_file label dir file
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  deploy="$root/deploy"
  env_file="$deploy/.env"
  label="${1:-manual}"
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
  dir="${TIO_BACKUP_DIR:-/var/backups/takeitover}"
  mkdir -p "$dir"
  chmod 700 "$dir"
  file="$dir/takeitover-$(date -u +%Y%m%dT%H%M%SZ)-${label}.sql.gz"
  docker compose -f "$deploy/docker-compose.prod.yml" --env-file "$env_file" exec -T db \
    pg_dump -U tio -d takeitover --no-owner \
      --exclude-table-data=land_polygons --exclude-table-data=water_polygons \
    | gzip -9 >"$file.part"
  mv "$file.part" "$file"
  chmod 600 "$file"
  find "$dir" -name 'takeitover-*.sql.gz' -mtime +"${TIO_BACKUP_DAYS:-14}" -delete
  echo "backup written: $file ($(du -h "$file" | cut -f1))"
}

main "$@"
exit $?
