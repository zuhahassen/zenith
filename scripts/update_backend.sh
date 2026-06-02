#!/usr/bin/env bash
# Zenith — idempotent backend update for the DigitalOcean droplet.
#
# Run this on the droplet (from inside the repo) to pull the latest code and
# restart the service. It uses `git reset --hard` rather than `git pull`
# because history was rewritten once (the wrangler.toml secret scrub), so a
# fast-forward pull would diverge. Local uncommitted changes ARE discarded.
#
# Usage:  sudo bash scripts/update_backend.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="${REPO_DIR}/.venv"
cd "$REPO_DIR"

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
