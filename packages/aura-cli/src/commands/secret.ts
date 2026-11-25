/**
 * `aura secret ask <name> --for <app> --purpose …` (D56): ask the owner for a
 * secret an app will use. The owner types it into the AuraOS desktop's own
 * dialog, never into this terminal, and AuraOS keeps it in the owner's
 * personal vault. This prints only the handle (on stdout, for scripts), which
 * the app keeps; the app reads the value on its server with the owner's
 * separate approval (`osClient.credentials.get`).
 *
 *   aura secret ask GITHUB_TOKEN --for com.example.notes --purpose "Push notes to GitHub"
 *
 * Run it in an app sandbox (the System Terminal): the request carries its
 * instance token, and the app needs `credentials.request`.
 *
 * `aura secret ls` lists the vault: names, the apps holding a handle (and
 * whether each may read the value) and the last use, never a value or a
 * handle. `aura secret rm <NAME> [--app <app>]` revokes a secret, or only one
 * app's access to it. Both are the owner's calls (GET/DELETE
 * /api/admin/credentials, the routes Settings uses): from the System Terminal
 * the owner approves each in the desktop, like Settings' Revoke (lib/client.ts);
 * on the host the operator acts directly.
 */
import type { Command } from 'commander';
import { approvalLines, postJson, waitForApproval, type ApprovalView } from '../lib/approval.js';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table } from '../lib/format.js';
import { fmtTime } from './admin.js';

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface Asked extends Partial<ApprovalView> { error?: string; message?: string }

/** A row of GET /api/admin/credentials (shell lib/credentials.ts `listCredentials`). */
interface CredentialRow {
  name: string;
  label?: string;
  consumers: Array<{ appId: string; name?: string; canRead?: boolean }>;
  lastUsedAt?: number;
  lastUsedBy?: string;
}

export function registerSecret(program: Command): void {
  const secret = program.command('secret').description('Secrets in your personal vault (D56)');
  secret
    .command('ask <name>')
    .description('Ask the owner to type a secret for an app into the AuraOS dialog; prints its handle')
    .option('--for <app>', 'the app that uses it (default: the app this CLI runs in)')
    .option('--purpose <text>', 'why it is needed, shown to the owner as your words')
    .option('--label <text>', 'what it is, e.g. "GitHub token"')
    .option('--wait <ms>', 'give up after this long (default: until the request expires)')
    .action(async (name: string, o: { for?: string; purpose?: string; label?: string; wait?: string }) => {
      if (!NAME_RE.test(name)) fail('aura secret ask <NAME>   (A-Z, 0-9 and _, like GITHUB_TOKEN)');
      const scope = o.for ? { app: o.for } : 'app';
      const asked = await postJson<Asked>('/api/credentials/requests', {
        name, scope, ...(o.purpose ? { purpose: o.purpose } : {}), ...(o.label ? { label: o.label } : {}),
      });
      if (asked.error || !asked.id) fail(asked.message ?? asked.error ?? 'the request was refused');
      if (asked.display) for (const line of approvalLines({ display: asked.display, level: asked.level ?? 'session' })) info(line);
      info('Type the secret into the AuraOS desktop\'s dialog; it never passes through this terminal. Waiting…');
      const limit = o.wait ? Number(o.wait) : NaN;
      const state = Number.isFinite(limit) && limit > 0
        ? await Promise.race([waitForApproval(asked.id!), new Promise<'expired'>((r) => setTimeout(() => r('expired'), limit).unref())])
        : await waitForApproval(asked.id!);
      if (state !== 'approved') fail(`not stored: ${state}`);
      const got = await postJson<{ handle?: string; name?: string; error?: string; message?: string }>(
        `/api/credentials/requests/${encodeURIComponent(asked.id!)}`, { name, scope },
      );
      if (!got.handle) fail(got.message ?? got.error ?? 'no handle');
      info(`${got.name} is in your vault. The app reads it with this handle (the owner approves its first read):`);
      process.stdout.write(`${got.handle}\n`);
    });

  secret
    .command('ls')
    .alias('list')
    .description('List your secrets: names, the apps using them, last use (never a value)')
    .action(async () => {
      const { credentials } = await api.get<{ credentials: CredentialRow[] }>('/api/admin/credentials');
      if (credentials.length === 0) { info('no secrets in your vault'); return; }
      console.log(table(credentials.map((c) => ({
        NAME: c.name,
        LABEL: c.label ?? '',
        APPS: c.consumers.length
          ? c.consumers.map((a) => `${a.appId}${a.canRead ? ' (reads)' : ''}`).join(', ')
          : color.dim('none'),
        'LAST-USED': c.lastUsedAt ? `${fmtTime(c.lastUsedAt)}${c.lastUsedBy ? ` by ${c.lastUsedBy}` : ''}` : color.dim('never'),
      })), ['NAME', 'LABEL', 'APPS', 'LAST-USED']));
    });

  secret
    .command('rm <name>')
    .alias('revoke')
    .description('Revoke a secret (the value, every handle and read access), or with --app only that app\'s access')
    .option('--app <app>', 'revoke only this app\'s handle and read access; the secret stays')
    .action(async (name: string, o: { app?: string }) => {
      if (!NAME_RE.test(name)) fail('aura secret rm <NAME> [--app <app>]   (A-Z, 0-9 and _, like GITHUB_TOKEN)');
      if (o.app !== undefined && !APP_ID_RE.test(o.app)) fail(`invalid app id '${o.app}'`);
      const query = o.app ? `?app=${encodeURIComponent(o.app)}` : '';
      const r = await api.del<{ removed: boolean }>(`/api/admin/credentials/${encodeURIComponent(name)}${query}`);
      const what = o.app ? `${color.bold(o.app)}'s access to ${color.bold(name)}` : `the secret ${color.bold(name)}`;
      if (r.removed) ok(`revoked ${what}`);
      else info(`nothing to revoke: ${o.app ? `${o.app} has no access to ${name}` : `no secret ${name}`}`);
    });
}
