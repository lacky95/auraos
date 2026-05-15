#!/usr/bin/env bash
# AuraOS CLI launcher — wrapper script (not a symlink).
#
# Why a script and not a symlink: PRoot's --bind mechanism takes a source
# file and exposes it at a destination path inside the sandbox. If the
# source is itself a symlink, `lstat` inside the PRoot still sees it as a
# symlink, but `readlink` returns EINVAL — which makes Node's `realpathSync`
# (called by run_main.resolveMainPath when executing a script directly)
# blow up with "EINVAL: invalid argument, readlink '/usr/local/bin/aura'".
#
# This wrapper sidesteps that by exec'ing `node` with the FINAL path. Bash
# is happy with the bound regular file; Node then opens
# `/workspace/packages/aura-cli/dist/aura.cjs` directly (a normal file under
# the workspace bind mount), and never goes through the troublesome bind.
exec node /workspace/packages/aura-cli/dist/aura.cjs "$@"
