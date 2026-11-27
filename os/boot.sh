#!/bin/sh
# AuraOS shell boot — the Dockerfile `development` CMD.
#
#   1. home symlinks (/home/aura, /home/master → the data volume)
#   2. "AuraOS is starting" splash on :3000 (os/boot-splash.mjs)
#   3. pnpm install, build every package, install the CLI shim and bashrc
#   4. stop the splash, start the shell (it takes :3000 over)
#
# Phases go to /data/aura/boot/phase and all output to /data/aura/boot/boot.log
# (and to `docker logs`) — that is what the splash shows. A failed build keeps
# the splash up with the error for AURA_BOOT_FAIL_HOLD_S seconds, then exits
# so the container restart policy retries. AURA_BOOT_SPLASH=0 turns the splash
# off.
#
# AURA_SHELL_MODE (or the file /data/aura/shell-mode) picks how the shell
# runs (docs: deep-dive/shell-runtime-modes):
#   dev  (default) `astro dev`: Vite serves the shell from source with HMR.
#                  The shell's own production build is skipped (unused).
#   prod           the `astro build` output via packages/shell/server.mjs:
#                  bundled, cached assets, faster loads; no HMR (rebuild with
#                  `aura restart os`, or AURA_SHELL_WATCH=1 for an in-process
#                  rebuild on save).
set -u
# Mode: the env var wins; else the persistent switch file (written by
# `aura shell mode prod|dev`, survives restarts and image rebuilds); else dev.
SHELL_MODE_FILE=/data/aura/shell-mode
SHELL_MODE="${AURA_SHELL_MODE:-$(tr -d '[:space:]' < "$SHELL_MODE_FILE" 2>/dev/null)}"
case "$SHELL_MODE" in prod|dev) ;; *) SHELL_MODE=dev ;; esac
# Composition (D76, Phase 6 W): AURA_COMPOSITION, else /data/aura/composition, else
# desktop. `server` builds and serves the shell with no Web Shell (Headless); the
# kernel, API, App Hosts and WS proxy are the same. Exported for the build and the shell.
COMPOSITION_FILE=/data/aura/composition
COMPOSITION="${AURA_COMPOSITION:-$(tr -d '[:space:]' < "$COMPOSITION_FILE" 2>/dev/null)}"
case "$COMPOSITION" in server|desktop) ;; *) COMPOSITION=desktop ;; esac
export AURA_COMPOSITION="$COMPOSITION"
# Prod only: AURA_SHELL_WATCH=1 (or "1"/"on" in /data/aura/shell-watch) makes
# the running prod shell rebuild itself on source saves and swap to the new
# build in-process (packages/shell/server/watchRebuild.mjs) — live changes on
# top of a stable build. The env var wins, like the mode above.
SHELL_WATCH_FILE=/data/aura/shell-watch
SHELL_WATCH="${AURA_SHELL_WATCH:-$(tr -d '[:space:]' < "$SHELL_WATCH_FILE" 2>/dev/null)}"
case "$SHELL_WATCH" in 1|on|true) export AURA_SHELL_WATCH=1 ;; *) unset AURA_SHELL_WATCH ;; esac

# Git must never ask for a username or password. The container has a tty, so a
# missing credential would make git wait on a prompt nobody can answer — and
# the shell runs git with execFileSync, which freezes the whole OS for the
# call's timeout. With these it fails at once.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never

BOOT_DIR=/data/aura/boot
LOG="$BOOT_DIR/boot.log"
mkdir -p "$BOOT_DIR"
: > "$LOG"

phase() {
  echo "$*" > "$BOOT_DIR/phase"
  echo "[aura] boot: $*" | tee -a "$LOG"
}

# Run a command; its output goes to the log and stdout; returns its status
# (plain sh has no pipefail, so the status travels through a file).
run() {
  { "$@" 2>&1; echo $? > "$BOOT_DIR/.rc"; } | tee -a "$LOG"
  return "$(cat "$BOOT_DIR/.rc")"
}

SPLASH_PID=""
stop_splash() {
  [ -n "$SPLASH_PID" ] || return 0
  kill "$SPLASH_PID" 2>/dev/null
  wait "$SPLASH_PID" 2>/dev/null
  SPLASH_PID=""
}

fail() {
  phase failed "$1"
  echo "[aura] boot failed while $1 — see $LOG" | tee -a "$LOG"
  sleep "${AURA_BOOT_FAIL_HOLD_S:-300}"
  stop_splash
  exit 1
}

mkdir -p /data/aura/home/master /data/aura/home/default \
  && rm -f /home/master /home/aura \
  && ln -s /data/aura/home/master /home/master \
  && ln -s /data/aura/home/default /home/aura

if [ "${AURA_BOOT_SPLASH:-1}" != "0" ] && [ -f /workspace/os/boot-splash.mjs ]; then
  node /workspace/os/boot-splash.mjs &
  SPLASH_PID=$!
fi

phase installing
run pnpm install \
  || echo '[aura] pnpm install exited non-zero (likely ERR_PNPM_IGNORED_BUILDS) — continuing' | tee -a "$LOG"

phase building
# When to build: Settings → About → Update / Rebuild (and `aura restart os
# --rebuild`) are the real build — the updater leaves BUILD_REQUEST for this
# boot. A plain restart builds nothing, except a first boot whose build
# output is missing. AURA_FORCE_BUILD=1 forces a build.
#
# What to build: each package is fingerprinted (its git tree, uncommitted
# changes and untracked files under packages/<name>) and compared with the
# fingerprint of its last build (packages/.aura-build-<mode>, one
# "<name> <fp>" line each). A changed package is rebuilt together with the
# packages that depend on it (pnpm's "...{dir}" filter); a commit that only
# touches apps/ or docs builds nothing. Root inputs (lockfile, root package
# and tsconfig) changing — or no git — build everything. A package whose
# output is missing counts as changed.
build_fingerprint() {   # $1 = package dir under packages/, or "_root"
  ( cd /workspace || exit 0
    if [ "$1" = _root ]; then
      git rev-parse HEAD:pnpm-lock.yaml HEAD:package.json HEAD:tsconfig.base.json HEAD:pnpm-workspace.yaml
      git diff HEAD -- pnpm-lock.yaml package.json tsconfig.base.json pnpm-workspace.yaml
    else
      git rev-parse "HEAD:packages/$1"
      git diff HEAD -- "packages/$1"
      git ls-files -z -o --exclude-standard -- "packages/$1" | xargs -0 -r sha1sum
    fi 2>/dev/null | sha1sum | cut -d' ' -f1 )
}
BUILD_STAMP="/workspace/packages/.aura-build-$SHELL_MODE"
BUILD_REQUEST="$BOOT_DIR/build-requested"
# The prod shell is built into its own folder: anything else that runs the
# usual `pnpm --filter ./packages/* build` (it writes packages/shell/dist) can
# no longer delete the build the running/booting server serves.
SHELL_PROD_DIST=dist-prod
# The build itself is os/build-packages.sh, shared with the release builder (D36).
BUILD_PACKAGES=/workspace/os/build-packages.sh

stamp_of() { grep "^$1 " "$BUILD_STAMP" 2>/dev/null | cut -d' ' -f2; }
output_ok() {
  # The prod shell build must also be of this composition (its .aura-composition marker).
  if [ "$1" = shell ]; then [ -f "/workspace/packages/shell/$SHELL_PROD_DIST/server/entry.mjs" ] \
    && grep -q "\"composition\": \"$COMPOSITION\"" "/workspace/packages/shell/$SHELL_PROD_DIST/.aura-composition" 2>/dev/null
  else [ -d "/workspace/packages/$1/dist" ]; fi
}

PKGS=$(sh "$BUILD_PACKAGES" --list | tr '\n' ' ')
# Current fingerprints, "<name> <fp>" per line (POSIX sh: no arrays).
FPS_FILE="$BOOT_DIR/.fingerprints"
: > "$FPS_FILE"
for p in _root $PKGS; do echo "$p $(build_fingerprint "$p")" >> "$FPS_FILE"; done
fp_of() { grep "^$1 " "$FPS_FILE" | cut -d' ' -f2; }

# Which packages differ from their last build, and which have no output yet.
DIFF=""; MISSING=""
for p in $PKGS; do
  if [ "$p" = shell ] && [ "$SHELL_MODE" != prod ]; then continue; fi   # dev: astro dev builds nothing
  output_ok "$p" || MISSING="$MISSING $p"
  [ "$(fp_of "$p")" = "$(stamp_of "$p")" ] || DIFF="$DIFF $p"
done

CHANGED=""
if [ -f "$BUILD_REQUEST" ] || [ "${AURA_FORCE_BUILD:-0}" = 1 ] || [ -n "$MISSING" ]; then
  if [ -f "$BUILD_REQUEST" ]; then
    echo "[aura] boot: build requested ($(cat "$BUILD_REQUEST" 2>/dev/null))" | tee -a "$LOG"
    # Apps are built after the shell is up (shell lib/appBuilds.ts reads this).
    touch "$BOOT_DIR/apps-build-requested"
  elif [ -n "$MISSING" ]; then
    echo "[aura] boot: first build — no output yet for:$MISSING" | tee -a "$LOG"
  fi
  if ! git -C /workspace rev-parse -q --verify HEAD >/dev/null 2>&1 \
     || [ "$(fp_of _root)" != "$(stamp_of _root)" ]; then
    CHANGED="$PKGS"
  else
    for p in $PKGS; do
      case " $DIFF $MISSING " in *" $p "*) CHANGED="$CHANGED $p" ;; esac
    done
  fi
  [ -n "$CHANGED" ] || rm -f "$BUILD_REQUEST"   # requested, but nothing to do
elif [ -n "$DIFF" ]; then
  echo "[aura] boot: sources changed since the last build:$DIFF — not built on a plain restart (Settings → About → Rebuild, or aura restart os --rebuild)" | tee -a "$LOG"
fi

if [ -z "$CHANGED" ]; then
  [ -n "$DIFF" ] || echo "[aura] boot: packages unchanged since the last build — build skipped" | tee -a "$LOG"
else
  echo "[aura] boot: changed:$CHANGED — building those and their dependents" | tee -a "$LOG"
  # dev: astro dev serves the shell from source, so no shell bundle.
  SHELL_ARGS=""
  [ "$SHELL_MODE" = prod ] && SHELL_ARGS="--shell $SHELL_PROD_DIST"
  # shellcheck disable=SC2086
  run sh "$BUILD_PACKAGES" --root /workspace $SHELL_ARGS $CHANGED || fail building
  # Everything built (or unchanged): this state is the new baseline.
  cp "$FPS_FILE" "$BUILD_STAMP"
  rm -f "$BUILD_REQUEST"
fi

install -D -m 0755 /workspace/os/aura-cli-shim.sh /usr/local/bin/aura \
  && install -D -m 0755 /workspace/os/aura-cli-shim.sh /os/toolchain/bin/aura \
  && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/root/.bashrc \
  && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/etc/profile.d/aura-prompt.sh \
  && install -D -m 0644 /workspace/os/bashrc.aura.sh /os/base-rootfs/etc/bash.bashrc \
  && install -D -m 0644 /workspace/os/toolchain-path.sh /etc/profile.d/aura-toolchain.sh \
  || fail building

phase starting
(pnpm --filter @aura/cli build:watch &)
stop_splash
if [ "$SHELL_MODE" = prod ]; then
  echo "[aura] boot: shell mode prod (packages/shell/server.mjs)${AURA_SHELL_WATCH:+, watching sources for live rebuilds}" | tee -a "$LOG"
  # node itself is PID 1: SIGTERM to a PID 1 without a handler is dropped,
  # and the pnpm launcher has none — docker stop then killed the shell after
  # 10 s without the desktop save of server.mjs (lib/desktopSession.ts).
  cd /workspace/packages/shell || fail starting
  PATH="/workspace/packages/shell/node_modules/.bin:$PATH" exec node server.mjs
fi
# Astro 7: stay in the foreground under an agent (ASTRO_DEV_BACKGROUND=0) and
# skip the .astro/dev.json lock (--ignore-lock) — boot supervises the shell,
# exactly as with Astro 6 (provisioning.ts ASTRO_START_SHELL does the same).
# node is PID 1 here too (not the pnpm launcher, which drops SIGTERM as PID 1):
# docker stop runs the kernel shutdown (Phase 6 K, D77) in both shell modes.
cd /workspace/packages/shell || fail starting
ASTRO_DEV_BACKGROUND=0 PATH="/workspace/packages/shell/node_modules/.bin:$PATH" exec astro dev --host 0.0.0.0 --ignore-lock
