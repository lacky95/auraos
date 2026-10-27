// Final fallback when no env var hints at the shell location. 127.0.0.1, not
// localhost: when invoked from a PRoot sandbox the bound base-rootfs has no
// /etc/hosts entry for `localhost` (Debian-slim ships an empty one), so the
// DNS lookup fails with ENOTFOUND. The literal address always resolves.
const DEFAULT_SHELL_URL = 'http://127.0.0.1:3000';

/**
 * Resolve the shell URL. Probe order:
 *   1. AURA_SHELL_URL — explicit override (set by `aura` shim, dev scripts).
 *   2. OS_API_BASE    — every app sandbox already exports this. PRoot apps
 *                        get `http://127.0.0.1:3000`; container-sandbox
 *                        apps get `http://aura-shell:3000` (the aura-net
 *                        hostname). Reading it here means `aura jump` from
 *                        inside a sibling container hits the right host
 *                        without any compose-level changes.
 *   3. Loopback default — last-ditch for direct host invocations.
 */
export function shellUrl(): string {
  return process.env['AURA_SHELL_URL']
      ?? process.env['OS_API_BASE']
      ?? DEFAULT_SHELL_URL;
}
