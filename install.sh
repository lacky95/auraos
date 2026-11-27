#!/bin/sh
# AuraOS installer (Phase 6 stream I, with D94 IC-2; owner answer b).
#
#   sh install.sh [options]          unattended when stdin is not a terminal, or with --yes
#
# Installs AuraOS from a verified Git release. It orchestrates the existing
# mechanisms and holds no build, patch or config logic of its own: the D94
# config is validated and rendered by os/infra/*, releases are verified by
# os/release-verify.mjs (D71), and Normal Mode builds through the release
# builder (os/release/builder.mjs, stream B), which runs in its own small
# runner image (os/release/runner/Dockerfile): the host needs only Docker + Compose. Every helper runs from THIS installer's copy, never from
# the release it is about to install: nothing from a candidate runs before it
# verified.
#
# Order: preflight → config staged (proxy, CA, registries, DNS, mTLS) → source
# fetched through that config → release selected and verified → build → start.
# Nothing is downloaded or built before the config is applied (the only
# exception is the Docker daemon's own pull of the Node base image, which uses
# the daemon's operator-owned proxy/mirror settings, D94 §6.5).
#
# Options:
#   --config FILE            D94 infrastructure config (YAML). None = today's behaviour.
#   --credentials-dir DIR    bootstrap credential files (bootstrap:<name> = DIR/<name>, mode 0600)
#   --state-dir DIR          installer state on the host (default /etc/auraos; outside any checkout)
#   --dir DIR                where the Developer layout's checkout goes (default /opt/auraos)
#   --source URL             the AuraOS Git repository (default https://github.com/lacky95/auraos.git)
#   --channel signed|main    signed (default): signed release tags only; main: the unsigned development head (owner opt-in)
#   --maturity alpha|beta|stable   the lowest release maturity to install (default alpha for now: the newest
#                            signed release of any maturity; it rises once beta/stable releases exist; every
#                            maturity is signed, owner Phase 8 decision 5)
#   --ref REF                a specific release tag (signed) or ref/commit (main)
#   --trusted-key FILE|ID    pin the release key (a public key file or a key id/fingerprint); repeatable
#   --accept-shipped-key     trust the key(s) shipped with this installer without asking (unattended)
#   --developer              the Developer layout (a git checkout at --dir, today's compose layout)
#   --check-only             run the preflight and stop (no writes)
#   --print-requirements     list what a restricted network must mirror, then stop
#   --keep-bootstrap-credentials   keep <state-dir>/credentials after the install (D94 O3)
#   --node-image IMAGE       the Node image the helpers run in when the host has no node >= 20
#   --yes, --unattended      never ask; refuse instead of prompting
#   --patches DIR            refused: install-time patches arrive with Phase 7 (D68)
#
# Exit codes: 0 ok · 1 install failed · 2 preflight failed · 3 refused (verification, policy) · 64 usage.
set -eu
umask 022

INSTALLER_ROOT=$(cd "$(dirname "$0")" && pwd -P)
HELPER="$INSTALLER_ROOT/os/install/installer.mjs"
BUILDER="$INSTALLER_ROOT/os/release/builder.mjs"
STATE_DIR=/etc/auraos
DIR=/opt/auraos
SOURCE=https://github.com/lacky95/auraos.git
CHANNEL=signed
MATURITY=alpha
REF=
MODE=normal
CONFIG=
CRED_DIR=
CHECK_ONLY=0
PRINT_REQ=0
UNATTENDED=0
KEEP_CREDS=0
ACCEPT_SHIPPED=0
TRUSTED_KEYS=
NODE_IMAGE=${AURA_INSTALL_NODE_IMAGE:-node:22.23.5-bookworm}
MIN_DOCKER=26.0.0      # volume-subpath mounts (sibling containers)
MIN_COMPOSE=2.24.4     # !reset / !override in the rendered override
MIN_DISK_GB=${AURA_INSTALL_MIN_DISK_GB:-15}
READY_TIMEOUT=${AURA_INSTALL_READY_TIMEOUT:-2400}

usage() { sed -n '2,/^set -eu/p' "$0" | sed -n '/^# Options:/,/^# Exit/p' | sed 's/^# \{0,1\}//' >&2; exit 64; }
die() { code=$1; shift; say "ERROR: $*"; exit "$code"; }

while [ $# -gt 0 ]; do
  case $1 in
    --config) CONFIG=${2:?}; shift ;;
    --credentials-dir) CRED_DIR=${2:?}; shift ;;
    --state-dir) STATE_DIR=${2:?}; shift ;;
    --dir) DIR=${2:?}; shift ;;
    --source) SOURCE=${2:?}; shift ;;
    --channel) CHANNEL=${2:?}; shift ;;
    --ref) REF=${2:?}; shift ;;
    --maturity) MATURITY=${2:?}; shift ;;
    --trusted-key) TRUSTED_KEYS="$TRUSTED_KEYS ${2:?}"; shift ;;
    --accept-shipped-key) ACCEPT_SHIPPED=1 ;;
    --developer) MODE=developer ;;
    --check-only) CHECK_ONLY=1 ;;
    --print-requirements) PRINT_REQ=1 ;;
    --keep-bootstrap-credentials) KEEP_CREDS=1 ;;
    --node-image) NODE_IMAGE=${2:?}; shift ;;
    --yes|--unattended) UNATTENDED=1 ;;
    --patches) echo "install.sh: --patches: install-time system patches arrive with Phase 7 (D68). --config works today." >&2; exit 64 ;;
    -h|--help) usage ;;
    *) echo "install.sh: unknown option $1" >&2; usage ;;
  esac
  shift
done
[ -t 0 ] || UNATTENDED=1
case $CHANNEL in signed|main) ;; *) echo "install.sh: --channel must be signed or main" >&2; exit 64 ;; esac
case $MATURITY in alpha|beta|stable) ;; *) echo "install.sh: --maturity must be alpha, beta or stable" >&2; exit 64 ;; esac

# ── output: everything also goes to a log, redacted ─────────────────────────
TMP=$(mktemp -d "${TMPDIR:-/tmp}/auraos-install.XXXXXX")
chmod 700 "$TMP"
LOG="$TMP/install.log"
: > "$LOG"
TS=$(date -u +%Y%m%dT%H%M%SZ)
cleanup() {
  rc=$?
  # Per-build secret material never outlives the run (D94 §6.3).
  rm -rf "$TMP/net" "$STATE_DIR/rendered/secrets" "$STATE_DIR/compose.secrets.yml" 2>/dev/null || true
  if [ "$CHECK_ONLY" = 0 ] && [ "$PRINT_REQ" = 0 ] && [ -d "$STATE_DIR" ] && [ -w "$STATE_DIR" ]; then
    mkdir -p "$STATE_DIR/logs" && chmod 700 "$STATE_DIR/logs" && cp "$LOG" "$STATE_DIR/logs/install-$TS.log" 2>/dev/null \
      && chmod 600 "$STATE_DIR/logs/install-$TS.log" && echo "log: $STATE_DIR/logs/install-$TS.log"
  fi
  rm -rf "$TMP"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The generic redactor (URL userinfo, Authorization headers, npm auth, PEM keys).
# No secret is ever passed on a command line here, so this is a second line of defence.
redact() {
  sed -e 's#\([A-Za-z][A-Za-z0-9+.-]*://\)[^/@[:space:]:]*:[^/@[:space:]]*@#\1***@#g' \
      -e 's#\([Pp]roxy-[Aa]uthorization:[[:space:]]*\)[^[:space:]].*#\1***#' \
      -e 's#\([Aa]uthorization:[[:space:]]*\)[^[:space:]].*#\1***#' \
      -e 's#\(_auth[A-Za-z]*[[:space:]]*=[[:space:]]*\)[^[:space:]]*#\1***#' \
      -e '/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/-----END [A-Z ]*PRIVATE KEY-----/c\
[private key redacted]'
}
say() { printf '%s\n' "$*" | redact | tee -a "$LOG"; }
# Runs a command; output (redacted) to the log only; returns its status.
logged() { { "$@" 2>&1; echo $? > "$TMP/.rc"; } | redact >> "$LOG"; return "$(cat "$TMP/.rc")"; }

FAILS=0
ok() { say "  ok    $*"; }
warn() { say "  warn  $*"; }
# check_fail CATEGORY ENDPOINT FIX: what failed, where, and what to do.
check_fail() { FAILS=$((FAILS + 1)); say "  FAIL  [$1] $2"; say "        fix: $3"; }

ver_ge() { awk -v a="${1#v}" -v b="$2" 'BEGIN { split(a, x, /[.+~-]/); split(b, y, /[.+~-]/); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; }

for p in "$STATE_DIR" "$DIR" "$CONFIG" "$CRED_DIR" "$INSTALLER_ROOT"; do
  case $p in *[[:space:]]*) die 64 "paths with whitespace are not supported: '$p'" ;; esac
done
abspath() { case $1 in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$(pwd -P)" "$1" ;; esac; }
[ -n "$CONFIG" ] && CONFIG=$(abspath "$CONFIG")
[ -n "$CRED_DIR" ] && CRED_DIR=$(abspath "$CRED_DIR")
STATE_DIR=$(abspath "$STATE_DIR")
DIR=$(abspath "$DIR")

# ── the helper runtime: host node >= 20, else a --network none node container ─
NODE_MODE=
HMOUNTS="-v $INSTALLER_ROOT:$INSTALLER_ROOT:ro"
hmount() { case " $HMOUNTS " in *" -v $1:$1"*) ;; *) HMOUNTS="$HMOUNTS -v $1:$1${2:+:$2}" ;; esac; }
helper() {
  if [ "$NODE_MODE" = host ]; then
    node "$HELPER" "$@"
  else
    # shellcheck disable=SC2086
    docker run --rm -i --network none --user "$(id -u):$(id -g)" -e HOME=/tmp $HMOUNTS "$NODE_IMAGE" node "$HELPER" "$@"
  fi
}

# Docker pull diagnosis (D94 §6.5): the daemon's own trust, proxy and login are operator-owned.
pull_diagnosis() {
  case $(cat "$1") in
    *x509*|*certificate*) echo "the Docker daemon does not trust the registry's CA: add it to /etc/docker/certs.d/<registry>/ca.crt on the host" ;;
    *unauthorized*|*authentication*|*denied*) echo "the registry refused the daemon: docker login <registry> on the host, or mirror the image" ;;
    *timeout*|*"i/o timeout"*|*"no such host"*|*"connection refused"*) echo "the daemon cannot reach the registry: configure its proxy (systemd drop-in) or registry-mirrors in /etc/docker/daemon.json" ;;
    *) echo "see the daemon's message in the log; mirror the image and set registries.oci.mirrors or the daemon's registry-mirrors" ;;
  esac
}

# ── 1. preflight ─────────────────────────────────────────────────────────────
preflight() {
  say "AuraOS installer: preflight"
  for t in docker git curl tar; do
    if command -v "$t" >/dev/null 2>&1; then ok "$t found"; else check_fail tools "$t" "install $t with the host's package manager"; fi
  done
  command -v docker >/dev/null 2>&1 || return 0
  if ! docker info >"$TMP/dinfo" 2>&1; then
    case $(cat "$TMP/dinfo") in
      *"permission denied"*) check_fail docker "the Docker socket" "run as root, or add this user to the docker group" ;;
      *) check_fail docker "the Docker daemon" "start Docker (systemctl start docker) and check DOCKER_HOST" ;;
    esac
    return 0
  fi
  ok "Docker daemon reachable"
  v=$(docker version -f '{{.Server.Version}}' 2>/dev/null || echo 0)
  if ver_ge "$v" "$MIN_DOCKER"; then ok "Docker Engine $v"; else check_fail docker "Docker Engine $v" "upgrade to Docker Engine >= $MIN_DOCKER (volume-subpath mounts)"; fi
  v=$(docker compose version --short 2>/dev/null || echo 0)
  if ver_ge "$v" "$MIN_COMPOSE"; then ok "Docker Compose $v"; else check_fail docker "Docker Compose $v" "install the compose plugin >= $MIN_COMPOSE"; fi
  if docker buildx version >/dev/null 2>&1; then ok "buildx (BuildKit)"; else check_fail docker "buildx" "install the buildx plugin: BuildKit secret mounts keep credentials out of image layers"; fi
  root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  if [ -n "$root" ] && avail=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 {print $4}') && [ -n "$avail" ]; then
    if [ "$avail" -ge $((MIN_DISK_GB * 1024 * 1024)) ]; then ok "disk: $((avail / 1024 / 1024)) GB free for Docker"
    else check_fail disk "$root" "free at least $MIN_DISK_GB GB for the images and the first build"; fi
  else
    warn "disk: could not read the free space of Docker's root dir (remote daemon?)"
  fi
  for d in "$STATE_DIR" "$DIR"; do
    p=$d; while [ ! -d "$p" ]; do p=$(dirname "$p"); done
    if [ -w "$p" ]; then ok "writable: $d"; else check_fail permissions "$d" "run as root, or choose --state-dir/--dir under a writable path"; fi
  done

  # The helper runtime (validation, verification) before anything uses it.
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
    NODE_MODE=host; ok "helper runtime: host node $(node -v)"
  else
    NODE_MODE=docker
    if docker image inspect "$NODE_IMAGE" >/dev/null 2>&1 || logged docker pull "$NODE_IMAGE"; then
      ok "helper runtime: $NODE_IMAGE (no network)"
    else
      tail -5 "$LOG" > "$TMP/pull"
      check_fail registry "docker pull $NODE_IMAGE" "$(pull_diagnosis "$TMP/pull"); or install node >= 20 on the host"
      return 0
    fi
  fi
  if [ "$NODE_MODE" = host ] && ! docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
    # The daemon pull check (D94 §6.5) with the base image the build needs anyway.
    if logged docker pull "$NODE_IMAGE"; then ok "Docker daemon pulls $NODE_IMAGE"
    else tail -5 "$LOG" > "$TMP/pull"; check_fail registry "docker pull $NODE_IMAGE" "$(pull_diagnosis "$TMP/pull")"; fi
  fi

  if [ -n "$CONFIG" ]; then
    hmount "$(dirname "$CONFIG")" ro
    [ -n "$CRED_DIR" ] && hmount "$CRED_DIR" ro
    if helper validate --config "$CONFIG" ${CRED_DIR:+--credentials-dir "$CRED_DIR"} >"$TMP/validate" 2>&1; then
      redact < "$TMP/validate" | sed 's/^/        /' | tee -a "$LOG"
      ok "infrastructure config valid"
    else
      redact < "$TMP/validate" | sed 's/^/        /' | tee -a "$LOG"
      check_fail config "$CONFIG" "fix the config or the credential files (see above); nothing was downloaded"
      return 0
    fi
    mkdir -p "$TMP/net"; chmod 700 "$TMP/net"; hmount "$TMP/net"
    helper net-config --config "$CONFIG" ${CRED_DIR:+--credentials-dir "$CRED_DIR"} --out "$TMP/net" >>"$LOG" 2>&1 \
      || { check_fail config "$CONFIG" "the network config could not be rendered (see the log)"; return 0; }
    helper endpoints --config "$CONFIG" > "$TMP/endpoints" 2>>"$LOG" || true
    while IFS="$(printf '\t')" read -r kind url cert; do
      [ -n "$url" ] || continue
      [ "$kind" = proxy ] && continue    # the proxy is exercised by every check through it
      host=$(printf '%s' "$url" | sed -e 's#^[a-z]*://##' -e 's#[/:].*##')
      if command -v getent >/dev/null 2>&1 && ! getent hosts "$host" >/dev/null 2>&1 && ! grep -q '^proxy' "$TMP/net/curlrc"; then
        check_fail dns "$host" "make $host resolvable on the host (corporate DNS), or set network.dns"; continue
      fi
      probe "$kind" "$url" "$cert"
    done < "$TMP/endpoints"
  fi
  # The Git source, through the configured proxy, CA and credentials.
  if git_net ls-remote --exit-code "$SOURCE" refs/heads/main >/dev/null 2>"$TMP/git"; then ok "git source reachable: $SOURCE"
  else check_fail "$(git_category "$TMP/git")" "$SOURCE" "$(git_fix "$TMP/git")"; fi
  if [ -n "$CONFIG" ]; then
    if helper audit-public --repo "$INSTALLER_ROOT" --config "$CONFIG" >"$TMP/audit" 2>&1; then ok "no public build inputs under publicFallback: deny (or allow)"
    else redact < "$TMP/audit" | tee -a "$LOG"; check_fail policy "public build inputs" "add mirrors for them, or set policy.publicFallback: allow"; fi
  fi
}

# git with the per-operation network config (never the operator's own global config).
git_net() {
  if [ -f "$TMP/net/gitconfig" ]; then
    GIT_CONFIG_GLOBAL="$TMP/net/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}
git_category() {
  case $(cat "$1") in
    *"resolve host"*|*"resolve proxy"*) echo dns ;;
    *"SSL certificate"*|*"certificate verify"*|*"self-signed"*|*"self signed"*) echo tls ;;
    *407*) echo proxy-auth ;;
    *"certificate required"*|*"alert"*|*"handshake failure"*) echo mtls ;;
    *401*|*403*|*"Authentication failed"*|*"could not read Username"*) echo credentials ;;
    *"timed out"*|*"Connection refused"*|*"Failed to connect"*) echo network ;;
    *) echo git ;;
  esac
}
git_fix() {
  case $(git_category "$1") in
    dns) echo "the host cannot resolve it: check the host DNS, or use a mirror (registries.git.rewrites)" ;;
    tls) echo "the CA is not trusted: add the corporate CA under trust.caCertificates (TLS verification is never turned off)" ;;
    proxy-auth) echo "proxy authentication failed: check the bootstrap credential of network.proxy.credential" ;;
    mtls) echo "the server wants a client certificate: add it under clientCertificates for this host" ;;
    credentials) echo "the Git server refused the credentials: check registries.git.credential" ;;
    network) echo "no route: set network.proxy, or allow the host through the firewall" ;;
    *) echo "see the log: $(tail -1 "$1" | redact)" ;;
  esac
}

# probe KIND URL [CLIENT-CERT-NAME]: TLS-verified reachability through the configured proxy.
probe() {
  set -- "$1" "$2" "${3:-}"
  certargs=
  [ -n "$3" ] && certargs="--cert $TMP/net/client-$3.crt --key $TMP/net/client-$3.key"
  # shellcheck disable=SC2086
  code=$(curl -K "$TMP/net/curlrc" -sS -o /dev/null -w '%{http_code}' --max-time 20 $certargs "$2" 2>"$TMP/curl") && rc=0 || rc=$?
  if [ "$code" = 407 ] || grep -q ' 407' "$TMP/curl" 2>/dev/null; then
    check_fail proxy-auth "$2" "the proxy refused the credentials (407): check network.proxy.credential"; return
  fi
  if [ "$rc" = 0 ] && [ "$code" -lt 500 ]; then ok "$1 reachable: $2 (HTTP $code)"; return; fi
  case $rc in
    5) check_fail dns "proxy" "the proxy host does not resolve: check network.proxy" ;;
    6) check_fail dns "$2" "the host does not resolve: check DNS or network.dns" ;;
    7|28) check_fail network "$2" "no connection (refused or timed out): check network.proxy and the firewall" ;;
    35|56) if [ -n "$3" ]; then check_fail mtls "$2" "the TLS handshake failed with client certificate $3: check the certificate, its key and the host list"
           else check_fail mtls "$2" "the TLS handshake failed: the server may require a client certificate (clientCertificates)"; fi ;;
    58) check_fail mtls "$2" "the client certificate or key could not be used: check clientCertificates.$3" ;;
    60|77) check_fail tls "$2" "the server certificate is not trusted: add the corporate CA under trust.caCertificates (never disable TLS verification)" ;;
    *) check_fail "$1" "$2" "HTTP $code / curl $rc: $(redact < "$TMP/curl" | tail -1)" ;;
  esac
}

if [ "$PRINT_REQ" = 1 ]; then
  if command -v node >/dev/null 2>&1; then NODE_MODE=host; else NODE_MODE=docker; fi
  [ -n "$CONFIG" ] && hmount "$(dirname "$CONFIG")" ro
  helper requirements --repo "$INSTALLER_ROOT" ${CONFIG:+--config "$CONFIG"}
  exit $?
fi

preflight
if [ "$FAILS" -gt 0 ]; then
  say ""; say "Preflight failed: $FAILS problem(s). Nothing was installed; fix them and run again (--check-only to iterate)."
  exit 2
fi
say "Preflight passed."
[ "$CHECK_ONLY" = 1 ] && exit 0

# ── 2. config before any download or build (D94 §6.2) ───────────────────────
mkdir -p "$STATE_DIR"; chmod 750 "$STATE_DIR"; hmount "$STATE_DIR"
if [ -n "$CONFIG" ]; then
  say "Staging the infrastructure config into $STATE_DIR"
  rm -f "$STATE_DIR/compose.infra.yml"
  helper stage --config "$CONFIG" ${CRED_DIR:+--credentials-dir "$CRED_DIR"} --state-dir "$STATE_DIR" 2>&1 | redact | tee -a "$LOG"
  [ -f "$STATE_DIR/compose.infra.yml" ] || die 1 "staging the config failed (see above)"
fi

# ── 3. release selection and verification (D71, owner answers a and c) ──────
KEYARGS="--keys $INSTALLER_ROOT/os/release-keys"
[ -d "$STATE_DIR/release-keys" ] && KEYARGS="$KEYARGS --keys $STATE_DIR/release-keys"
if [ "$CHANNEL" = signed ]; then
  if [ -n "$TRUSTED_KEYS" ]; then
    KEYARGS= PINS=
    for k in $TRUSTED_KEYS; do
      if [ -f "$k" ]; then
        k=$(abspath "$k"); hmount "$(dirname "$k")" ro
        id=$(helper fingerprint "$k" | sed -n 's/.*"keyId": "\([0-9a-f]*\)".*/\1/p')
        [ -n "$id" ] || die 3 "--trusted-key $k is not an Ed25519 public key"
        KEYARGS="$KEYARGS --key $k"; PINS="$PINS --pin $id"
        say "Pinned release key $id (from $k)"
      else
        PINS="$PINS --pin $k"
        say "Pinned release key $k"
      fi
    done
    KEYARGS="--keys $INSTALLER_ROOT/os/release-keys $KEYARGS $PINS"
    [ -d "$STATE_DIR/release-keys" ] && KEYARGS="--keys $STATE_DIR/release-keys $KEYARGS"
  else
    n=$(ls "$INSTALLER_ROOT/os/release-keys"/*.pub 2>/dev/null | wc -l)
    [ "$n" -gt 0 ] || die 3 "this installer ships no release key yet: pass --trusted-key <public key file or fingerprint> (the maintainer publishes it)"
    say "Release keys shipped with this installer:"
    # shellcheck disable=SC2046
    helper fingerprint $(ls "$INSTALLER_ROOT/os/release-keys"/*.pub) | sed -n -e 's/.*"keyId": "\([0-9a-f]*\)".*/  key id      \1/p' -e 's/.*"fingerprint": "\([0-9a-f]*\)".*/  fingerprint \1/p' | tee -a "$LOG"
    if [ "$ACCEPT_SHIPPED" = 0 ]; then
      [ "$UNATTENDED" = 1 ] && die 3 "unattended: confirm the trust anchor with --accept-shipped-key or pin it with --trusted-key"
      printf 'Trust these release keys? Compare the fingerprint with the one the maintainer publishes. [y/N] ' >/dev/tty
      read -r answer </dev/tty || answer=
      case $answer in y|Y|yes) ;; *) die 3 "release keys not confirmed" ;; esac
    fi
  fi
else
  say "WARNING: channel main installs an UNSIGNED development revision (owner opt-in; provenance upstream-unsigned)."
  if [ "$UNATTENDED" = 0 ]; then
    printf 'Install an unsigned revision? [y/N] ' >/dev/tty
    read -r answer </dev/tty || answer=
    case $answer in y|Y|yes) ;; *) die 3 "not confirmed" ;; esac
  fi
fi

MIRROR="$STATE_DIR/source.git"
[ -d "$MIRROR" ] || git init -q --bare "$MIRROR"
say "Fetching $SOURCE (channel $CHANNEL${REF:+, ref $REF}$([ "$CHANNEL" = signed ] && [ -z "$REF" ] && echo ", maturity $MATURITY or later"))"
logged git_net -C "$MIRROR" fetch --prune --force --tags --no-recurse-submodules "$SOURCE" '+refs/heads/main:refs/heads/main' \
  || die 1 "fetching $SOURCE failed (see the log)"
hmount "$MIRROR" ro
# shellcheck disable=SC2086
helper select --repo "$MIRROR" --channel "$CHANNEL" --maturity "$MATURITY" ${REF:+--ref "$REF"} $KEYARGS > "$TMP/select" 2>"$TMP/select.err" || true
REL_OK=0 REL_CODE= REL_MATURITY= REL_COMMIT= REL_TREE= REL_VERSION= REL_SIGNED=0 REL_KEYID= REL_PROVENANCE= REL_REF= REL_META_DIGEST= REL_SECURITY= REL_CHAIN= REL_FINGERPRINT=
while IFS='=' read -r k v; do
  case $k in REL_OK|REL_CODE|REL_COMMIT|REL_TREE|REL_VERSION|REL_SIGNED|REL_KEYID|REL_PROVENANCE|REL_REF|REL_META_DIGEST|REL_SECURITY|REL_CHAIN|REL_FINGERPRINT|REL_CHANNEL|REL_MATURITY)
    eval "$k=\$v" ;; esac
done < "$TMP/select"
if [ "$REL_OK" != 1 ]; then
  redact < "$TMP/select.err" | tee -a "$LOG"
  die 3 "release verification refused ($REL_CODE): nothing from the candidate was run or built"
fi
if [ "$CHANNEL" = signed ]; then
  say "Verified $REL_MATURITY release ${REL_VERSION} ($REL_REF): commit $REL_COMMIT, tree $REL_TREE, signed by key $REL_KEYID${REL_CHAIN:+ (key chain via $REL_CHAIN)}"
  [ -n "$REL_SECURITY" ] && say "  this is a security update (severity $REL_SECURITY)"
else
  say "Selected unsigned revision $REL_COMMIT ($REL_REF), tree $REL_TREE"
fi

# The record of what was installed (Stage 1b: /data/aura/release/source.json).
PROV=$REL_PROVENANCE
[ "$MODE" = developer ] && PROV=locally-modified
cat > "$TMP/source.json" <<EOF
{"v":1,"url":"$(printf '%s' "$SOURCE" | sed 's#://[^/@]*@#://#')","channel":"$CHANNEL","maturity":"$REL_MATURITY","ref":"$REL_REF","commit":"$REL_COMMIT","gitTree":"$REL_TREE","version":"$REL_VERSION","signed":$([ "$REL_SIGNED" = 1 ] && echo true || echo false),"keyId":"$REL_KEYID","metaDigest":"$REL_META_DIGEST","provenance":"$PROV","mode":"$MODE","installedAt":"$TS","installer":"install.sh"}
EOF

compose_files() {
  printf -- '-f %s/docker-compose.yml' "$1"
  [ -f "$STATE_DIR/compose.infra.yml" ] && printf -- ' -f %s/compose.infra.yml' "$STATE_DIR"
  [ -f "$STATE_DIR/compose.secrets.yml" ] && printf -- ' -f %s/compose.secrets.yml' "$STATE_DIR"
  return 0
}
# Compose's own project name for a directory (its default; volumes are named after it).
project_of() { basename "$1" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9_-'; }

# write_data PROJECT: the first-boot handoff into the data volume (infra seed, mode, source record, log).
write_data() {
  vol="${1}_aura-app-data"
  docker volume inspect "$vol" >/dev/null 2>&1 || logged docker volume create \
    --label com.docker.compose.project="$1" --label com.docker.compose.volume=aura-app-data "$vol" || die 1 "cannot create volume $vol"
  seedargs=
  [ -d "$STATE_DIR/seed" ] && seedargs="--seed $STATE_DIR/seed"
  # shellcheck disable=SC2086
  logged docker run --rm --network none -e HOME=/tmp -v "$INSTALLER_ROOT:$INSTALLER_ROOT:ro" -v "$STATE_DIR:$STATE_DIR:ro" \
    -v "$TMP:$TMP:ro" -v "$vol:/data" "$NODE_IMAGE" node "$HELPER" write-data --data /data $seedargs \
    --system-mode "$MODE" --source-json "$TMP/source.json" || die 1 "writing the first-boot handoff into $vol failed (see the log)"
}

wait_ready() {
  say "Waiting for the AuraOS kernel (up to $((READY_TIMEOUT / 60)) min; the first build takes a while)"
  start=$(date +%s)
  while :; do
    # Phase 6 K: status.json.kernelReadyAt; before K: the auth status route answers.
    if docker exec aura-shell sh -c 'grep -q "\"kernelReadyAt\": *\"" /data/aura/boot/status.json 2>/dev/null || curl -fsS -o /dev/null http://127.0.0.1:3000/api/auth/status' >/dev/null 2>&1; then
      say "AuraOS is ready."; return 0
    fi
    state=$(docker inspect -f '{{.State.Status}}' aura-shell 2>/dev/null || echo missing)
    case $state in exited|dead|missing) docker logs --tail 40 aura-shell 2>&1 | redact | tee -a "$LOG"; die 1 "the shell container is $state (see above)" ;; esac
    [ $(( $(date +%s) - start )) -lt "$READY_TIMEOUT" ] || die 1 "not ready after $READY_TIMEOUT s: docker logs aura-shell"
    sleep 10
  done
}

# D94 O3: bootstrap credentials are deleted once the kernel imported them (IC-5) and a build verified.
finish_credentials() {
  [ -d "$STATE_DIR/credentials" ] || return 0
  if [ "$KEEP_CREDS" = 1 ]; then say "Bootstrap credentials kept in $STATE_DIR/credentials (--keep-bootstrap-credentials)."; return 0; fi
  if docker exec aura-shell grep -q '"credentialsImported": *true' /data/aura/boot/status.json 2>/dev/null; then
    rm -rf "$STATE_DIR/credentials"; say "Bootstrap credentials imported by AuraOS and deleted from $STATE_DIR (D94 O3)."
  else
    say "Bootstrap credentials kept in $STATE_DIR/credentials: this release does not import them into the vault yet (D94 IC-5)."
  fi
}

# ── 4. build and start ───────────────────────────────────────────────────────
if [ "$MODE" = normal ]; then
  # The one release builder (Phase 6 stream B), THIS installer's copy, run in the builder runner
  # image (node, git, docker CLI + buildx; built from this installer's os/release/runner, base
  # images through the D94 mirrors). It fetches the verified revision from the host mirror into
  # the data volume's own mirror, verifies it again with the same trust (D71), stages it with git
  # archive and checks the staged tree, builds the images (BuildKit, the D94 secrets as secret
  # mounts only), installs and builds in throwaway containers, runs server.mjs --check and
  # writes the read-only release and the first pointer.
  P=$(project_of "$DIR")
  VOL="${P}_aura-app-data"
  SOCK=/var/run/docker.sock
  case ${DOCKER_HOST:-} in
    "") ;;
    unix://*) SOCK=${DOCKER_HOST#unix://} ;;
    *) die 1 "Normal Mode builds through the local Docker socket; DOCKER_HOST=$DOCKER_HOST is not a unix socket" ;;
  esac
  hmount "$INSTALLER_ROOT" ro
  # shellcheck disable=SC2046
  eval "$(helper runner-plan --root "$INSTALLER_ROOT" --node-image "$NODE_IMAGE" ${CONFIG:+--config "$CONFIG"} | grep -E '^RUNNER_(TAG|NODE|CLI)=[A-Za-z0-9._:/@+-]+$')"
  [ -n "${RUNNER_TAG:-}" ] || die 1 "cannot plan the release builder runner image (see the log)"
  if docker image inspect "$RUNNER_TAG" >/dev/null 2>&1; then
    ok "release builder runner $RUNNER_TAG (present)"
  else
    say "Building the release builder runner $RUNNER_TAG (from $RUNNER_NODE and $RUNNER_CLI)"
    if ! DOCKER_BUILDKIT=1 logged docker buildx build --load -t "$RUNNER_TAG" --build-arg "NODE_IMAGE=$RUNNER_NODE" \
        --build-arg "DOCKER_CLI_IMAGE=$RUNNER_CLI" -f "$INSTALLER_ROOT/os/release/runner/Dockerfile" "$INSTALLER_ROOT/os"; then
      tail -5 "$LOG" > "$TMP/pull"
      die 1 "the release builder runner image could not be built: $(pull_diagnosis "$TMP/pull") (base images $RUNNER_NODE, $RUNNER_CLI; mirror them under registries.oci.mirrors)"
    fi
    ok "release builder runner $RUNNER_TAG built"
  fi
  write_data "$P"
  ok "first-boot handoff written (system-mode normal, source.json${CONFIG:+, infrastructure seed})"
  helper build-inputs --state-dir "$STATE_DIR" ${CONFIG:+--config "$CONFIG"} > "$TMP/infra.json" || die 1 "rendering the build inputs failed"
  BREF=$REL_REF
  [ "$CHANNEL" = main ] && BREF=$REL_COMMIT
  say "Building release $REL_VERSION ($REL_COMMIT) with the release builder (this takes a while)"
  # shellcheck disable=SC2086
  { brc=0; docker run --rm --network none --name aura-release-builder -e HOME=/tmp \
      -v "$SOCK:/var/run/docker.sock" -v "$VOL:/data" -v "$INSTALLER_ROOT:$INSTALLER_ROOT:ro" \
      -v "$STATE_DIR:$STATE_DIR:ro" -v "$TMP:$TMP:ro" "$RUNNER_TAG" \
      node "$BUILDER" build --data-root /data --data-volume "$VOL" --fetch-from "$MIRROR" \
      --channel "$CHANNEL" --maturity "$MATURITY" --ref "$BREF" --expect-commit "$REL_COMMIT" $KEYARGS \
      --infra "$TMP/infra.json" --first-install 2>&1 >"$TMP/build.json" || brc=$?; echo "$brc" > "$TMP/.brc"; } | redact | sed 's/^/  /' | tee -a "$LOG"
  rm -rf "$STATE_DIR/rendered/secrets" "$STATE_DIR/compose.secrets.yml"
  brc=$(cat "$TMP/.brc")
  if [ "$brc" != 0 ]; then
    redact < "$TMP/build.json" | tee -a "$LOG"
    [ "$brc" = 3 ] && die 3 "the release builder refused (see above): nothing was installed or started"
    die 1 "the release build failed (see above): nothing was started"
  fi
  REL_ID=$(sed -n 's/^ *"id": "\([^"]*\)".*/\1/p' "$TMP/build.json" | head -1)
  ok "release $REL_ID built (read-only, current)"
  # ── STREAM L HANDOFF ─────────────────────────────────────────────────────
  # The Normal layout starts from the release's own compose file and entry script (Phase 6
  # stream L: docker-compose.release.yml, release-entry.sh). Until L lands, the install stops
  # here: the release is built and current, no AuraOS container was started.
  die 3 "release $REL_ID is built and current, but the Normal-mode runtime (Phase 6 stream L) is not there yet: nothing was started. Use --developer for the Developer layout."
fi

# Developer layout (today's git checkout + compose, D57/owner answer d), from the verified commit.
[ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die 1 "$DIR exists and is not empty: choose another --dir"
say "Checking out $REL_COMMIT into $DIR (Developer layout)"
logged git clone -q --no-checkout "$MIRROR" "$DIR" || die 1 "git clone failed"
logged git -C "$DIR" remote set-url origin "$(printf '%s' "$SOURCE" | sed 's#://[^/@]*@#://#')"
logged git -C "$DIR" checkout -q -B main "$REL_COMMIT" || die 1 "checkout failed"
[ "$(git -C "$DIR" rev-parse 'HEAD^{tree}')" = "$REL_TREE" ] || die 3 "the checkout's tree is not the verified tree"
[ -z "$(git -C "$DIR" status --porcelain)" ] || die 3 "the checkout is not clean"
ok "checkout = verified tree $REL_TREE"
P=$(project_of "$DIR")
write_data "$P"
ok "first-boot handoff written (system-mode developer, source.json${CONFIG:+, infrastructure seed})"
say "Building and starting AuraOS (docker compose; BuildKit)"
# shellcheck disable=SC2046
if ! AURA_HOST_WORKSPACE="$DIR" DOCKER_BUILDKIT=1 logged docker compose -p "$P" --project-directory "$DIR" $(compose_files "$DIR") up -d --build; then
  tail -30 "$LOG"
  die 1 "docker compose up failed (see above)"
fi
rm -rf "$STATE_DIR/rendered/secrets" "$STATE_DIR/compose.secrets.yml"
wait_ready
finish_credentials
say ""
say "AuraOS $REL_VERSION is running (Developer Mode, $PROV) at http://<this host>:3000"
say "Owner setup code: docker exec aura-shell aura setup-code"
[ -f "$STATE_DIR/compose.infra.yml" ] && say "Manual rebuilds with this config: docker compose -p $P --project-directory $DIR -f $DIR/docker-compose.yml -f $STATE_DIR/compose.infra.yml up -d --build"
exit 0
