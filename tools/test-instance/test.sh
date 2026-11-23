#!/usr/bin/env bash
# Tests for copy-data.sh and check-isolation.sh. Synthetic fixtures only.
# A stub `docker` is first on PATH, so no real daemon is ever contacted.
set -uo pipefail
export LC_ALL=C

HERE=$(cd "$(dirname "$0")" && pwd)
COPY="$HERE/copy-data.sh"
CHECK="$HERE/check-isolation.sh"
T=$(mktemp -d)
FAKE_PID=""
cleanup() {
  if [ -n "$FAKE_PID" ]; then kill "$FAKE_PID" 2>/dev/null; wait "$FAKE_PID" 2>/dev/null; fi
  rm -rf -- "$T"
}
trap cleanup EXIT

PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; [ -z "${2:-}" ] || printf '     %s\n' "$2"; }
expect_rc() { # name expected_rc command...
  local name=$1 want=$2 got; shift 2
  OUT=$("$@" 2>&1); got=$?
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "rc=$got want=$want: $(printf '%s' "$OUT" | tail -2)"; fi
}
absent() { if [ -e "$2" ] || [ -L "$2" ]; then bad "$1" "present: $2"; else ok "$1"; fi; }
present() { if [ -e "$2" ] || [ -L "$2" ]; then ok "$1"; else bad "$1" "missing: $2"; fi; }

mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Records verbs and answers from STUB_* variables. Mutating verbs fail.
host=""
while [ $# -gt 0 ]; do
  case "$1" in -H|--context) host=$2; shift 2 ;; *) break ;; esac
done
printf '%s\n' "$*" >> "${STUB_LOG:-/dev/null}"
case "$1 ${2:-}" in
  "info "*)
    [ "${STUB_UNREACHABLE:-}" != "$host" ] || exit 1
    case "$host" in live*) echo "LIVE-ID" ;; *) echo "${STUB_TARGET_ID:-TARGET-ID}" ;; esac ;;
  "ps -q") [ "${STUB_DOCKER_DOWN:-}" != 1 ] || exit 1; printf '%s' "${STUB_RUNNING:-}" ;;
  "ps -a") printf '%b' "${STUB_PS:-}" ;;
  "inspect "*) printf '%b' "${STUB_MOUNTS:-}" ;;
  "volume ls") printf '%b' "${STUB_VOLUMES:-}" ;;
  "network ls") printf 'bridge\nhost\nnone\n'; printf '%b' "${STUB_NETWORKS:-}" ;;
  *) echo "stub refuses: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" STUB_LOG="$T/docker.log"
unset DOCKER_HOST DOCKER_CONTEXT AURA_DATA_DIR

snapshot() { (cd "$1" && find . -printf '%p|%y|%s|%T@|%l\n' | sort | sha256sum); }

make_fixture() {
  local s=$1
  mkdir -p "$s"/scopes/users/default/apps/com.ex.a "$s"/apps/com.ex.b "$s"/nexus/cache \
    "$s"/aura/secrets "$s"/context "$s"/kv "$s"/aura/runtime/i1 "$s"/aura/mounts/m \
    "$s"/aura/boot "$s"/aura/update "$s"/aura/state "$s"/dev/wt \
    "$s"/aura/home/default/.ssh "$s"/aura/home/default/.docker "$s"/aura/home/default/.claude/x \
    "$s"/aura/home/default/.codex "$s"/aura/home/default/.config/gh "$s"/aura/home/default/work \
    "$s"/aura/home/master/.ssh "$s"/aura/home/default/work/nested/.ssh
  echo app > "$s/scopes/users/default/apps/com.ex.a/index.txt"
  echo app > "$s/apps/com.ex.b/data.txt"
  echo nx > "$s/nexus/cache/catalog.json"
  echo FIXTURE_SECRET > "$s/aura/secrets/s.key"
  echo FIXTURE_SECRET > "$s/context/.masterkey"
  echo FIXTURE_SECRET > "$s/kv/aura.rdb"
  echo x > "$s/kv-migration.json"; echo x > "$s/kv-redis-backup.orig"
  echo x > "$s/aura/warm-pool.json"; echo x > "$s/aura/runtime/i1/f"
  echo x > "$s/aura/mounts/m/f"; echo x > "$s/aura/boot/boot.log"; echo x > "$s/aura/update/job"
  echo x > "$s/dev/wt/f"; echo x > "$s/aura/state/f"
  local h
  for h in .ssh/id_ed25519 .docker/config.json .claude/x/creds .codex/auth .config/gh/hosts \
    .gitconfig .bash_history .netrc .git-credentials .claude.json work/nested/.ssh/key; do
    echo FIXTURE_SECRET > "$s/aura/home/default/$h"
  done
  echo FIXTURE_SECRET > "$s/aura/home/master/.ssh/id"
  echo note > "$s/aura/home/default/work/notes.txt"
  # Symlinks: safe, then every escape or leak shape.
  local a="$s/scopes/users/default/apps/com.ex.a"
  ln -s index.txt "$a/safe-link"
  ln -s ../../../../../apps/com.ex.b/data.txt "$a/safe-cross-root"
  ln -s /etc/passwd "$a/abs-escape"
  ln -s "$s/apps/com.ex.b/data.txt" "$a/abs-into-source"
  ln -s ../../../../../../../../../../etc/passwd "$a/rel-escape"
  ln -s ../../../../../context/.masterkey "$a/to-masterkey"
  ln -s ../../../../../aura/secrets "$a/to-secrets-dir"
  ln -s ../../../../../aura/home/default/.ssh/id_ed25519 "$a/to-ssh"
  ln -s ../../../../../kv/aura.rdb "$a/to-kv"
  ln -s to-masterkey "$a/chain-to-masterkey"
  ln -s ../../../../.. "$a/to-source-root"
  ln -s /etc "$a/dir-escape"
  ln -s ../.ssh/id_ed25519 "$s/aura/home/default/work/home-to-ssh"
  ln -s notes.txt "$s/aura/home/default/work/home-safe"
  ln "$s/context/.masterkey" "$s/apps/com.ex.b/hardlinked-masterkey"
  ln "$s/apps/com.ex.b/data.txt" "$s/apps/com.ex.b/hardlink-safe"
  mkfifo "$s/apps/com.ex.b/a-fifo"
  find "$s" -exec touch -h -d '2020-01-01 00:00:00' {} +
}

SRC="$T/src"; make_fixture "$SRC"
BEFORE=$(snapshot "$SRC")

# Dry run
D="$T/dry"
expect_rc "dry-run succeeds" 0 "$COPY" --source "$SRC" --dest "$D"
absent "dry-run does not create dest" "$D"
case "$OUT" in *"Dry run: nothing was written"*) ok "dry-run says so" ;; *) bad "dry-run says so" ;; esac
case "$OUT" in *FIXTURE_SECRET*) bad "summary prints no contents" ;; *) ok "summary prints no contents" ;; esac
case "$OUT" in *"context/.masterkey"*) ok "summary names excluded paths" ;; *) bad "summary names excluded paths" ;; esac
case "$OUT" in *"may embed tokens"*) ok "summary warns about app data" ;; *) bad "summary warns about app data" ;; esac
case "$OUT" in *"Context secrets are not copied"*) ok "summary explains key/KV pair" ;; *) bad "summary explains key/KV pair" ;; esac
mkdir "$T/empty-dry"
expect_rc "dry-run with empty dest" 0 "$COPY" --source "$SRC" --dest "$T/empty-dry"
[ -z "$(ls -A "$T/empty-dry")" ] && ok "dry-run leaves empty dest empty" || bad "dry-run leaves empty dest empty"

# Refusals
expect_rc "requires --source" 2 "$COPY" --dest "$T/x"
expect_rc "requires --dest" 2 "$COPY" --source "$SRC"
expect_rc "unknown argument" 2 "$COPY" --source "$SRC" --dest "$T/x" --nope
expect_rc "missing source" 1 "$COPY" --source "$T/no-such" --dest "$T/x"
expect_rc "dest equals source" 1 "$COPY" --source "$SRC" --dest "$SRC" --apply --confirm-stopped-snapshot
expect_rc "dest inside source" 1 "$COPY" --source "$SRC" --dest "$SRC/apps/copy" --apply --confirm-stopped-snapshot
mkdir -p "$T/outer/inner"; make_fixture "$T/outer/inner"
expect_rc "source inside dest" 1 "$COPY" --source "$T/outer/inner" --dest "$T/outer" --apply --confirm-stopped-snapshot
ln -s "$SRC/apps" "$T/link-into-src"
expect_rc "dest via symlink into source" 1 "$COPY" --source "$SRC" --dest "$T/link-into-src/x" --apply --confirm-stopped-snapshot
for p in / /data /workspace /data/copy /workspace/copy; do
  expect_rc "dest refused: $p" 1 "$COPY" --source "$SRC" --dest "$p" --apply --confirm-stopped-snapshot
done
mkdir "$T/nonempty"; echo keep > "$T/nonempty/f"
expect_rc "dest non-empty" 1 "$COPY" --source "$SRC" --dest "$T/nonempty" --apply --confirm-stopped-snapshot
[ "$(cat "$T/nonempty/f")" = keep ] && ok "non-empty dest untouched" || bad "non-empty dest untouched"
echo f > "$T/dest-file"
expect_rc "dest is a file" 1 "$COPY" --source "$SRC" --dest "$T/dest-file" --apply --confirm-stopped-snapshot

# Live-source detection
L="$T/live-a"
STUB_DOCKER_DOWN=1 expect_rc "apply refused when liveness unknown" 1 "$COPY" --source "$SRC" --dest "$L" --apply
absent "unknown liveness wrote nothing" "$L"
mkdir -p "$T/hn"; printf '#!/bin/sh\necho aura-shell\n' > "$T/hn/hostname"; chmod +x "$T/hn/hostname"
AURA_COPY_TEST_LIVE_DATA_PATH="$SRC" PATH="$T/hn:$PATH" expect_rc "refused inside aura-shell on data dir" 1 \
  "$COPY" --source "$SRC" --dest "$L" --apply
absent "aura-shell refusal wrote nothing" "$L"
AURA_DATA_DIR="$SRC" expect_rc "refused when source is AURA_DATA_DIR" 1 "$COPY" --source "$SRC" --dest "$L" --apply
STUB_RUNNING=abc STUB_MOUNTS="/aura-x\t$SRC\t/data\n" expect_rc "refused: running container mounts source" 1 \
  "$COPY" --source "$SRC" --dest "$L" --apply --confirm-stopped-snapshot
absent "container refusal not overridable" "$L"
touch "$SRC/kv/aura.rdb"
expect_rc "refused: recent kv write" 1 "$COPY" --source "$SRC" --dest "$L" --apply
touch -d '2020-01-01 00:00:00' "$SRC/kv/aura.rdb"
cp "$(command -v sleep)" "$T/bin/valkey-server"
( cd "$SRC/kv" && exec "$T/bin/valkey-server" 60 ) &
FAKE_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(cat "/proc/$FAKE_PID/comm" 2>/dev/null)" = valkey-server ] && break
  sleep 0.1
done
expect_rc "refused: running Valkey on source" 1 "$COPY" --source "$SRC" --dest "$L" --apply
expect_rc "Valkey refusal not overridable" 1 "$COPY" --source "$SRC" --dest "$L" --apply --confirm-stopped-snapshot
absent "Valkey refusal wrote nothing" "$L"
kill "$FAKE_PID" 2>/dev/null; wait "$FAKE_PID" 2>/dev/null; FAKE_PID=""
rm -f "$T/bin/valkey-server"
STUB_DOCKER_DOWN=1 expect_rc "flag overrides heuristic" 0 "$COPY" --source "$SRC" --dest "$T/live-ok" --apply --confirm-stopped-snapshot
present "override copied" "$T/live-ok/apps/com.ex.b/data.txt"

# Default apply
D="$T/out"
expect_rc "apply succeeds" 0 "$COPY" --source "$SRC" --dest "$D" --apply
A="$D/scopes/users/default/apps/com.ex.a"
present "copies scopes" "$A/index.txt"
present "copies apps" "$D/apps/com.ex.b/data.txt"
present "copies nexus" "$D/nexus/cache/catalog.json"
for e in aura context kv kv-migration.json kv-redis-backup.orig dev; do absent "excluded: $e" "$D/$e"; done
if grep -rqs FIXTURE_SECRET "$D"; then bad "no secret content in copy"; else ok "no secret content in copy"; fi
[ "$(readlink "$A/safe-link")" = index.txt ] && ok "safe symlink kept" || bad "safe symlink kept"
[ "$(cat "$A/safe-cross-root")" = app ] && ok "safe cross-root symlink resolves" || bad "safe cross-root symlink resolves"
for l in abs-escape abs-into-source rel-escape to-masterkey to-secrets-dir to-ssh to-kv chain-to-masterkey to-source-root dir-escape; do
  absent "unsafe symlink dropped: $l" "$A/$l"
done
absent "hardlink to masterkey dropped" "$D/apps/com.ex.b/hardlinked-masterkey"
present "safe hardlink kept" "$D/apps/com.ex.b/hardlink-safe"
[ "$(stat -c %i "$D/apps/com.ex.b/data.txt")" = "$(stat -c %i "$D/apps/com.ex.b/hardlink-safe")" ] \
  && ok "hardlink preserved" || bad "hardlink preserved"
absent "FIFO not copied" "$D/apps/com.ex.b/a-fifo"
if [ -z "$(find "$D" -type l -lname '/*' -print -quit)" ]; then ok "no absolute symlinks"; else bad "no absolute symlinks"; fi
[ "$BEFORE" = "$(snapshot "$SRC")" ] && ok "source unchanged" || bad "source unchanged"

# Include options
H="$T/homes"
expect_rc "apply with homes" 0 "$COPY" --source "$SRC" --dest "$H" --apply --include-homes
present "home work file copied" "$H/aura/home/default/work/notes.txt"
present "safe home symlink kept" "$H/aura/home/default/work/home-safe"
absent "home symlink to ssh dropped" "$H/aura/home/default/work/home-to-ssh"
for e in .ssh .docker .claude .claude.json .codex .config .gitconfig .bash_history .netrc .git-credentials work/nested/.ssh; do
  absent "home excluded: $e" "$H/aura/home/default/$e"
done
absent "other user's .ssh excluded" "$H/aura/home/master/.ssh"
if grep -rqs FIXTURE_SECRET "$H"; then bad "no secret content with homes"; else ok "no secret content with homes"; fi
K="$T/withkv"
expect_rc "apply with kv" 0 "$COPY" --source "$SRC" --dest "$K" --apply --include-kv
present "kv copied on request" "$K/kv/aura.rdb"
absent "masterkey never copied with kv" "$K/context/.masterkey"
absent "kv hardlink shape still blocks masterkey" "$K/apps/com.ex.b/hardlinked-masterkey"

# Symlinked roots must not be followed.
R="$T/rootlink"; mkdir -p "$R/real-secrets" "$R/apps/a"; echo FIXTURE_SECRET > "$R/real-secrets/s"; echo ok > "$R/apps/a/f"
ln -s real-secrets "$R/scopes"; ln -s /etc "$R/nexus"
find "$R" -exec touch -h -d '2020-01-01 00:00:00' {} +
expect_rc "symlinked roots handled" 0 "$COPY" --source "$R" --dest "$T/rootlink-out" --apply
absent "symlinked root skipped" "$T/rootlink-out/scopes"
absent "symlinked root to /etc skipped" "$T/rootlink-out/nexus"
present "real root still copied" "$T/rootlink-out/apps/a/f"
R2="$T/homelink"; mkdir -p "$R2/elsewhere/default" "$R2/aura"; echo FIXTURE_SECRET > "$R2/elsewhere/default/f"
ln -s ../elsewhere "$R2/aura/home"
find "$R2" -exec touch -h -d '2020-01-01 00:00:00' {} +
expect_rc "symlinked aura/home handled" 0 "$COPY" --source "$R2" --dest "$T/homelink-out" --apply --include-homes
absent "symlinked aura/home skipped" "$T/homelink-out/aura"

# Isolation preflight
: > "$STUB_LOG"
expect_rc "isolation: needs target" 2 "$CHECK" --live-id LIVE-ID
expect_rc "isolation: needs live reference" 2 "$CHECK" --docker-host tcp://t
expect_rc "isolation: rejects two targets" 2 "$CHECK" --docker-host tcp://t --context c --live-id L
expect_rc "isolation: clean separate daemon" 0 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_TARGET_ID=LIVE-ID expect_rc "isolation: same daemon by ID" 1 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
expect_rc "isolation: live host queried" 0 "$CHECK" --docker-host tcp://t --live-docker-host live://h
STUB_TARGET_ID=LIVE-ID expect_rc "isolation: same as live host" 1 "$CHECK" --docker-host tcp://t --live-docker-host live://h
STUB_UNREACHABLE=tcp://t expect_rc "isolation: unreachable target" 2 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_UNREACHABLE=live://h expect_rc "isolation: unreachable live host" 2 "$CHECK" --docker-host tcp://t --live-docker-host live://h
STUB_PS='aura-shell||||\n' expect_rc "isolation: existing aura-shell" 1 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_PS='renamed|os|inst|com.ex|\n' expect_rc "isolation: Aura labels" 1 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_VOLUMES='p_aura-app-data\n' expect_rc "isolation: existing data volume" 1 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_NETWORKS='aura-net\n' expect_rc "isolation: existing aura-net" 1 "$CHECK" --docker-host tcp://t --live-id LIVE-ID
STUB_PS='aura-shell||||\n' expect_rc "isolation: verified test instance allowed" 0 \
  "$CHECK" --docker-host tcp://t --live-id LIVE-ID --allow-test-instance TARGET-ID
STUB_PS='aura-shell||||\n' expect_rc "isolation: wrong allowed ID" 1 \
  "$CHECK" --docker-host tcp://t --live-id LIVE-ID --allow-test-instance OTHER
STUB_TARGET_ID=LIVE-ID expect_rc "isolation: allow flag cannot bless live daemon" 1 \
  "$CHECK" --docker-host tcp://t --live-id LIVE-ID --allow-test-instance LIVE-ID
DOCKER_HOST=tcp://ambient expect_rc "isolation: ignores ambient DOCKER_HOST" 0 "$CHECK" --context c --live-id LIVE-ID
if grep -qvE '^(info|ps -a|volume ls|network ls)( |$)' "$STUB_LOG"; then
  bad "isolation: read-only verbs only" "$(grep -vE '^(info|ps -a|volume ls|network ls)( |$)' "$STUB_LOG" | head -1)"
else ok "isolation: read-only verbs only"; fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
