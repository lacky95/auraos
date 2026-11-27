/**
 * `aura admin overlay …` (Phase 6 O): the one-shot migration of local grant edits into the
 * settings overlay (`/data/aura/overlay`).
 *
 *   aura admin overlay report [-o json]   what it would do (read-only): per system app the grant
 *                                         fields its local edit moves (tools, services[].tools,
 *                                         permissions) and every other field kept in place; the
 *                                         capability registry's local edits and backup; a digest
 *   aura admin overlay apply <digest>     exactly that report (the owner approves; on the host
 *                                         it runs directly)
 */
import type { Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';

interface Report {
  mode: 'developer' | 'release';
  head: string | null;
  apps: Array<{ appId: string; fields: string[]; otherFields: string[]; restore: boolean }>;
  registry: Array<{ file: string; tracked: boolean; added: string[]; changed: string[]; removed: string[]; action: string }>;
  fields: string[];
  otherFields: string[];
  digest: string;
}

function refusal(err: unknown): string {
  const body = (err as ShellError).body;
  if (body) {
    try { const b = JSON.parse(body) as { message?: string; error?: string }; return b.message ?? b.error ?? body; }
    catch { return body; }
  }
  return (err as Error).message;
}

export function registerAdminOverlay(admin: Command): void {
  const overlay = admin.command('overlay').description('The settings overlay (Phase 6): move local grant edits of system manifests and the capability registry into /data/aura/overlay, once.');

  overlay
    .command('report')
    .description('What the migration would move (read-only), and the digest `apply` takes.')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      let r: Report;
      try { r = await api.get<Report>('/api/admin/overlay'); }
      catch (err) {
        if ((err as ShellError).status === 404) fail('this shell has no settings overlay yet (Phase 6).');
        fail(refusal(err));
      }
      if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
      if (r.mode === 'release') { ok('this install runs from a release: nothing to migrate'); return; }
      if (r.apps.length === 0 && r.registry.length === 0) { ok(`nothing to migrate (checkout ${r.head?.slice(0, 12) ?? '?'} is clean)`); return; }
      if (r.apps.length) {
        console.log(table(r.apps.map((a) => ({
          APP: a.appId,
          MOVES: a.fields.join(', ') || color.dim('-'),
          'KEPT IN PLACE': a.otherFields.join(', ') || color.dim('-'),
          MANIFEST: a.restore ? 'restored' : color.yellow('left modified'),
        }))));
      }
      for (const x of r.registry) {
        const names = [...x.added.map((n) => `+${n}`), ...x.changed.map((n) => `~${n}`), ...x.removed.map((n) => `-${n}`)];
        const what = names.length ? names.join(' ') : 'no entries beyond the release';
        if (x.action === 'move-aside') info(`${x.file}: an untracked backup (${what}); moved aside into /data/aura/overlay/migrated`);
        else warn(`${x.file}: edited in place (${what}); left as is. Add your entries with \`aura cap registry add\`, then restore the file.`);
      }
      info(`fields moved: ${r.fields.join(', ') || 'none'}${r.otherFields.length ? `; other fields: ${r.otherFields.join(', ')}` : ''}`);
      info(`a report: nothing was changed. Apply exactly this: aura admin overlay apply ${r.digest}`);
    });

  overlay
    .command('apply <digest>')
    .description('Apply the report you reviewed (its digest): writes the overlay, restores the manifests it moved, moves the registry backup aside.')
    .option('-o, --output <format>', 'json')
    .action(async (digest: string, opts: { output?: string }) => {
      if (!/^[0-9a-f]{64}$/.test(digest)) fail('apply takes the digest `aura admin overlay report` printed');
      let r: { overlays: string[]; restored: string[]; movedAside: Array<{ file: string; to: string }>; reloadErrors?: string[] };
      try { r = await api.post('/api/admin/overlay', { digest }); }
      catch (err) { fail(`overlay apply: ${refusal(err)}`); }
      if (opts.output === 'json') { console.log(JSON.stringify(r, null, 2)); return; }
      ok(`overlay written for ${r.overlays.length} app(s)${r.overlays.length ? `: ${r.overlays.join(', ')}` : ''}`);
      if (r.restored.length) ok(`manifests restored: ${r.restored.join(', ')}`);
      for (const m of r.movedAside) ok(`${m.file} moved to ${m.to}`);
      for (const e of r.reloadErrors ?? []) warn(`reload: ${e}`);
    });
}
