#!/bin/bash
# Aura raw-runtime entrypoint for com.aura.whisper.
#
# The shell spawns this with $APP_PORT, $APP_ID, $APP_INSTANCE_ID,
# $OS_API_BASE pre-set. We exec a plain Node Express server that serves
# the config UI + the AuraOS lifecycle endpoints + the unified
# /api/transcribe API, and manages the two sibling Docker containers
# (faster-whisper-server + litellm) it relies on.
set -e
cd "/workspace/apps/${APP_ID:-com.aura.whisper}"

if [ ! -d node_modules ]; then
  echo "[${APP_ID:-com.aura.whisper}] Installing deps..."
  npm install --prefer-offline 2>&1 || npm install
fi

echo "[${APP_ID:-com.aura.whisper}] Starting Express on port ${APP_PORT:-4001}"
exec node server.js
