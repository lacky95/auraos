# AuraOS bash startup snippet — kept exec-free so it adds zero perceptible
# latency to terminal cold-start. Anything that needs to be computed about
# the execution context (layer, app id) is passed in via env vars from the
# spawning side (see ProotRunner.spawn → AURA_LAYER_TAG, APP_ID, etc.),
# so this file never has to shell out.
#
# Installed into the proot rootfs at /root/.bashrc by the container CMD
# (see Dockerfile). Mirror copy at /etc/profile.d/aura-prompt.sh so
# non-login shells also pick it up.

# The AuraOS toolchain is layered as a per-app allowlist on top of the
# shared store. Prepend the allowlist so granted capabilities (and `*` apps,
# whose allowlist mirrors the store) win over the base rootfs's /usr/bin
# equivalents. Set unconditionally so non-interactive shells (scp, exec
# probes, child processes spawned from the app) also see the caps.
if [ -d /aura/my-tools ]; then
  case ":$PATH:" in
    *":/aura/my-tools:"*) ;;
    *) export PATH="/aura/my-tools:$PATH" ;;
  esac
fi

# Don't run on non-interactive shells (scp, ssh exec, etc.).
case $- in *i*) ;; *) return ;; esac

# Layer tag (e.g. "[proot+ctnr]") is set by the parent process when spawning
# us; falls back to empty if we're running outside that context.
: "${AURA_LAYER_TAG:=}"

# Coloured prompt: user@host[layer]:cwd$
#   \[ \] tells bash these are non-printing chars (correct line wrap)
#   38;5;82  = bright green
#   38;5;208 = orange
# AURA_HOSTNAME overrides the kernel hostname for display purposes — used by
# container-mode apps so the prompt shows the friendly appId (e.g.
# `com.aura.counter`) rather than the sanitised instance container name. Falls
# back to bash's \h when unset (PRoot apps + host shells).
PS1='\[\e[38;5;82m\]\u@${AURA_HOSTNAME:-\h}\[\e[0m\]${AURA_LAYER_TAG:+\[\e[38;5;208m\]$AURA_LAYER_TAG\[\e[0m\]}:\w\$ '

# Helpful aliases that don't slow us down.
alias ll='ls -lah --color=auto'
alias l='ls --color=auto'
alias grep='grep --color=auto'

# Surface the running app id in the title for AuraOS terminals (xterm sequence).
# `${APP_INSTANCE_ID:-${APP_ID:-bash}}` is pure parameter expansion — no exec.
if [ -n "${APP_INSTANCE_ID-}${APP_ID-}" ]; then
  PROMPT_COMMAND='printf "\033]0;%s\007" "${APP_INSTANCE_ID:-${APP_ID:-bash}}"'
fi
