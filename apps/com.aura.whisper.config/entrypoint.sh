#!/bin/bash
# Aura raw-runtime entrypoint for com.aura.whisper.config — the
# settings UI for the headless com.aura.whisper service.
set -e
cd "/workspace/apps/${APP_ID:-com.aura.whisper.config}"
if [ ! -d node_modules ]; then
  echo "[${APP_ID:-com.aura.whisper.config}] Installing deps..."
  npm install --prefer-offline 2>&1 || npm install
fi
echo "[${APP_ID:-com.aura.whisper.config}] Starting Express on port ${APP_PORT:-4001}"
exec node server.js
