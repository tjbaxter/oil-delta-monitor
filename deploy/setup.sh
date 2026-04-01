#!/usr/bin/env bash
# First-time setup on the GCE VM.
# Run once after cloning the repo.
# Usage: bash deploy/setup.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER="$(whoami)"

echo "==> Setting up oil-delta-monitor in $REPO_DIR as $USER"

# --- Node deps + Next.js build ---
echo "==> Installing Node dependencies..."
cd "$REPO_DIR"
npm ci
echo "==> Building Next.js..."
npm run build

# --- Python venv ---
echo "==> Creating Python venv..."
python3 -m venv "$REPO_DIR/.venv"
"$REPO_DIR/.venv/bin/pip" install --upgrade pip
"$REPO_DIR/.venv/bin/pip" install -r "$REPO_DIR/services/live_ingestor/requirements.txt"

# --- data directory ---
mkdir -p "$REPO_DIR/data"

# --- systemd services ---
echo "==> Installing systemd services..."
sed "s|REPLACE_WITH_YOUR_USER|$USER|g" "$REPO_DIR/deploy/oil-ingestor.service" \
  | sudo tee /etc/systemd/system/oil-ingestor.service > /dev/null

sed "s|REPLACE_WITH_YOUR_USER|$USER|g" "$REPO_DIR/deploy/oil-dashboard.service" \
  | sudo tee /etc/systemd/system/oil-dashboard.service > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable oil-ingestor oil-dashboard
sudo systemctl start oil-ingestor oil-dashboard

echo ""
echo "==> Services started. Check status with:"
echo "    sudo systemctl status oil-ingestor"
echo "    sudo systemctl status oil-dashboard"
echo ""
echo "==> Add this to /etc/caddy/Caddyfile:"
cat "$REPO_DIR/deploy/Caddyfile.snippet"
echo ""
echo "==> Then run: sudo systemctl reload caddy"
echo "==> Then point cldelta.co DNS A record to: $(curl -sf ifconfig.me 2>/dev/null || echo '<this VM IP>')"
