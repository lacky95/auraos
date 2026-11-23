#!/usr/bin/env bash
# check-isolation.sh: read-only preflight for an AuraOS test-instance daemon.
# Runs only `docker info`, `ps`, `volume ls`, and `network ls`.
set -euo pipefail
export LC_ALL=C

usage() {
  cat <<'USAGE'
Usage: check-isolation.sh (--docker-host URL | --context NAME)
                          (--live-id ID | --live-docker-host URL)
                          [--allow-test-instance TARGET_ID]

  --docker-host URL         Target daemon, for example ssh://user@test-vm
  --context NAME            Target daemon as a Docker context
  --live-id ID              Daemon ID of the live AuraOS host
  --live-docker-host URL    Query the live daemon for its ID
  --allow-test-instance ID  Accept existing Aura resources only on this exact,
                            previously verified target daemon ID

Exit codes: 0 isolated, 1 refused, 2 usage error or could not verify.
USAGE
}

usage_err() { printf 'error: %s\n' "$*" >&2; usage >&2; exit 2; }
unverified() { printf 'UNVERIFIED: %s\n' "$*" >&2; exit 2; }
refuse() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

TARGET_HOST="" TARGET_CONTEXT="" LIVE_ID="" LIVE_HOST="" ALLOW_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --docker-host|--context|--live-id|--live-docker-host|--allow-test-instance)
      [ $# -ge 2 ] && [ -n "$2" ] || usage_err "$1 needs a value"
      case "$1" in
        --docker-host) TARGET_HOST=$2 ;;
        --context) TARGET_CONTEXT=$2 ;;
        --live-id) LIVE_ID=$2 ;;
        --live-docker-host) LIVE_HOST=$2 ;;
        --allow-test-instance) ALLOW_ID=$2 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage_err "unknown argument: $1" ;;
  esac
done
if { [ -n "$TARGET_HOST" ] && [ -n "$TARGET_CONTEXT" ]; } || { [ -z "$TARGET_HOST" ] && [ -z "$TARGET_CONTEXT" ]; }; then
  usage_err "give exactly one of --docker-host or --context"
fi
if { [ -n "$LIVE_ID" ] && [ -n "$LIVE_HOST" ]; } || { [ -z "$LIVE_ID" ] && [ -z "$LIVE_HOST" ]; }; then
  usage_err "give exactly one of --live-id or --live-docker-host"
fi
command -v docker >/dev/null 2>&1 || unverified "docker CLI not found"
command -v timeout >/dev/null 2>&1 || unverified "timeout not found"

# The ambient environment must not choose the daemon.
target() {
  if [ -n "$TARGET_HOST" ]; then
    timeout 20 env -u DOCKER_HOST -u DOCKER_CONTEXT docker -H "$TARGET_HOST" "$@"
  else
    timeout 20 env -u DOCKER_HOST -u DOCKER_CONTEXT docker --context "$TARGET_CONTEXT" "$@"
  fi
}

TARGET_ID=$(target info --format '{{.ID}}' 2>/dev/null) || unverified "cannot reach the target daemon"
[ -n "$TARGET_ID" ] || unverified "target daemon reported no ID"
if [ -n "$LIVE_HOST" ]; then
  LIVE_ID=$(timeout 20 env -u DOCKER_HOST -u DOCKER_CONTEXT docker -H "$LIVE_HOST" info --format '{{.ID}}' 2>/dev/null) \
    || unverified "cannot reach the live daemon to read its ID"
  [ -n "$LIVE_ID" ] || unverified "live daemon reported no ID"
fi

echo "Target daemon ID: $TARGET_ID"
echo "Live daemon ID:   $LIVE_ID"
[ "$TARGET_ID" != "$LIVE_ID" ] || refuse "target is the live AuraOS Docker daemon"

if [ -n "$ALLOW_ID" ] && [ "$ALLOW_ID" != "$TARGET_ID" ]; then
  refuse "target ID does not match --allow-test-instance"
fi

FOUND=()
ps_all=$(target ps -a --format '{{.Names}}|{{.Label "aura.managed"}}|{{.Label "aura.parent"}}|{{.Label "aura.app"}}|{{.Label "aura.port"}}') \
  || unverified "cannot list containers on the target"
while IFS='|' read -r name managed parent app port; do
  [ -n "${name:-}" ] || continue
  if [ "$name" = aura-shell ] || [[ $name == aura-* ]] || [ -n "$managed$parent$app$port" ]; then
    FOUND+=("container $name")
  fi
done <<< "$ps_all"

vols=$(target volume ls --format '{{.Name}}') || unverified "cannot list volumes on the target"
while IFS= read -r v; do
  case "$v" in *aura-app-data|*aura-node-modules) FOUND+=("volume $v") ;; esac
done <<< "$vols"

nets=$(target network ls --format '{{.Name}}') || unverified "cannot list networks on the target"
while IFS= read -r n; do
  [ "$n" != aura-net ] || FOUND+=("network $n")
done <<< "$nets"

if [ ${#FOUND[@]} -gt 0 ]; then
  printf 'Existing AuraOS resources on target:\n'
  printf '  %s\n' "${FOUND[@]}"
  if [ -z "$ALLOW_ID" ]; then
    refuse "target already has AuraOS resources. Treat it as live unless you recorded its ID as the test daemon before first boot."
  fi
  echo "Accepted as the verified test instance by exact daemon ID."
fi

echo "OK: target is a different Docker daemon."
