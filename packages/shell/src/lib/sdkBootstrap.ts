/**
 * Seed the local OCI registry with the `@aura/*` packages, on every boot.
 *
 * Why this exists: apps installed into user/global scope live OUTSIDE the pnpm
 * workspace, so `workspace:*` can't resolve for them. `scopes/portability.ts`
 * moves their `@aura/*` deps into `auraDependencies`, and the sandbox's synth
 * entrypoint runs `aura sdk install` on first launch to pull those packages
 * from `com.aura.registry` over `oras`.
 *
 * That whole chain depends on the packages actually BEING in the registry —
 * and until now the only thing that put them there was a human running
 * `pnpm publish:local`. A fresh AuraOS therefore had an empty registry, and any
 * installed app depending on the SDK would install cleanly and then die at
 * launch with an unresolvable import, far from the cause. Nothing in the OS
 * surfaced that; you found out when an app failed to start.
 *
 * So the seed runs unattended. Three properties matter:
 *
 *   • NON-FATAL. A registry that never comes up must not make the OS
 *     unbootable — the OS is perfectly usable without user-scope SDK apps.
 *   • DETACHED. Boot does not block on an `oras push` loop.
 *   • CHEAP WHEN WARM. `os/publish-aura-packages.mjs` compares the digest of
 *     each about-to-be-pushed tarball against the tag already in the registry
 *     and skips matches, so the steady state is a handful of HEAD requests.
 *     That is why this can run every boot instead of carrying a "have I done
 *     this?" flag, which would go stale the moment someone rebuilt a package.
 *
 * Ordering: this MUST run after `AppManager.init()`. The registry is itself an
 * app (`com.aura.registry`, autoStart + critical, serverPort 4090) which init()
 * is what starts — so at Dockerfile-CMD time, or anywhere before init(),
 * nothing is listening on 4090 yet.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Where the packages get pushed. Mirrors the script's own default, which is
 *  pinned to `com.aura.registry`'s manifest.serverPort. */
const REGISTRY_URL = process.env['AURA_REGISTRY_URL']
  ?? 'http://aura-com.aura.registry:4090';

/** The monorepo root inside the container — the script lives at os/ under it. */
const WORKSPACE = process.env['AURA_WORKSPACE_DIR'] ?? '/workspace';

/** How long to wait for the registry app to start answering before giving up.
 *  Generous: on a first boot zot has to come up in a fresh container. */
const REGISTRY_WAIT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
/** A single push of five packages; well clear of a slow first run. */
const PUBLISH_TIMEOUT_MS = 300_000;

/**
 * Poll the registry's OCI base endpoint until it answers. `/v2/` is the
 * distribution-spec liveness probe — any HTTP response at all (including the
 * 401 a secured registry would give) means it is up; only connection failures
 * are treated as "not yet".
 */
async function waitForRegistry(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${REGISTRY_URL}/v2/`, {
        signal: AbortSignal.timeout(POLL_INTERVAL_MS),
      });
      if (res.status > 0) return true;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Publish every `@aura/*` package to the local registry if they aren't already
 * there. Never throws and never blocks the caller for longer than it takes to
 * find the script.
 */
export function ensureSdkPublished(): void {
  const script = join(WORKSPACE, 'os', 'publish-aura-packages.mjs');
  if (!existsSync(script)) {
    // A packaged (non-monorepo) deployment won't ship os/. Not an error, but
    // say so once — otherwise a user-scope app failing to launch later has no
    // breadcrumb pointing here.
    console.warn(`[sdk-bootstrap] ${script} not found — skipping @aura/* registry seed. ` +
      'User/global-scope apps depending on @aura/* will not be able to resolve them.');
    return;
  }

  // Detached on purpose: boot continues while this runs.
  void (async () => {
    const up = await waitForRegistry(Date.now() + REGISTRY_WAIT_MS);
    if (!up) {
      console.warn('[sdk-bootstrap] registry did not come up within ' +
        `${REGISTRY_WAIT_MS / 1000}s at ${REGISTRY_URL} — @aura/* not seeded. ` +
        'Run `pnpm publish:local` once it is running.');
      return;
    }

    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [script, '--registry', REGISTRY_URL], {
        cwd: WORKSPACE,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: PUBLISH_TIMEOUT_MS,
      });

      // The script already logs one line per package plus a summary; forward
      // them under our own prefix so a failed seed is findable in `make logs`.
      let tail = '';
      child.stdout.on('data', (b: Buffer) => { tail += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { tail += b.toString(); });

      child.on('error', (err) => {
        console.warn(`[sdk-bootstrap] could not run the publisher: ${err.message}`);
        resolve();
      });
      child.on('close', (code) => {
        const summary = tail.split('\n').filter((l) => l.includes('summary:')).pop();
        if (code === 0) {
          console.log(`[sdk-bootstrap] @aura/* registry seed ok${summary ? ` — ${summary.trim()}` : ''}`);
        } else {
          // Loud, but still not fatal — see the header.
          console.warn(`[sdk-bootstrap] @aura/* registry seed exited ${code}. ` +
            'User/global-scope apps depending on @aura/* may fail to launch.');
          if (tail.trim()) console.warn(tail.trim());
        }
        resolve();
      });
    });
  })();
}
