#!/usr/bin/env bash
# Zenith — DigitalOcean droplet bootstrap.
#
# Run this once on a fresh Ubuntu 22.04+ droplet, from inside a checkout of
# the Zenith repo. It will:
#   1. Verify Python 3.11+ is available
#   2. Create a venv and install requirements
#   3. Write /etc/systemd/system/zenith.service
#   4. Enable and start the service
#   5. Install nginx and drop the reverse-proxy config
#   6. Print where to put your OPENROUTER_API_KEY
#
# Re-running it is safe — every step is idempotent.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER}}"
VENV_DIR="${REPO_DIR}/.venv"
SERVICE_FILE="/etc/systemd/system/zenith.service"
NGINX_CONF="/etc/nginx/sites-available/zenith"
NGINX_LINK="/etc/nginx/sites-enabled/zenith"

log() { printf "\n\033[1;33m▸ %s\033[0m\n" "$*"; }
err() { printf "\n\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

require_root() {
  if [ "${EUID}" -ne 0 ]; then
    err "This script must be run as root (use sudo)."
  fi
}

# ---------------------------------------------------------------------------

require_root

# 1. Python check ----------------------------------------------------------
log "Checking Python version"
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found. Install with: apt install -y python3.11 python3.11-venv"
fi
PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PY_MAJOR="${PY_VER%%.*}"
PY_MINOR="${PY_VER##*.}"
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 11 ]; }; then
  err "Python 3.11+ required, found $PY_VER. Install python3.11."
fi
echo "  Python $PY_VER OK"

# 2. venv + requirements ---------------------------------------------------
log "Creating venv at $VENV_DIR"
if [ ! -d "$VENV_DIR" ]; then
  sudo -u "$SERVICE_USER" python3 -m venv "$VENV_DIR"
fi
sudo -u "$SERVICE_USER" "$VENV_DIR/bin/pip" install --upgrade pip --quiet
sudo -u "$SERVICE_USER" "$VENV_DIR/bin/pip" install -r "$REPO_DIR/requirements.txt" --quiet
echo "  Requirements installed"

# 3. systemd unit ----------------------------------------------------------
log "Writing systemd unit to $SERVICE_FILE"
cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Zenith FastAPI backend (uvicorn)
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}
Environment="PATH=${VENV_DIR}/bin"
# Secrets — fill these in by editing this file, then restart with:
#   systemctl daemon-reload && systemctl restart zenith
Environment="OPENROUTER_API_KEY="
Environment="SEEING_MODEL_PATH="
ExecStart=${VENV_DIR}/bin/uvicorn api.main:app --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable zenith --quiet
systemctl restart zenith
echo "  zenith.service enabled and started"

# 4. nginx -----------------------------------------------------------------
log "Installing nginx"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update --quiet
  apt-get install -y nginx --quiet
fi
cp "$REPO_DIR/scripts/setup_nginx.conf" "$NGINX_CONF"
ln -sf "$NGINX_CONF" "$NGINX_LINK"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "  nginx configured"

# 5. Final instructions ----------------------------------------------------
PUBLIC_IP="$(curl -s ifconfig.me || echo 'YOUR_DROPLET_IP')"

cat <<DONE

────────────────────────────────────────────────────────────────────
✓ Zenith backend installed.

  Backend URL:   http://${PUBLIC_IP}
  Service:       systemctl status zenith
  Logs:          journalctl -u zenith -f

! NEXT STEP — set your OpenRouter API key:

    sudo systemctl edit zenith
    # add:
    [Service]
    Environment="OPENROUTER_API_KEY=sk-or-..."
    # save, then:
    sudo systemctl restart zenith

  Verify:  curl http://localhost:8000/api/health
────────────────────────────────────────────────────────────────────
DONE
