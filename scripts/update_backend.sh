#!/usr/bin/env bash
# Zenith — idempotent backend update for the DigitalOcean droplet.
#
# Run this on the droplet (from inside the repo) to pull the latest code and
# restart the service. It uses `git reset --hard` rather than `git pull`
# because history was rewritten once (the wrangler.toml secret scrub), so a
# fast-forward pull would diverge. Local uncommitted changes ARE discarded.
#
# Usage (on the droplet):   sudo bash scripts/update_backend.sh
# Or piped from a laptop:   ssh root@HOST 'bash -s' < scripts/update_backend.sh
#
# Repo location is resolved in this order so both invocations work:
#   1. $REPO_DIR env var, if set
#   2. the systemd unit's WorkingDirectory (robust when piped over stdin,
#      where $0 is just "bash" and the script path is unknown)
#   3. the script's own location ($0), for the in-repo case

set -euo pipefail

if [[ -z "${REPO_DIR:-}" ]]; then
  REPO_DIR="$(systemctl show -p WorkingDirectory --value zenith 2>/dev/null || true)"
fi
if [[ -z "${REPO_DIR:-}" || ! -d "${REPO_DIR}/.git" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd || true)"
fi
if [[ -z "${REPO_DIR:-}" || ! -d "${REPO_DIR}/.git" ]]; then
  echo "✗ Could not locate the Zenith repo. Set REPO_DIR=/path/to/zenith and retry." >&2
  exit 1
fi

VENV_DIR="${REPO_DIR}/.venv"
cd "$REPO_DIR"
echo "Using repo: $REPO_DIR"

log() { printf "\n\033[1;33m▸ %s\033[0m\n" "$*"; }

log "Fetching origin"
git fetch origin

log "Resetting to origin/main (discards local changes; required after history rewrite)"
git reset --hard origin/main

log "Installing requirements"
"${VENV_DIR}/bin/pip" install -r requirements.txt --quiet

log "Restarting zenith service"
sudo systemctl restart zenith

log "Health check (waiting 2s for boot)"
sleep 2
curl -fsS http://localhost/api/health && echo

log "Done."
