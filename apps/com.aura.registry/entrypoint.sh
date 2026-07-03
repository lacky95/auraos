#!/bin/bash
# Aura raw-runtime entrypoint for com.aura.registry.
#
# Two processes in one container:
#   1. zot — OCI Distribution server, listens on 127.0.0.1:5000 (internal,
#      not exposed; the wrapper below is what the shell proxy talks to).
#   2. server.js — tiny Node HTTP wrapper that exposes /api/lifecycle/*
#      (AppManager health/lifecycle contract) on $APP_PORT and forwards
#      everything else to the local zot. Without this layer the AppManager's
#      `/api/lifecycle/health` probe would 404 because zot only serves /v2/.
#
# Storage: /data/oci (inside the persistent app-data volume subpath the
# ContainerRunner mounts at /data). Survives container recreation.
set -e
cd "/workspace/apps/${APP_ID:-com.aura.registry}"

# zot config — minimal, no auth, no remote sync. The internal-only port
# (5000) is what the wrapper talks to; APP_PORT is what the shell sees.
CFG_DIR="/tmp/zot"
mkdir -p "$CFG_DIR" /data/oci
cat > "$CFG_DIR/config.json" <<'JSON'
{
  "distSpecVersion": "1.1.0",
  "storage":         { "rootDirectory": "/data/oci" },
  "http":            { "address": "127.0.0.1", "port": "5000" },
  "log":             { "level": "info" }
}
JSON

echo "[${APP_ID:-com.aura.registry}] starting zot (internal :5000)..."
zot serve "$CFG_DIR/config.json" &
ZOT_PID=$!

# If zot dies the wrapper has no upstream — propagate the failure so
# AppManager respawns the whole container.
trap "echo '[registry] zot died ($?), stopping wrapper'; kill 0" EXIT

echo "[${APP_ID:-com.aura.registry}] starting wrapper on :${APP_PORT:-4090}"
exec node server.js
