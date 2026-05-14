#!/usr/bin/env bash
set -e

export PORT="${APP_PORT:-4001}"

if [ ! -d "node_modules" ]; then
  echo "[counter] Installing dependencies..."
  npm install --prefer-offline 2>&1 || npm install
fi

echo "[counter] Starting Astro server on port $PORT"
exec node_modules/.bin/astro dev --host 0.0.0.0 --port "$PORT"
