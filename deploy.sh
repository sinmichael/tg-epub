#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# tg-epub — Deploy script for Oracle Cloud Free Tier (Ubuntu)
# ============================================================
# Run on the Oracle Cloud instance:
#   curl -fsSL https://raw.githubusercontent.com/.../deploy.sh | bash
# Or copy & run manually.

REPO_URL="${REPO_URL:-https://github.com/your-org/tg-epub.git}"
APP_DIR="${APP_DIR:-/opt/tg-epub}"

echo "==> Installing system deps (Docker + Node are already present on Oracle images)"

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker is required. Install it first."
  exit 1
fi

echo "==> Cloning / updating repo"
if [ -d "$APP_DIR" ]; then
  cd "$APP_DIR" && git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> Creating data directory"
mkdir -p "$APP_DIR/data"

echo "==> Setting up .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo ""
  echo "!! IMPORTANT: Edit $APP_DIR/.env and set your BOT_TOKEN !!"
  echo "   Then run: cd $APP_DIR && docker compose up -d"
  exit 0
fi

echo "==> Building and starting"
docker compose build --pull
docker compose up -d

echo "==> Done"
echo "    View logs: docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "    Stop:      docker compose -f $APP_DIR/docker-compose.yml down"
