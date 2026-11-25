/**
 * `aura approve <id>`: the host operator decides a pending approval (D18),
 * e.g. a `fresh` one requested over HTTP, where the desktop cannot take the
 * password. Host only: it proves itself with an operator code, a one-time
 * ticket file that no app sandbox can write.
 *
 *   aura approve <id>            show the request, ask, approve
 *   aura approve <id> --deny     deny it
 *   aura approve <id> -y         approve without asking
 *   aura approve --unblock <app> lift "Deny and block requests from this app"
 */
import type { Command } from 'commander';
import { approvalLines, operatorCode, postJson, type ApprovalView } from '../lib/approval.js';
import { color, fail, info, ok } from '../lib/format.js';
import { promptConfirm, PromptCancelled } from '../lib/prompts.js';
import { SetupCodeRefused } from '../lib/setup-ticket.js';
import { shellFetch } from '../lib/identity.js';

const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{22}$/;

async function code(subject: string): Promise<string> {
  try {
    return await operatorCode(subject);
  } catch (err) {
    if (err instanceof SetupCodeRefused) fail(`aura approve ${err.message}`);
    throw err;
  }
}

export function registerApprove(program: Command): void {
  program
    .command('approve [id]')
    .description('Approve (or --deny) a pending owner approval as the host operator. Host only.')
    .option('--deny', 'deny it instead')
    .option('-y, --yes', 'do not ask')
    .option('--unblock <appId>', 'let this app ask for approvals again')
    .action(async (id: string | undefined, o: { deny?: boolean; yes?: boolean; unblock?: string }) => {
      if (o.unblock) {
        const operator = await code(`unblock:${o.unblock}`);
        const res = await shellFetch(`/api/approvals/blocked/${encodeURIComponent(o.unblock)}`, {
          method: 'DELETE', intent: 'admin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operatorCode: operator }),
        });
        const out = await res.json().catch(() => ({})) as { removed?: boolean; error?: string };
        if (!res.ok) fail(out.error ?? `HTTP ${res.status}`);
        ok(out.removed ? `${o.unblock} may ask for approvals again` : `${o.unblock} was not blocked`);
        return;
      }
      if (!id || !APPROVAL_ID_RE.test(id)) fail('aura approve <id>   (the id looks like apr_…, as the requester printed it)');
      const decision = o.deny ? 'deny' : 'approve';
      const path = `/api/approvals/${encodeURIComponent(id!)}/${decision}`;
      const operator = await code(`${decision}:${id}`);

      const view = await postJson<ApprovalView & { error?: string; message?: string }>(path, { operatorCode: operator, preview: true }, { intent: 'admin' });
      if (view.error) fail(view.message ?? view.error);
      for (const line of approvalLines(view)) info(line);
      if (view.state !== 'pending') fail(`it is ${view.state}`);
      if (!o.yes) {
        if (!process.stdin.isTTY) fail(`pass -y to ${decision} without a prompt`);
        try {
          if (await promptConfirm(`${decision === 'approve' ? 'Approve' : 'Deny'} this?`, false) !== true) { info('nothing changed'); return; }
        } catch (err) {
          if (err instanceof PromptCancelled) { info('nothing changed'); return; }
          throw err;
        }
      }
      const res = await postJson<{ ok?: boolean; state?: string; error?: string; message?: string }>(path, { operatorCode: operator }, { intent: 'admin' });
      if (!res.ok) fail(res.message ?? res.error ?? 'failed');
      ok(`${color.cyan(id!)} ${res.state}`);
    });
}
