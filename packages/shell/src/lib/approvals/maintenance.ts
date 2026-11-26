/**
 * The owner's maintenance routes that took no approval before 5-main (SF-2
 * report, P2 review): repairing the toolchain (`aura cap doctor --fix`),
 * refreshing an app's tool allowlist, reaping orphan app processes and
 * replacing the `aura` CLI with its wrapper script. None takes a command,
 * arguments or a definition from the caller; each changes the running system,
 * so each is the owner's (lib/approvals/admin.ts `ownerAction`): the owner in
 * the desktop and the host operator act directly; Settings and `aura` in the
 * System Terminal ask (202 needs-approval) and send the same request again.
 *
 * Levels (D9): `session` (one click). None grants a privileged permission,
 * Docker or every tool, a privileged sidecar or an API key: they re-apply what
 * is already installed and granted, or stop processes no instance tracks.
 *
 * One builder per route: the payload is exactly what the approval binds, from
 * the validated request.
 */
import * as core from '@aura/core';
import type { AdminRequest } from './admin.ts';

/** A capability (toolchain binary) name, as the registry allows it. */
const CAP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export type Invalid = { invalid: string };

/** POST /api/admin/cap-doctor `{ names?, refreshOnly? }`: re-stage libraries, refresh running apps. */
export function capDoctorFixRequest(body: unknown): { req: AdminRequest; names: string[]; refreshOnly: boolean } | Invalid {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { names?: unknown; refreshOnly?: unknown };
  if (b.names !== undefined && (!Array.isArray(b.names) || !b.names.every((n) => typeof n === 'string' && CAP_NAME_RE.test(n)))) {
    return { invalid: 'names must be a list of capability names' };
  }
  if (b.refreshOnly !== undefined && typeof b.refreshOnly !== 'boolean') return { invalid: 'refreshOnly must be a boolean' };
  const names = [...new Set((b.names as string[] | undefined) ?? [])].sort();
  const refreshOnly = b.refreshOnly === true;
  const what = refreshOnly ? 'nothing re-staged'
    : names.length ? names.join(', ') : 'every installed capability';
  return {
    names, refreshOnly,
    req: {
      action: 'admin.change', level: 'session', payload: { op: 'cap.doctor-fix', names, refreshOnly },
      title: refreshOnly ? 'Refresh the tools of every running app' : 'Repair the shared libraries of capabilities',
      details: [
        `Capabilities: ${what}.`,
        'Re-links libraries already in the toolchain store; installs nothing (no apt, no npm).',
        'Then refreshes the tool allowlists of running apps.',
      ],
    },
  };
}

/** POST /api/admin/cap-refresh `{ appId }`: re-apply an app's granted tools to its running instances. */
export function capRefreshRequest(body: unknown): { req: AdminRequest; appId: string } | Invalid {
  const appId = (body && typeof body === 'object' ? (body as { appId?: unknown }).appId : undefined);
  if (typeof appId !== 'string' || !core.APP_ID_PATTERN.test(appId)) return { invalid: '`appId` required' };
  return {
    appId,
    req: {
      action: 'admin.change', level: 'session', payload: { op: 'cap.refresh', appId },
      title: `Refresh the tools of the running instances of ${appId}`,
      details: ['Re-applies the tools the app already has; grants nothing new.'],
    },
  };
}

/** POST /api/admin/reap-orphans[?dryRun=1]: list (a read) or kill app processes no instance tracks. */
export function reapOrphansRequest(dryRun: boolean): AdminRequest {
  return dryRun
    ? { action: 'admin.read', level: 'session', payload: { op: 'os.reap-orphans', dryRun: true }, title: 'List app processes no instance tracks' }
    : {
      action: 'admin.change', level: 'session', payload: { op: 'os.reap-orphans', dryRun: false },
      title: 'Kill app processes no instance tracks',
      details: ['Orphan app processes get SIGKILL; tracked instances whose process is gone are marked failed.'],
    };
}

/** POST /api/admin/install-aura-shim: replace the toolchain's `aura` with the wrapper script. */
export function installAuraShimRequest(targets: readonly string[]): AdminRequest {
  return {
    action: 'admin.change', level: 'session', payload: { op: 'os.install-aura-shim' },
    title: 'Replace the aura CLI with its wrapper script',
    details: [`Rewrites ${targets.join(' and ')} (a fixed script that runs the bundled CLI).`],
  };
}
