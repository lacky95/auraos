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
 */
import type { Command } from 'commander';
import { approvalLines, postJson, waitForApproval, type ApprovalView } from '../lib/approval.js';
import { fail, info } from '../lib/format.js';

const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

interface Asked extends Partial<ApprovalView> { error?: string; message?: string }

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
}
