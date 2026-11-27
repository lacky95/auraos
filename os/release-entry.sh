#!/bin/sh
# AuraOS shell entry in the Normal layout: the Dockerfile `release` CMD
# (Phase 6 L, D1–D4, D34; docker-compose.release.yml).
#
#   1. home symlinks (/home/aura, /home/master → the data volume), like boot.sh
#   2. the release: pointer.json `current`, else `previous` (only a complete
#      release, `.complete`), else fail with the host recovery command (D2)
#   3. /workspace → /releases/<id>: every /workspace path of the shell keeps
#      working (D57), and /releases is a read-only mount, so any write into the
#      tree fails with EROFS, root included (D34)
#   4. the CLI shim and the AuraOS bashrc from the release (as boot.sh does)
#   5. exec node packages/shell/server.mjs (production; node is PID 1, so
#      `docker stop` runs the kernel shutdown, D77)
#
# No pnpm install and no build at boot: the release was built by the release
# builder (os/release/builder.mjs) and is immutable. Falling back to
# `previous` does not rewrite the pointer: switching is the updater's
# (stream U) or os/release-ctl.sh's. Phases go to /data/aura/boot/phase.
set -u
DATA=${AURA_DATA_DIR:-/data}
RELEASES=/releases
WORKSPACE=/workspace
BOOT_DIR=$DATA/aura/boot
POINTER=$DATA/aura/release/pointer.json
mkdir -p "$BOOT_DIR"

phase() {
  echo "$*" > "$BOOT_DIR/phase"
  echo "[aura] boot: $*"
}

recovery_hint() {
  img=${AURA_SHELL_IMAGE:-aura-shell:<a kept tag>}
  echo "[aura] Recover from the host (the shell is not needed):" >&2
  echo "[aura]   docker run --rm -v <data volume>:/data -v /var/run/docker.sock:/var/run/docker.sock $img /os/release-ctl.sh status" >&2
  echo "[aura]   … /os/release-ctl.sh rollback      (back to the previous release)" >&2
  echo "[aura]   … /os/release-ctl.sh use <id>      (a kept release; see status)" >&2
  echo "[aura] Docs: Releases and updates (host recovery)." >&2
}

fail() {
  phase failed "$1"
  echo "[aura] boot failed: $1" >&2
  recovery_hint
  # Hold, then exit: the restart policy retries (a fixed pointer is picked up).
  sleep "${AURA_BOOT_FAIL_HOLD_S:-60}"
  exit 1
}

mkdir -p "$DATA/aura/home/master" "$DATA/aura/home/default" \
  && rm -f /home/master /home/aura \
  && ln -s "$DATA/aura/home/master" /home/master \
  && ln -s "$DATA/aura/home/default" /home/aura

phase release
[ -d "$RELEASES" ] || fail "no $RELEASES mount: this is the Normal layout's entry (docker-compose.release.yml)"
[ -f "$POINTER" ] || fail "no release pointer at $POINTER: nothing was installed (install.sh)"

# pointer.json → "current previous" (node is in the image; no jq).
IDS=$(node -e '
  const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ok = (v) => typeof v === "string" && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,100}$/.test(v) && !v.startsWith(".staging-");
  process.stdout.write(`${ok(p.current) ? p.current : "-"} ${ok(p.previous) ? p.previous : "-"}`);
' "$POINTER" 2>/dev/null) || fail "the release pointer $POINTER is unreadable"
CURRENT=${IDS% *}
PREVIOUS=${IDS#* }

ID=
for cand in "$CURRENT" "$PREVIOUS"; do
  [ "$cand" != - ] || continue
  if [ -f "$RELEASES/$cand/.complete" ] && [ -f "$RELEASES/$cand/release.json" ]; then ID=$cand; break; fi
  echo "[aura] boot: release $cand is not complete (no .complete): not served" >&2
done
[ -n "$ID" ] || fail "neither the current release ($CURRENT) nor the previous one ($PREVIOUS) is complete"
if [ "$ID" != "$CURRENT" ]; then
  echo "[aura] boot: FALLBACK to the previous release $ID (the current one, $CURRENT, is incomplete); the pointer is unchanged" >&2
  echo "fallback $ID (current $CURRENT incomplete)" > "$BOOT_DIR/release-fallback"
else
  rm -f "$BOOT_DIR/release-fallback"
fi

# /workspace becomes the release. The image's WORKDIR left an empty dir there.
if [ -L "$WORKSPACE" ]; then rm -f "$WORKSPACE"
elif [ -d "$WORKSPACE" ]; then rmdir "$WORKSPACE" 2>/dev/null || fail "$WORKSPACE is not empty: the Normal layout never binds a checkout there"
fi
ln -s "$RELEASES/$ID" "$WORKSPACE" || fail "cannot link $WORKSPACE to $RELEASES/$ID"
echo "[aura] boot: release $ID ($(node -e 'const r=require(process.argv[1]);process.stdout.write(`${r.version ?? "main"} ${String(r.commit ?? "").slice(0, 12)} ${r.provenance ?? ""}`)' "$WORKSPACE/release.json" 2>/dev/null))"

install -D -m 0755 "$WORKSPACE/os/aura-cli-shim.sh" /usr/local/bin/aura \
  && install -D -m 0755 "$WORKSPACE/os/aura-cli-shim.sh" /os/toolchain/bin/aura \
  && install -D -m 0644 "$WORKSPACE/os/bashrc.aura.sh" /os/base-rootfs/root/.bashrc \
  && install -D -m 0644 "$WORKSPACE/os/bashrc.aura.sh" /os/base-rootfs/etc/profile.d/aura-prompt.sh \
  && install -D -m 0644 "$WORKSPACE/os/bashrc.aura.sh" /os/base-rootfs/etc/bash.bashrc \
  && install -D -m 0644 "$WORKSPACE/os/toolchain-path.sh" /etc/profile.d/aura-toolchain.sh \
  || fail "installing the CLI shim and bashrc from the release"

# Git must never ask for credentials (see boot.sh).
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
export NODE_ENV=production AURA_SHELL_MODE=prod
phase starting
cd "$WORKSPACE/packages/shell" || fail "the release has no packages/shell"
PATH="$WORKSPACE/packages/shell/node_modules/.bin:$PATH" exec node server.mjs
