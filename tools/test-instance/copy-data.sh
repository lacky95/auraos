#!/usr/bin/env bash
# copy-data.sh: build a sanitized AuraOS data copy for a separate test instance.
# Dry-run by default. Writes only with --apply. See README.md.
set -euo pipefail
export LC_ALL=C

usage() {
  cat <<'USAGE'
Usage: copy-data.sh --source DIR --dest DIR [options]

  --source DIR                 AuraOS data directory or snapshot (required)
  --dest DIR                   New or empty destination (required)
  --apply                      Copy. Without this, nothing is written.
  --confirm-stopped-snapshot   Operator confirms the source is a stopped
                               instance or a point-in-time snapshot. Overrides
                               heuristic checks only, never an observed
                               running Valkey or container on the source.
  --include-kv                 Also copy kv/. The master key is never copied,
                               so sealed Context values stay undecryptable.
  --include-homes              Also copy aura/home/*, minus credential paths.
  -h, --help                   Show this help.

Exit codes: 0 success, 1 refused or failed, 2 usage error.
USAGE
}

die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
usage_err() { printf 'error: %s\n' "$*" >&2; usage >&2; exit 2; }

SRC_ARG="" DEST_ARG="" APPLY=0 CONFIRMED=0 INCLUDE_KV=0 INCLUDE_HOMES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --source) [ $# -ge 2 ] || usage_err "--source needs a value"; SRC_ARG=$2; shift 2 ;;
    --dest) [ $# -ge 2 ] || usage_err "--dest needs a value"; DEST_ARG=$2; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --confirm-stopped-snapshot) CONFIRMED=1; shift ;;
    --include-kv) INCLUDE_KV=1; shift ;;
    --include-homes) INCLUDE_HOMES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_err "unknown argument: $1" ;;
  esac
done
[ -n "$SRC_ARG" ] || usage_err "--source is required"
[ -n "$DEST_ARG" ] || usage_err "--dest is required"
for tool in find tar realpath readlink timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done

# True when path $1 equals or is below directory $2.
under() {
  [ "$2" = / ] && return 0
  [[ $1 == "$2" || $1 == "$2"/* ]]
}

[ -d "$SRC_ARG" ] || die "source is not a directory: $SRC_ARG"
SRC=$(realpath -e -- "$SRC_ARG")
DEST=$(realpath -m -- "$DEST_ARG")

[ "$SRC" != / ] || die "source must not be /"
[ "$DEST" != / ] || die "dest must not be /"
for protected in /data /workspace; do
  if under "$DEST" "$protected"; then die "dest must not be $protected or inside it: $DEST"; fi
done
if under "$DEST" "$SRC"; then die "dest is inside source (or equal): $DEST"; fi
if under "$SRC" "$DEST"; then die "source is inside dest: $SRC"; fi
if [ -e "$DEST" ]; then
  [ -d "$DEST" ] || die "dest exists and is not a directory: $DEST"
  if [ -n "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    die "dest is not empty: $DEST"
  fi
fi

# Exclusions. Copying is allowlist-based (ROOTS), so anything else at the top
# level is left behind too. This list also vets symlink targets and hardlinks.
EXCLUDED=(aura/secrets context/.masterkey kv-redis-backup.orig kv-migration.json
  aura/runtime aura/mounts aura/warm-pool.json aura/boot aura/update)
[ "$INCLUDE_KV" = 1 ] || EXCLUDED+=(kv)
# Matched at any depth inside aura/home/<user>/.
HOME_DENY=(.ssh .docker '.claude*' .codex .config .gitconfig .bash_history
  '.*_history' .netrc .git-credentials .gnupg .aws .kube .azure .gemini
  .npmrc .pypirc .pgpass)

is_excluded() {
  local rel=$1 item rest comp pat
  for item in "${EXCLUDED[@]}"; do
    if [[ $rel == "$item" || $rel == "$item"/* ]]; then return 0; fi
  done
  if [[ $rel == aura/home/*/* ]]; then
    rest=${rel#aura/home/}; rest=${rest#*/}
    while [ -n "$rest" ]; do
      comp=${rest%%/*}
      for pat in "${HOME_DENY[@]}"; do
        # shellcheck disable=SC2254  # pat is intentionally a glob
        case "$comp" in $pat) return 0 ;; esac
      done
      if [[ $rest == */* ]]; then rest=${rest#*/}; else rest=""; fi
    done
  fi
  return 1
}

ROOTS=()
SKIPPED_ROOTS=()
add_root() {
  local r=$1 check=$1
  while :; do
    if [ -L "$SRC/$check" ]; then SKIPPED_ROOTS+=("$r"); return 0; fi
    [[ $check == */* ]] || break
    check=${check%/*}
  done
  if [ -d "$SRC/$r" ]; then ROOTS+=("$r"); fi
}
for r in scopes apps nexus; do add_root "$r"; done
[ "$INCLUDE_KV" = 0 ] || add_root kv
[ "$INCLUDE_HOMES" = 0 ] || add_root aura/home

in_roots() {
  local r
  for r in ${ROOTS[@]+"${ROOTS[@]}"}; do
    if [[ $1 == "$r" || $1 == "$r"/* ]]; then return 0; fi
  done
  return 1
}
is_copied() { in_roots "$1" && ! is_excluded "$1"; }

# Walk ROOTS from inside SRC, pruning denied home paths. Args: find actions.
HOME_NAMES=()
for pat in "${HOME_DENY[@]}"; do
  [ ${#HOME_NAMES[@]} -eq 0 ] || HOME_NAMES+=(-o)
  HOME_NAMES+=(-name "$pat")
done
walk() {
  [ ${#ROOTS[@]} -gt 0 ] || return 0
  (cd "$SRC" && find "${ROOTS[@]}" \( -path 'aura/home/*/*' \( "${HOME_NAMES[@]}" \) \) -prune -o "$@")
}

# Read one NUL-terminated command result exactly, including any newlines.
read_z() { local __var=$1; shift; IFS= read -r -d '' "$__var" < <("$@"); }

# Symlinks: keep only relative links whose lexical and physical targets stay
# inside copied, non-excluded data.
KEPT_LINKS=()
DROPPED_LINKS=()
link_ok() {
  local rel=$1 target physical lexical parent
  read_z target readlink -z -- "$SRC/$rel" || return 1
  [[ $target != /* && $target != *$'\n'* && -n $target ]] || return 1
  read_z physical realpath -mz -- "$SRC/$rel" || return 1
  parent=${rel%/*}; parent=$SRC/$parent
  read_z lexical realpath -msz -- "$parent/$target" || return 1
  [[ $physical != *$'\n'* && $lexical != *$'\n'* ]] || return 1
  under "$physical" "$SRC" && under "$lexical" "$SRC" || return 1
  [ "$physical" != "$SRC" ] && [ "$lexical" != "$SRC" ] || return 1
  is_copied "${physical#"$SRC"/}" && is_copied "${lexical#"$SRC"/}"
}
while IFS= read -r -d '' rel; do
  if link_ok "$rel"; then KEPT_LINKS+=("$rel"); else DROPPED_LINKS+=("$rel"); fi
done < <(walk -type l -print0)

# Hardlinks: a copied name must not share an inode with an excluded file.
declare -A BAD_INODES=()
HL_CANDIDATES=()
HL_INODES=()
while IFS= read -r -d '' rec; do
  inode=${rec%% *}; rel=${rec#* }; rel=${rel#./}
  if is_copied "$rel"; then HL_CANDIDATES+=("$rel"); HL_INODES+=("$inode")
  elif is_excluded "$rel"; then BAD_INODES[$inode]=1
  fi
done < <(cd "$SRC" && find . -type f -links +1 -printf '%D:%i %p\0')
KEPT_HARD=()
DROPPED_HARD=()
for i in "${!HL_CANDIDATES[@]}"; do
  if [ -n "${BAD_INODES[${HL_INODES[$i]}]:-}" ]; then DROPPED_HARD+=("${HL_CANDIDATES[$i]}")
  else KEPT_HARD+=("${HL_CANDIDATES[$i]}"); fi
done

emit_manifest() {
  walk \( -type d -o -type f -links 1 \) -print0
  [ ${#KEPT_LINKS[@]} -eq 0 ] || printf '%s\0' "${KEPT_LINKS[@]}"
  [ ${#KEPT_HARD[@]} -eq 0 ] || printf '%s\0' "${KEPT_HARD[@]}"
}

# Liveness. HARD means a process or container is observed on this data and no
# flag overrides it. SOFT is a heuristic the operator can override.
LIVE_HARD=()
LIVE_SOFT=()
detect_live() {
  local p comm state cwd ids line msource mdest name live_path
  for p in /proc/[0-9]*; do
    comm=$(cat "$p/comm" 2>/dev/null) || continue
    case "$comm" in
      valkey-server|redis-server)
        # A zombie has exited and holds no data, and its cwd is unreadable.
        state=$(sed 's/.*) //' "$p/stat" 2>/dev/null | cut -d' ' -f1)
        [ "$state" != Z ] || continue
        cwd=$(readlink "$p/cwd" 2>/dev/null || true)
        if [ -z "$cwd" ]; then
          LIVE_SOFT+=("cannot inspect $comm (pid ${p#/proc/})")
        elif under "$cwd" "$SRC"; then
          LIVE_HARD+=("$comm (pid ${p#/proc/}) is running in $cwd")
        fi ;;
    esac
  done

  if command -v docker >/dev/null 2>&1 && ids=$(timeout 10 docker ps -q 2>/dev/null); then
    if [ -n "$ids" ]; then
      # shellcheck disable=SC2086  # ids is a whitespace-separated list
      while IFS=$'\t' read -r name msource mdest; do
        [ -n "${msource:-}" ] || continue
        msource=$(realpath -m -- "$msource")
        if [ "$msource" != / ] && { under "$msource" "$SRC" || { [ "$mdest" = /data ] && under "$SRC" "$msource"; }; }; then
          LIVE_HARD+=("running container ${name#/} mounts $msource at $mdest")
        fi
      done < <(timeout 20 docker inspect --format '{{$n := .Name}}{{range .Mounts}}{{$n}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{"\n"}}{{end}}' $ids 2>/dev/null || true)
    fi
  elif [ -d "$SRC/kv" ]; then
    LIVE_SOFT+=("could not query Docker to rule out a running instance on this data")
  fi

  name=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || true)
  if [ "$name" = aura-shell ]; then
    # The test variable can only add a path that is treated as live.
    for live_path in /data ${AURA_COPY_TEST_LIVE_DATA_PATH:+"$AURA_COPY_TEST_LIVE_DATA_PATH"}; do
      if [ "$SRC" = "$(realpath -m -- "$live_path")" ]; then
        LIVE_SOFT+=("running inside aura-shell against its live data directory")
      fi
    done
  fi
  if [ -n "${AURA_DATA_DIR:-}" ] && [ "$SRC" = "$(realpath -m -- "$AURA_DATA_DIR")" ]; then
    LIVE_SOFT+=("source equals this process's AURA_DATA_DIR")
  fi
  if [ -d "$SRC/kv" ] && [ -n "$(find "$SRC/kv" -type f -mmin -10 -print -quit 2>/dev/null)" ]; then
    LIVE_SOFT+=("kv/ was written within the last 10 minutes")
  fi
}
detect_live

print_summary() {
  local item entry shown=0 count=0
  echo "Source: $SRC"
  echo "Dest:   $DEST"
  echo "Copy roots: ${ROOTS[*]:-(none)}"
  for item in ${SKIPPED_ROOTS[@]+"${SKIPPED_ROOTS[@]}"}; do echo "  skipped root (symlink): $item"; done
  echo "Entries to copy: $(emit_manifest | tr -cd '\0' | wc -c)"
  echo
  echo "Excluded paths present (names only):"
  for item in "${EXCLUDED[@]}"; do
    if [ -e "$SRC/$item" ] || [ -L "$SRC/$item" ]; then echo "  $item"; fi
  done
  if [ -d "$SRC/aura/home" ] && [ ! -L "$SRC/aura/home" ]; then
    if [ "$INCLUDE_HOMES" = 1 ]; then
      while IFS= read -r -d '' entry; do printf '  %q\n' "$entry"; done < <(
        cd "$SRC" && find aura/home -path 'aura/home/*/*' \( "${HOME_NAMES[@]}" \) -prune -print0)
    else
      echo "  aura/home (not requested)"
    fi
  fi
  echo "Other paths not in the copy allowlist:"
  for entry in "$SRC"/* "$SRC"/.[!.]* "$SRC"/aura/* "$SRC"/aura/.[!.]*; do
    { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
    item=${entry#"$SRC"/}
    [ "$item" != aura ] || continue
    if is_excluded "$item" || in_roots "$item"; then continue; fi
    [ "$item" != aura/home ] || continue
    printf '  %q\n' "$item"
  done
  echo "Symlinks kept: ${#KEPT_LINKS[@]}, dropped as unsafe: ${#DROPPED_LINKS[@]}"
  for item in ${DROPPED_LINKS[@]+"${DROPPED_LINKS[@]}"}; do printf '  dropped symlink: %q\n' "$item"; done
  for item in ${DROPPED_HARD[@]+"${DROPPED_HARD[@]}"}; do printf '  dropped hardlink to excluded file: %q\n' "$item"; done
  echo
  echo "WARNING: scopes/, apps/, and nexus/ may embed tokens in app data, caches, or logs."
  while IFS= read -r -d '' entry; do
    count=$((count + 1))
    if [ "$shown" -lt 10 ]; then printf '  review: %q\n' "$entry"; shown=$((shown + 1)); fi
  done < <(walk -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \
    -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -iname '*credential*' -o -iname '*token*' -o -iname '*secret*' \) -print0)
  echo "Files with credential-like names in the copy set: $count"
  echo "NOTE: context/.masterkey is never copied, so Context secrets are not usable in the copy."
  if [ "$INCLUDE_KV" = 1 ]; then
    echo "NOTE: kv/ is included without its master key. Sealed values cannot be decrypted."
  else
    echo "NOTE: kv/ and the master key are a pair. Both are excluded, so Context secrets are not copied."
  fi
  for item in ${LIVE_HARD[@]+"${LIVE_HARD[@]}"}; do echo "LIVE: $item"; done
  for item in ${LIVE_SOFT[@]+"${LIVE_SOFT[@]}"}; do echo "POSSIBLY LIVE: $item"; done
}

print_summary

if [ "$APPLY" != 1 ]; then
  echo
  echo "Dry run: nothing was written. Re-run with --apply to copy."
  exit 0
fi

if [ ${#LIVE_HARD[@]} -gt 0 ]; then
  die "source is in use by a running instance. Stop it or use a snapshot."
fi
if [ ${#LIVE_SOFT[@]} -gt 0 ] && [ "$CONFIRMED" != 1 ]; then
  die "source may be live. If it is a stopped instance or snapshot, pass --confirm-stopped-snapshot."
fi

mkdir -p -- "$DEST"
# Keep the destination private while it is populated and afterwards.
chmod 700 -- "$DEST"
emit_manifest | tar -C "$SRC" --null --no-recursion -T - -cf - | tar -C "$DEST" -xpf -

# Independent post-copy verification of what actually landed.
bad=0
while IFS= read -r -d '' rel; do
  rel=${rel#./}
  if is_excluded "$rel"; then printf 'VERIFY FAILED: excluded path in dest: %q\n' "$rel" >&2; bad=1; fi
  if [ -L "$DEST/$rel" ]; then
    t="" resolved=""
    read_z t readlink -z -- "$DEST/$rel" || true
    read_z resolved realpath -mz -- "$DEST/$rel" || true
    if [[ -z $t || -z $resolved || $t == /* ]] || ! under "$resolved" "$DEST"; then
      printf 'VERIFY FAILED: escaping symlink in dest: %q\n' "$rel" >&2; bad=1
    fi
  fi
done < <(cd "$DEST" && find . -mindepth 1 -print0)
[ "$bad" = 0 ] || { echo "Copy failed verification. Inspect or delete: $DEST" >&2; exit 1; }

echo
echo "Copied and verified: $DEST"
