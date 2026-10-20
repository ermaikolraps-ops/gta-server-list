#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key (see deploy/README.md):
#   command="/opt/take-it-over/deploy/scripts/deploy-from-ssh.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… github-deploy
# The key can do exactly one thing: deploy a commit hash or the main branch.
set -euo pipefail
request="${SSH_ORIGINAL_COMMAND:-}"
if [[ "$request" =~ ^[0-9a-f]{7,40}$ ]]; then
  ref="$request"
elif [ "$request" = "main" ]; then
  ref="origin/main"
else
  echo "refused: expected a commit hash or 'main'" >&2
  exit 2
fi
exec "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$ref"
