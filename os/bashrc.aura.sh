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

# Surface the current location's hostname in the xterm window title so the
# AuraOS terminal chrome can show which sandbox/container the live shell is in.
# The Terminal app listens for this OSC sequence (term.onTitleChange) and
# updates its host indicator — so it follows the user as they `aura jump`
# between sandboxes, since each jumped bash re-runs this snippet.
#
# Value resolves with sensible fallbacks:
#   • base terminal  → AURA_TERM_LABEL (the host, e.g. `aura-shell`; set by the
#                       Terminal app's pty-server on the host shell so it shows
#                       the machine, not the `com.aura.terminal` package id)
#   • container apps  → AURA_HOSTNAME (the friendly appId, set by enter-sandbox)
#   • proot apps      → APP_ID (AURA_HOSTNAME is unset; proot inherits the host
#                       kernel hostname, so APP_ID is the meaningful label)
#   • master / host   → $HOSTNAME (e.g. `aura-shell`)
# Pure parameter expansion — no exec.
PROMPT_COMMAND='printf "\033]0;%s\007" "${AURA_TERM_LABEL:-${AURA_HOSTNAME:-${APP_ID:-$HOSTNAME}}}"'
