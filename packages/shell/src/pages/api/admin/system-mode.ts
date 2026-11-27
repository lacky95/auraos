import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { json } from '../../../lib/approvals/service.ts';
import {
  exportPatches, moveToDevBranch, systemModeState, workspaceTree, writeSystemMode, type WorkspaceTree,
} from '../../../lib/systemMode.ts';

/**
 * The system mode (D30, D60; lib/systemMode.ts). Docs: developer-mode.
 *
 *   GET             → { mode, configured, env, default, normalEnforced, workspaceMounts }
 *   GET ?tree=1     → + { tree }: what differs between /workspace and the release
 *   PUT { mode: 'developer' }
 *        → the owner confirms with the password (`fresh`): in the shell's
 *          dialog (Settings → System, or `aura mode developer` from the System
 *          Terminal), or the host operator (`aura mode developer` / `aura
 *          approve` on the host, D12, D18). The desktop session alone is not
 *          enough (D1).
 *   PUT { mode: 'normal', cleanup?: 'branch' }
 *        → the clean-tree flow (D4): a tree that differs from the release is
 *          409 tree-not-clean with the list and the recommendations, in
 *          order: (a) commit or clean up, (b) save the changes as patch files
 *          (POST export-patches), (c) `cleanup: 'branch'`, the automatic
 *          clean-up (a `dev/<date>` branch, a 30-day backup, reset to the
 *          release), which needs the password. Every `aura mount workspace`
 *          is detached. One click otherwise.
 *   POST { action: 'export-patches' } → { dir, files } (one click)
 *
 * Normal mode is recorded and shown, not enforced: AuraOS keeps running from
 * /workspace until Phase 6.
 */
interface Body { mode?: unknown; cleanup?: unknown; action?: unknown }

const RECOMMEND = [
  { step: 'a', what: 'Make the tree clean: commit and push your work, or discard it (git stash, git checkout, git clean).' },
  { step: 'b', what: 'Save the changes as patch files in /data/aura/dev-patches/<date>/ (aura mode export-patches), then clean up.' },
  { step: 'c', what: 'Automatic clean-up, only if you choose it: everything moves to a dev/<date> branch, a backup is kept for 30 days, the checkout is reset to the release (aura mode normal --move-to-branch).' },
];

function workspaceMounts(): Array<{ instanceId: string; containerPath: string }> {
  try {
    return core.getAppManager().mounts.workspaceMounts().map((m) => ({ instanceId: m.instanceId, containerPath: m.containerPath }));
  } catch { return []; }
}

/**
 * Developer Mode is off: no Terminal keeps the checkout (D60), and every
 * idmapped writable source mount into another uid is made read-only again
 * (D80, owner answer 4: leaving Developer Mode revokes that writable access).
 */
async function detachWorkspaceMounts(): Promise<string[]> {
  const detached: string[] = [];
  let mounts: core.AuraMount[] = [];
  try {
    const revoked = await core.getAppManager().mounts.revokeWritable((m) => m.kind === 'source' && !!m.idmap);
    if (revoked.length) console.log(`[system-mode] Developer Mode off: writable source mounts made read-only: ${revoked.join(', ')}`);
  } catch (err) { console.warn(`[system-mode] could not revoke writable source mounts: ${(err as Error).message}`); }
  try { mounts = core.getAppManager().mounts.workspaceMounts(); } catch { return detached; }
  for (const m of mounts) {
    try { await core.getAppManager().mounts.remove(m.instanceId, m.id); detached.push(m.instanceId); }
    catch (err) { console.warn(`[system-mode] could not detach the workspace from ${m.instanceId}: ${(err as Error).message}`); }
  }
  return detached;
}

const differs = (t: WorkspaceTree): string[] => [
  ...(t.counts.uncommitted ? [`${t.counts.uncommitted} file(s) with uncommitted changes`] : []),
  ...(t.counts.untracked ? [`${t.counts.untracked} untracked file(s)`] : []),
  ...(t.counts.localCommits ? [`${t.counts.localCommits} local commit(s) not in ${t.release?.ref ?? 'the release'}`] : []),
];

export const GET: APIRoute = ({ url }) => json({
  ...systemModeState(),
  workspaceMounts: workspaceMounts(),
  ...(url.searchParams.get('tree') === '1' ? { tree: workspaceTree() } : {}),
});

export const PUT: APIRoute = async (ctx) => {
  let body: Body;
  try { body = await ctx.request.json() as Body; } catch { return json({ error: 'body must be JSON: { mode }' }, 400); }
  if (body.mode !== 'developer' && body.mode !== 'normal') return json({ error: "mode must be 'developer' or 'normal'" }, 400);
  if (body.cleanup !== undefined && body.cleanup !== 'branch') return json({ error: "cleanup must be 'branch'" }, 400);
  const before = systemModeState();

  if (body.mode === 'developer') {
    if (body.cleanup !== undefined) return json({ error: 'cleanup applies to switching off' }, 400);
    const actor = await ownerAction(ctx, {
      action: 'admin.change', level: 'fresh', payload: { op: 'system-mode', mode: 'developer' },
      title: 'Turn on Developer Mode',
      details: [
        'AuraOS runs from its /workspace checkout, and the System Terminal can mount it writable (aura mount workspace).',
        'aura dev rebuild and aura dev restart become available.',
        'The desktop shows a Developer mode indicator until you turn it off.',
      ],
      confirmed: { where: 'Turn Developer Mode on in Settings → System (your password confirms it), or on the host: docker exec -it aura-shell aura mode developer' },
    });
    if (actor instanceof Response) return actor;
    const state = writeSystemMode('developer');
    await auditOwner(actor, 'system-mode.developer', { detail: { before: before.mode } });
    return json({ ok: true, ...state, workspaceMounts: workspaceMounts() });
  }

  // Off: the clean-tree flow.
  const tree = workspaceTree();
  const cleanup = body.cleanup === 'branch';
  if (!tree.clean && !cleanup) {
    return json({
      ok: false, error: 'tree-not-clean',
      message: `/workspace differs from the release: ${differs(tree).join(', ')}.`,
      tree, recommend: RECOMMEND,
    }, 409);
  }
  if (cleanup && tree.clean) return json({ error: 'nothing-to-clean', message: 'The tree is clean: switch off without cleanup.' }, 400);
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: cleanup ? 'fresh' : 'session',
    // HEAD binds the approval to the tree it was shown for.
    payload: { op: 'system-mode', mode: 'normal', cleanup, head: tree.head },
    title: cleanup ? 'Turn off Developer Mode and clean up /workspace' : 'Turn off Developer Mode',
    details: [
      ...(cleanup ? [
        `Moves ${differs(tree).join(', ')} to a new dev/<date> branch, keeps a backup for 30 days, and resets /workspace to ${tree.release?.ref ?? 'the release'}.`,
      ] : []),
      'Detaches every writable /workspace mount (aura mount workspace).',
      'Normal mode is recorded and shown; AuraOS keeps running from /workspace until Phase 6.',
    ],
  });
  if (actor instanceof Response) return actor;
  let moved: ReturnType<typeof moveToDevBranch> | null = null;
  if (cleanup) {
    try { moved = moveToDevBranch(); }
    catch (err) {
      await auditOwner(actor, 'system-mode.normal', { outcome: 'failed', detail: { cleanup, error: (err as Error).message } });
      return json({ ok: false, error: 'cleanup-failed', message: (err as Error).message }, 409);
    }
  }
  const detached = await detachWorkspaceMounts();
  const state = writeSystemMode('normal');
  await auditOwner(actor, 'system-mode.normal', {
    detail: { before: before.mode, detached, ...(moved ? { branch: moved.branch, backup: moved.backup } : {}) },
  });
  return json({ ok: true, ...state, detached, ...(moved ? { cleanup: moved } : {}) });
};

export const POST: APIRoute = async (ctx) => {
  let body: Body;
  try { body = await ctx.request.json() as Body; } catch { return json({ error: 'body must be JSON: { action }' }, 400); }
  if (body.action !== 'export-patches') return json({ error: "action must be 'export-patches'" }, 400);
  const tree = workspaceTree();
  if (tree.clean) return json({ ok: true, dir: null, files: [], message: 'The tree is clean: nothing to save.' });
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'system-mode.export-patches', head: tree.head },
    title: 'Save the Developer Mode changes as patch files',
    details: [`Writes ${differs(tree).join(', ')} to /data/aura/dev-patches/<date>/. /workspace is not changed.`],
  });
  if (actor instanceof Response) return actor;
  try {
    const out = exportPatches();
    await auditOwner(actor, 'system-mode.export-patches', { detail: { dir: out.dir, files: out.files.length } });
    return json({ ok: true, ...out });
  } catch (err) {
    return json({ ok: false, error: 'export-failed', message: (err as Error).message }, 500);
  }
};
