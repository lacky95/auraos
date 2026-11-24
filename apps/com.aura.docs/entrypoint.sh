#!/bin/bash
# Aura raw-runtime entrypoint for com.aura.docs.
#
# The OS spawns this script with $APP_PORT (the proxy upstream port),
# $APP_ID, $APP_INSTANCE_ID, $OS_API_BASE pre-set by the runner.
#
# Default: PRODUCTION mode via fumadocs-site/serve.mjs — `next build` once
# (only when sources changed), then `next start` in a small flat process.
# serve.mjs watches content/ and app/ and rebuilds + restarts on edits, so
# docs stay editable; a change shows up after one build (~30-60 s).
#
# Dev mode (`next dev --turbo`, instant HMR) for heavy layout work:
#   touch /workspace/apps/com.aura.docs/.dev-mode && aura restart app com.aura.docs
# Remove the marker and restart to go back. Don't leave it on: a long-lived
# Next dev server grows without bound (11 GB on 2026-11-19).
#
# Docs is served from `/` on its App Host (no Next basePath). The runner calls
# /api/lifecycle/* directly, and the shell proxy strips /api/proxy/<id> from
# the agents' MCP, so it arrives as /mcp.
# The lifecycle endpoints + identity headers live inside the Next app via
# @aura/app-sdk/runtime/next.
set -e
APP_DIR=/workspace/apps/com.aura.docs
cd "$APP_DIR/fumadocs-site"

# Install deps lazily on first spawn — mirrors how the synthesised Astro
# entrypoint behaves so a fresh checkout doesn't require a manual install.
if [ ! -d node_modules ]; then
  echo "[${APP_ID:-com.aura.docs}] Installing fumadocs deps..."
  npm install --prefer-offline 2>&1 || npm install
fi

if [ "${DOCS_MODE:-}" = "dev" ] || [ -e "$APP_DIR/.dev-mode" ]; then
  echo "[${APP_ID:-com.aura.docs}] DEV mode: Next.js (turbopack) on port ${APP_PORT:-4001}"
  exec npx next dev --turbo --hostname 0.0.0.0 --port "${APP_PORT:-4001}"
fi

echo "[${APP_ID:-com.aura.docs}] PROD mode: serve.mjs on port ${APP_PORT:-4001}"
exec node serve.mjs
