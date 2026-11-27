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
#                     infra_npm_basic, infra_apt_auth, infra_git, infra_mtls); absent unless
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
# mTLS (D94 IC-8, O8): the client keys arrive as one secret (infra_mtls, a
# "# aura-mtls <name>" line before each PEM key) and are split into this
# step's tmpfs (0600); with the public certificates (mtls/<name>.crt) each
# host in mtls/clients gets git, npm, apt and pip settings. Same rule as
# os/infra/adapters/mtls.mjs toolConfig().
if [ -s "$_as/infra_mtls" ] && [ -f "$_ai/mtls/clients" ]; then
  mkdir -p "$_aw/mtls"
  chmod 700 "$_aw/mtls"
  ( umask 077; awk -v d="$_aw/mtls" '/^# aura-mtls /{f=d "/" $3 ".key"; next} f!=""{print > f}' "$_as/infra_mtls" )
  : > "$_aw/mtls/npmrc"
  : > "$_aw/mtls/apt.conf"
  _gi=${GIT_CONFIG_COUNT:-0}
  _py=$(sed -n 's|^index-url = [a-z]*://\([^/:]*\).*|\1|p' "$_ai/xdg/pip/pip.conf" 2>/dev/null)
  while IFS="$_tab" read -r _c _h; do
    [ -n "$_h" ] && [ -s "$_aw/mtls/$_c.key" ] || continue
    _crt="$_ai/mtls/$_c.crt"
    _key="$_aw/mtls/$_c.key"
    eval "export GIT_CONFIG_KEY_$_gi=http.https://$_h/.sslCert GIT_CONFIG_VALUE_$_gi=$_crt"
    _gi=$((_gi + 1))
    eval "export GIT_CONFIG_KEY_$_gi=http.https://$_h/.sslKey GIT_CONFIG_VALUE_$_gi=$_key"
    _gi=$((_gi + 1))
    printf '//%s/:certfile=%s\n//%s/:keyfile=%s\n' "$_h" "$_crt" "$_h" "$_key" >> "$_aw/mtls/npmrc"
    printf 'Acquire::https::%s::SslCert "%s";\nAcquire::https::%s::SslKey "%s";\n' "$_h" "$_crt" "$_h" "$_key" >> "$_aw/mtls/apt.conf"
    if [ "$_h" = "$_py" ] && [ -z "${PIP_CLIENT_CERT:-}" ]; then
      ( umask 077; cat "$_crt" "$_key" > "$_aw/mtls/$_c.pip.pem" )
      export PIP_CLIENT_CERT="$_aw/mtls/$_c.pip.pem"
    fi
  done < "$_ai/mtls/clients"
  export GIT_CONFIG_COUNT=$_gi
  unset _gi _py _c _h _crt _key
fi

# npm/pnpm: the build has no user of its own, so the public npmrc plus the
# registry auth is its user config (pnpm 11+ reads no global npmrc).
if [ -f "$_ai/npmrc" ] || [ -s "$_as/infra_npmrc" ] || [ -s "$_aw/mtls/npmrc" ]; then
  mkdir -p "$_aw"
  cat "$_ai/npmrc" "$_as/infra_npmrc" "$_aw/mtls/npmrc" > "$_aw/npmrc" 2>/dev/null
  export NPM_CONFIG_USERCONFIG="$_aw/npmrc"
fi
if [ -s "$_as/infra_npm_basic" ]; then
  IFS=: read -r COREPACK_NPM_USERNAME COREPACK_NPM_PASSWORD < "$_as/infra_npm_basic"
  export COREPACK_NPM_USERNAME COREPACK_NPM_PASSWORD
fi
if [ -s "$_as/infra_git" ]; then
  _gi=${GIT_CONFIG_COUNT:-0}
  eval "export GIT_CONFIG_KEY_$_gi=credential.helper"
  eval "export GIT_CONFIG_VALUE_$_gi='store --file=$_as/infra_git'"
  export GIT_CONFIG_COUNT=$((_gi + 1))
  unset _gi
fi

# APT: a temporary APT_CONFIG (the public drop-in, mirrored copies of the
# sources, the auth file); the image's own /etc/apt is never changed.
if [ -d "$_ai/apt" ] || [ -s "$_as/infra_apt_auth" ] || [ -s "$_aw/mtls/apt.conf" ]; then
  mkdir -p "$_aw/apt/sources.list.d"
  : > "$_aw/apt/apt.conf"
  [ -f "$_ai/apt/apt.conf.d/90aura-infra" ] && cat "$_ai/apt/apt.conf.d/90aura-infra" >> "$_aw/apt/apt.conf"
  [ -s "$_aw/mtls/apt.conf" ] && cat "$_aw/mtls/apt.conf" >> "$_aw/apt/apt.conf"
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
