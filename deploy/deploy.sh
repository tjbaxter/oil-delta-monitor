#!/usr/bin/env bash
# Pull latest code and restart services.
# Run after every git push to redeploy.
# Usage: bash deploy/deploy.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "==> Pulling latest code..."
git pull

echo "==> Installing Node dependencies..."
npm ci

echo "==> Building Next.js..."
npm run build

echo "==> Updating Python dependencies..."
.venv/bin/pip install -r services/live_ingestor/requirements.txt --quiet

echo "==> Restarting services..."
sudo systemctl restart oil-ingestor
sudo systemctl restart oil-dashboard

echo "==> Done at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
sudo systemctl status oil-ingestor --no-pager -l | tail -3
sudo systemctl status oil-dashboard --no-pager -l | tail -3
