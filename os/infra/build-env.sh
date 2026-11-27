# AuraOS image build: the infrastructure config for ONE network step (D94 IC-3).
# Sourced (`. /run/aura-infra/build-env.sh`) at the start of every Dockerfile
# RUN that downloads something. POSIX sh (dash in the Debian stages).
#
# Inputs, all mounted for that RUN only:
#   /etc/aura/infra   the named build context `aura-infra-public` (the adapters'
#                     public output: env, ca-bundle.pem, npmrc, gitconfig,
#                     apt/…, artifacts.rewrites). Without a config it is the
#                     Dockerfile's empty `scratch` stage, and this file changes
#                     nothing: the build is exactly today's.
#   /run/secrets/*    BuildKit secrets (infra_proxy[_http], infra_npmrc,
#                     infra_npm_basic, infra_apt_auth, infra_git); absent unless
#                     install.sh / the release builder passed them
#   /run/aura-build   a tmpfs for this step's scratch files
# Exports only into this RUN's process env and writes only into the tmpfs:
# nothing of it reaches a layer, the image config or the history.
# Defines aura_url URL: the URL through registries.artifacts.rewrites.

# (The AURA_* overrides exist for the unit tests only.)
_ai=${AURA_INFRA_DIR:-/etc/aura/infra}
_aw=${AURA_BUILD_TMP:-/run/aura-build}
_as=${AURA_SECRETS_DIR:-/run/secrets}
_ae=${AURA_APT_ETC:-/etc/apt}
_tab=$(printf '\t')

# Non-secret system layer: proxy URLs without credentials, NO_PROXY, the CA
# and registry pointers (KEY=value, values checked shell-safe when rendered).
if [ -f "$_ai/env" ]; then
  while IFS= read -r _l; do
    case $_l in ''|'#'*) ;; [A-Za-z_]*=*) export "$_l" ;; esac
  done < "$_ai/env"
fi

# Secrets: environment of this step only.
if [ -s "$_as/infra_proxy" ]; then
  _p=$(cat "$_as/infra_proxy")
  [ -n "${HTTPS_PROXY:-}" ] && export HTTPS_PROXY="$_p" https_proxy="$_p"
  [ -n "${HTTP_PROXY:-}" ] && export HTTP_PROXY="$_p" http_proxy="$_p"
  if [ -s "$_as/infra_proxy_http" ]; then
    _p=$(cat "$_as/infra_proxy_http")
    export HTTP_PROXY="$_p" http_proxy="$_p"
  fi
  unset _p
fi
# npm/pnpm: the build has no user of its own, so the public npmrc plus the
# registry auth is its user config (pnpm 11+ reads no global npmrc).
if [ -f "$_ai/npmrc" ] || [ -s "$_as/infra_npmrc" ]; then
  mkdir -p "$_aw"
  cat "$_ai/npmrc" "$_as/infra_npmrc" > "$_aw/npmrc" 2>/dev/null
  export NPM_CONFIG_USERCONFIG="$_aw/npmrc"
fi
if [ -s "$_as/infra_npm_basic" ]; then
  IFS=: read -r COREPACK_NPM_USERNAME COREPACK_NPM_PASSWORD < "$_as/infra_npm_basic"
  export COREPACK_NPM_USERNAME COREPACK_NPM_PASSWORD
fi
if [ -s "$_as/infra_git" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0="store --file=$_as/infra_git"
fi

# APT: a temporary APT_CONFIG (the public drop-in, mirrored copies of the
# sources, the auth file); the image's own /etc/apt is never changed.
if [ -d "$_ai/apt" ] || [ -s "$_as/infra_apt_auth" ]; then
  mkdir -p "$_aw/apt/sources.list.d"
  : > "$_aw/apt/apt.conf"
  [ -f "$_ai/apt/apt.conf.d/90aura-infra" ] && cat "$_ai/apt/apt.conf.d/90aura-infra" >> "$_aw/apt/apt.conf"
  [ -s "$_as/infra_apt_auth" ] && printf 'Dir::Etc::netrc "%s";\n' "$_as/infra_apt_auth" >> "$_aw/apt/apt.conf"
  if [ -f "$_ai/apt/mirrors" ]; then
    # A mirror replaces scheme://host and keeps the path (adapters/apt.mjs rewriteAptSources).
    : > "$_aw/apt/sed"
    while IFS="$_tab" read -r _h _m; do
      [ -n "$_h" ] || continue
      _he=$(printf '%s' "$_h" | sed 's/[.[\*^$]/\\&/g')
      _me=$(printf '%s' "$_m" | sed 's/[|&\\]/\\&/g')
      printf 's|https\\{0,1\\}://%s\\([/[:space:]]\\)|%s\\1|g\ns|https\\{0,1\\}://%s$|%s|g\n' "$_he" "$_me" "$_he" "$_me" >> "$_aw/apt/sed"
    done < "$_ai/apt/mirrors"
    : > "$_aw/apt/sources.list"
    [ -f "$_ae/sources.list" ] && sed -f "$_aw/apt/sed" "$_ae/sources.list" > "$_aw/apt/sources.list"
    for _f in "$_ae"/sources.list.d/*; do
      [ -f "$_f" ] && sed -f "$_aw/apt/sed" "$_f" > "$_aw/apt/sources.list.d/${_f##*/}"
    done
    printf 'Dir::Etc::SourceList "%s";\nDir::Etc::SourceParts "%s";\n' "$_aw/apt/sources.list" "$_aw/apt/sources.list.d" >> "$_aw/apt/apt.conf"
    unset _h _m _he _me _f
  fi
  export APT_CONFIG="$_aw/apt/apt.conf"
fi

aura_url() {
  if [ -f "$_ai/artifacts.rewrites" ]; then
    while IFS="$_tab" read -r _from _to; do
      case $1 in "$_from"*) printf '%s%s\n' "$_to" "${1#"$_from"}"; return 0 ;; esac
    done < "$_ai/artifacts.rewrites"
  fi
  printf '%s\n' "$1"
}
unset _l
