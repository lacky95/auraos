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
# AURA_SHELL_MODE picks how the shell runs (docs: deep-dive/shell-runtime-modes):
#   dev  (default) `astro dev`: Vite serves the shell from source with HMR.
#                  The shell's own production build is skipped (unused).
#   prod           the `astro build` output via packages/shell/server.mjs:
#                  bundled, cached assets, faster loads; no HMR (rebuild with
#                  `aura restart os`, or AURA_SHELL_WATCH=1 for an in-process
#                  rebuild on save).
set -u
SHELL_MODE="${AURA_SHELL_MODE:-dev}"

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
if [ "$SHELL_MODE" = prod ]; then
  run pnpm --filter "./packages/*" build || fail building
else
  run pnpm --filter "./packages/*" --filter '!@aura/shell' build || fail building
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
  echo "[aura] boot: shell mode prod (packages/shell/server.mjs)" | tee -a "$LOG"
  exec pnpm --filter @aura/shell start
fi
exec pnpm --filter @aura/shell dev --host 0.0.0.0
