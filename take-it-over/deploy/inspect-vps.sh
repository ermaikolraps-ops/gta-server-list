#!/usr/bin/env bash
# Take It Over! — READ-ONLY inspection of the VPS before deployment.
#
# It changes nothing: it only reads system information so the deployment can
# be planned around the services already running. Run it on the VPS:
#
#   bash inspect-vps.sh > vps-report.txt 2>&1          # as your normal user
#   sudo bash inspect-vps.sh > vps-report.txt 2>&1     # more complete (ports, proxy config)
#
# Read vps-report.txt before sharing it. It deliberately prints only server
# names, listen ports and proxy targets from web-server configs — never
# certificates, keys, passwords or .env files — but remove anything you
# consider private.
set -u

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "System"
uname -srm
[ -r /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
uptime
echo "CPUs: $(nproc 2>/dev/null)"
free -h 2>/dev/null
df -h / /var /opt 2>/dev/null | sort -u

section "Listening TCP ports (what is already taken)"
if have ss; then ss -ltnp 2>/dev/null || ss -ltn; else netstat -ltn 2>/dev/null; fi

section "Firewall"
if have ufw; then ufw status 2>/dev/null || echo "ufw: need sudo to read status"; else echo "ufw not installed"; fi

section "Web servers / reverse proxies"
for svc in nginx apache2 httpd caddy traefik haproxy; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}\.service"; then
    echo "${svc}: $(systemctl is-active "$svc" 2>/dev/null) (systemd)"
  fi
done
have nginx && nginx -v 2>&1
have apache2ctl && apache2ctl -v 2>/dev/null | head -1
have caddy && caddy version 2>/dev/null

if have nginx; then
  section "nginx: sites, ports and proxy targets (no secrets)"
  ls -l /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
  if nginx -T >/dev/null 2>&1; then
    nginx -T 2>/dev/null | grep -E '^# configuration file|^\s*(server_name|listen|location|proxy_pass|root)\b' \
      | grep -vE 'ssl_certificate|password|secret|token|key' | sed 's/[[:space:]]\+/ /g'
    echo "-- websocket upgrade map present?"
    # shellcheck disable=SC2016  # a literal $ in the pattern
    nginx -T 2>/dev/null | grep -nE 'map \$http_upgrade' || echo "no"
  else
    echo "(run with sudo to list server names and locations)"
  fi
fi

if have apache2ctl; then
  section "Apache: virtual hosts and modules"
  apache2ctl -S 2>/dev/null
  apache2ctl -M 2>/dev/null | grep -E 'proxy|rewrite|headers|ssl'
fi

if [ -d /etc/caddy ]; then
  section "Caddy: site addresses"
  grep -hE '^[^#[:space:]].*\{' /etc/caddy/Caddyfile /etc/caddy/*.caddy 2>/dev/null
fi

section "TLS certificates (names and expiry only)"
if [ -d /etc/letsencrypt/live ]; then
  for d in /etc/letsencrypt/live/*/; do
    [ -f "${d}cert.pem" ] || continue
    printf '%s  ' "$(basename "$d")"
    openssl x509 -in "${d}cert.pem" -noout -enddate -ext subjectAltName 2>/dev/null | tr '\n' ' '
    echo
  done
else
  echo "/etc/letsencrypt/live not readable or absent (run with sudo, or certificates managed elsewhere)"
fi

section "Docker"
if have docker; then
  docker version --format 'docker {{.Server.Version}}' 2>/dev/null || echo "docker present, daemon not reachable (need sudo or docker group)"
  docker compose version 2>/dev/null || echo "docker compose plugin: not found"
  echo "-- containers (name, image, status, published ports)"
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null
  echo "-- compose projects"
  docker compose ls 2>/dev/null
  echo "-- networks"
  docker network ls --format '{{.Name}}\t{{.Driver}}' 2>/dev/null
  echo "-- disk use"
  docker system df 2>/dev/null
else
  echo "docker not installed"
fi

section "Databases already on the host"
for svc in postgresql mysql mariadb redis-server mongod; do
  if systemctl list-unit-files 2>/dev/null | grep -q "^${svc}"; then
    echo "${svc}: $(systemctl is-active "$svc" 2>/dev/null)"
  fi
done
have psql && psql --version

section "Node.js / Git"
have node && node --version
have git && git --version

section "Running services (top-level)"
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -60

section "Scheduled jobs (names only)"
ls /etc/cron.d 2>/dev/null
systemctl list-timers --no-pager --no-legend 2>/dev/null | awk '{print $(NF-1), $NF}' | head -30

section "Directory candidates for the game"
ls -ld /opt /srv /var/www 2>/dev/null
ls /opt /srv 2>/dev/null

echo
echo "Done. Nothing was changed."
