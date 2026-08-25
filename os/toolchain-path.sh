# AuraOS master-container PATH snippet.
#
# The master container (aura-shell) is not a sandbox — it is the OS process
# itself, running as root with the docker socket and all of /os, /data and
# /workspace. There is no `tools[]` allowlist to grant against it (see
# `aura cap grant`, which is manifest-scoped and needs an installed app), so
# the master simply gets the WHOLE toolchain on PATH.
#
# We point at the volume-backed mirror rather than /os/toolchain/bin because
# the mirror is the copy that survives a container recreate — an image-layer
# toolchain loses every `cap install` addition when the writable layer is
# thrown away, and with it every apt/npm binary the cap installed into
# /usr/bin. AppManager.syncToolchainMirror() restores the two into agreement
# on boot; this keeps the master usable either way.
#
# APPENDED, not prepended: the container's own binaries stay authoritative,
# and the mirror only fills in caps the master would otherwise be missing.
#
# Installed at /etc/profile.d/aura-toolchain.sh (login shells reset root's
# PATH via Debian's /etc/profile, so the image's ENV alone isn't enough).
if [ -d /data/aura/toolchain/bin ]; then
  case ":$PATH:" in
    *":/data/aura/toolchain/bin:"*) ;;
    *) export PATH="$PATH:/data/aura/toolchain/bin" ;;
  esac
fi
