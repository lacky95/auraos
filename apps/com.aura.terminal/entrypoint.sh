#!/usr/bin/env bash
set -e

export PORT="${APP_PORT:-4001}"

# Install dependencies if not yet installed
if [ ! -d "node_modules" ]; then
  echo "[terminal] Installing dependencies..."
  npm install --prefer-offline 2>&1 || npm install
fi

echo "[terminal] Starting Astro server on port $PORT"
exec node_modules/.bin/astro dev --host 0.0.0.0 --port "$PORT"
