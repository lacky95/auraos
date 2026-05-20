#!/bin/bash
# Aura raw-runtime entrypoint for com.aura.docs.
#
# The OS spawns this script with $APP_PORT (the proxy upstream port),
# $APP_ID, $APP_INSTANCE_ID, $OS_API_BASE pre-set by the runner. We exec
# Next.js's dev server directly on $APP_PORT — no Astro layer in between.
#
# Next.js's basePath is derived from $APP_INSTANCE_ID at startup (see
# fumadocs-site/next.config.mjs) so multi-instance shifts the prefix
# without a rebuild. The lifecycle endpoints + identity headers live
# inside the Next app via @aura/app-sdk/runtime/next.
set -e
cd /workspace/apps/com.aura.docs/fumadocs-site

# Install deps lazily on first spawn — mirrors how the synthesised Astro
# entrypoint behaves so a fresh checkout doesn't require a manual install.
if [ ! -d node_modules ]; then
  echo "[${APP_ID:-com.aura.docs}] Installing fumadocs deps..."
  npm install --prefer-offline 2>&1 || npm install
fi

echo "[${APP_ID:-com.aura.docs}] Starting Next.js (turbopack) on port ${APP_PORT:-4001} (basePath=/api/proxy/${APP_INSTANCE_ID:-com.aura.docs})"
# --turbo: Rust-based dev bundler (stable in Next 15). On fumadocs the cold
# webpack compile for /docs/[[...slug]] is ~1.1 s; Turbopack drops it
# typically to a few hundred ms because it skips the module-graph rebuild
# webpack does each first-hit. HMR semantics are unchanged.
exec npx next dev --turbo --hostname 0.0.0.0 --port "${APP_PORT:-4001}"
