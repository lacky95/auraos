#!/bin/sh
# The release builder's in-container build (Phase 6 stream B, steps 6 and 7).
# Runs ONLY inside the builder's throwaway container (os/release/builder.mjs):
# the staging tree at /workspace, the shared pnpm store at /pnpm-store, no
# Docker socket, no home, no /data, no AuraOS secrets; registry credentials,
# when configured, only as a 0400 npmrc at $NPM_CONFIG_USERCONFIG. This file
# comes from the release being built (it is verified, but not yet approved
# code: that is why it runs here and nowhere else).
#
#   build.sh deps [--offline]   pnpm install --frozen-lockfile (offline: from the store only);
#                               AURA_BUILD_IGNORE_SCRIPTS=1: no lifecycle script runs (an unapproved
#                               series' fetch with the network and credentials, Phase 7b)
#   build.sh scripts            pnpm rebuild: the skipped scripts, run offline without credentials
#   build.sh build              every package, the shell bundle (AURA_COMPOSITION), the system apps
#   build.sh check              node packages/shell/server.mjs --check (loads the build, no kernel)
#
# The build runs at /workspace, the same path the release is served at, so
# absolute paths baked into a build stay valid at runtime.
set -eu
cd /workspace
export CI=1 ASTRO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
step=${1:?usage: build.sh deps|build|check}
shift
case $step in
  deps)
    offline=
    [ "${1:-}" = --offline ] && offline=--offline
    scripts=
    [ "${AURA_BUILD_IGNORE_SCRIPTS:-}" = 1 ] && scripts="--ignore-scripts --ignore-pnpmfile"
    # shellcheck disable=SC2086
    exec pnpm install --frozen-lockfile --store-dir /pnpm-store --config.confirmModulesPurge=false $offline $scripts
    ;;
  scripts)
    exec pnpm rebuild --store-dir /pnpm-store
    ;;
  build)
    echo "[release] building packages (composition ${AURA_COMPOSITION:-desktop})"
    sh os/build-packages.sh --root /workspace --shell dist-prod
    echo "[release] building system apps"
    exec node os/release/build-apps.mjs /workspace
    ;;
  check)
    cd packages/shell
    AURA_SHELL_DIST=dist-prod exec node server.mjs --check
    ;;
  *) echo "build.sh: unknown step $step" >&2; exit 64 ;;
esac
