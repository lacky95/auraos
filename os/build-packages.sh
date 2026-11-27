#!/bin/sh
# Builds the AuraOS packages: the ONE package build path (D36) of
#   - os/boot.sh            Developer Mode's in-place build in /workspace (incremental:
#                           boot.sh decides from its fingerprints what changed), and
#   - os/release/build.sh   the release builder's staging build (always everything).
#
#   build-packages.sh --list                       the package names (packages/*/ with a package.json)
#   build-packages.sh [--root DIR] [--shell OUTDIR] [PKG...]
#
# PKG...          changed packages: they and their dependents are built; none = all.
# --shell OUTDIR  also build the shell's production bundle into packages/shell/OUTDIR
#                 when one of PKG is a shell input (or with no PKG). AURA_COMPOSITION
#                 (server|desktop, Phase 6 W) passes through to `astro build`.
# --root DIR      the tree to build (default /workspace).
# Exit 1 when a build fails.
set -u
ROOT=/workspace
SHELL_OUT=
LIST=0
while [ $# -gt 0 ]; do
  case $1 in
    --root) ROOT=$2; shift ;;
    --shell) SHELL_OUT=$2; shift ;;
    --list) LIST=1 ;;
    --) shift; break ;;
    -*) echo "build-packages.sh: unknown option $1" >&2; exit 64 ;;
    *) break ;;
  esac
  shift
done
cd "$ROOT" || exit 1

ALL=""
for d in packages/*/; do
  [ -f "${d}package.json" ] && ALL="$ALL $(basename "$d")"
done
if [ "$LIST" = 1 ]; then
  for p in $ALL; do echo "$p"; done
  exit 0
fi
CHANGED="$*"
[ -n "$CHANGED" ] || CHANGED="$ALL"

# Packages the shell bundle is built from (it aliases them to their sources).
SHELL_INPUTS=" shell core kv-store ui "

LIB_FILTERS=""
BUILD_SHELL=0
for p in $CHANGED; do
  [ "$p" = shell ] || LIB_FILTERS="$LIB_FILTERS --filter ...{./packages/$p}"
  case "$SHELL_INPUTS" in *" $p "*) BUILD_SHELL=1 ;; esac
done
if [ -n "$LIB_FILTERS" ]; then
  # Unquoted on purpose: each "--filter ...{dir}" pair splits into two words.
  # "...{dir}" also selects dependents outside packages/ (apps depend on
  # @aura/core): only packages/ is built here.
  # shellcheck disable=SC2086
  pnpm $LIB_FILTERS --filter '!@aura/shell' --filter '!./apps/**' build || exit 1
fi
if [ -n "$SHELL_OUT" ] && [ "$BUILD_SHELL" = 1 ]; then
  # The container runs with NODE_ENV=development (dev tooling, app sandboxes);
  # the shell's own bundle must be a production build: without this Vite
  # bundles React's development code into the desktop.
  env NODE_ENV=production pnpm --filter @aura/shell exec astro build --outDir "$SHELL_OUT" || exit 1
fi
exit 0
