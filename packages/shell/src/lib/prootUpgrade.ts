/**
 * `POST /api/admin/upgrade-proot[?force=1]`: build a newer PRoot from source
 * into the running master (`/usr/local/bin/proot`, ahead of Debian's
 * `/usr/bin/proot` on PATH).
 *
 * Why: the Debian proot has known EFAULT issues with Rust-compiled native
 * modules (Tailwind 4 Oxide, jiti's bundled bindings, ...); upstream
 * `proot-me/proot` fixes many, but is in no Debian release.
 *
 * It builds and installs code as root in the master, so (SF-2 review, the
 * shared gate lib/privilegedExec.ts): argv only, verified apt for the build
 * dependency, the owner's password (`fresh`) bound to the source and ref, and
 * an audit entry. Reporting an existing build (no `force`) needs nobody.
 * The upstream ref is not pinned (it never was): the approval names it.
 */
import { existsSync } from 'node:fs';
import type { ProotActionHost, RuntimeAction } from '@aura/core';
import * as core from '@aura/core';
import { json } from './approvals/service.ts';
import { auditPrivileged, livePrivilegedDeps, privilegedAction, type PrivilegedDeps } from './privilegedExec.ts';
import { runtimeAction } from './runtimeActions.ts';

export const PROOT_SOURCE = core.PROOT_SOURCE;
export const PROOT_REF = core.PROOT_REF;
export const PROOT_UPGRADE_OP = 'master.proot-upgrade';
const BIN = core.PROOT_LOCAL_BIN;

type Ctx = Parameters<PrivilegedDeps['ownerAction']>[0] & { url: URL };

export interface ProotUpgradeDeps extends PrivilegedDeps {
  /** The PRoot module's actions: `version` (read-only) and `upgrade` (the build). The route authorizes and audits. */
  action(id: 'version' | 'upgrade'): RuntimeAction | Response;
  exists(path: string): boolean;
}

export function liveProotUpgradeDeps(): ProotUpgradeDeps {
  return { ...livePrivilegedDeps(), action: (id) => runtimeAction('proot', id), exists: existsSync };
}

export async function postProotUpgrade(ctx: Ctx, deps: ProotUpgradeDeps = liveProotUpgradeDeps()): Promise<Response> {
  const force = ctx.url.searchParams.get('force') === '1';
  const version = deps.action('version');
  const upgrade = deps.action('upgrade');
  if (version instanceof Response) return version;
  if (upgrade instanceof Response) return upgrade;
  const host: ProotActionHost = { run: deps.run, exists: deps.exists };

  if (!force) {
    try {
      const v = await version.run({}, host);
      if (v['installed']) return json({ ok: true, log: { version_local: String(v['version'] ?? ''), note: 'already installed — pass ?force=1 to rebuild' } });
    } catch { /* rebuild if the version check fails */ }
  }

  const actor = await privilegedAction(deps, ctx, {
    operation: PROOT_UPGRADE_OP, bind: { source: PROOT_SOURCE, ref: PROOT_REF, force }, level: 'fresh',
    title: 'Build and install PRoot from source in the master',
    details: [`Source: ${PROOT_SOURCE} (${PROOT_REF}, not pinned)`, `Installs ${BIN} as root; every PRoot app uses it.`],
  });
  if (actor instanceof Response) return actor;

  let log: Record<string, unknown>;
  try {
    log = await upgrade.run({}, host);
  } catch (err) {
    await auditPrivileged(deps, actor, PROOT_UPGRADE_OP, { target: `file:${BIN}`, outcome: 'failed', detail: { source: PROOT_SOURCE, ref: PROOT_REF, force }, error: (err as Error).message });
    return json({ ok: false, error: (err as Error).message, log: (err as { log?: Record<string, string> }).log ?? {} }, 500);
  }
  await auditPrivileged(deps, actor, PROOT_UPGRADE_OP, { target: `file:${BIN}`, outcome: 'ok', detail: { source: PROOT_SOURCE, ref: PROOT_REF, force, version: String(log['version_new'] ?? '') } });
  return json({ ok: true, log });
}
