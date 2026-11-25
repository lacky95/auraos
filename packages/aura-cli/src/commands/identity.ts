import type { Command } from 'commander';
import { color, fail, warn } from '../lib/format.js';
import { shellUrl } from '../lib/client.js';
import { inSandbox, isRunnerShellUrl, isTrustedShellUrl, resolveIdentity, shellFetch } from '../lib/identity.js';
import { issueSetupCode, SetupCodeRefused, type SetupTicketInput } from '../lib/setup-ticket.js';

export type WhoamiResult =
  | { state: 'verified'; identity: Record<string, string>; login?: Record<string, string> }
  | { state: 'unavailable' | 'rejected' | 'unreachable'; status?: number };

const SENSITIVE_FIELD = /token|secret|credential|password|key|cookie/i;

/** Plain fields of the server's answer, never anything secret-shaped. */
function verifiedFields(body: unknown): Record<string, string> {
  const root = (body ?? {}) as Record<string, unknown>;
  return plainFields(root['principal'] && typeof root['principal'] === 'object' ? root['principal'] : root);
}

function plainFields(value: unknown): Record<string, string> {
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (SENSITIVE_FIELD.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

export async function fetchWhoami(): Promise<WhoamiResult> {
  let res: Response;
  try {
    res = await shellFetch('/api/auth/whoami', { intent: 'whoami', signal: AbortSignal.timeout(8_000) });
  } catch {
    return { state: 'unreachable' };
  }
  if (res.status === 401) return { state: 'rejected', status: 401 };
  if (!res.ok) return { state: 'unavailable', status: res.status };
  const body = await res.json().catch(() => null);
  if (body === null) return { state: 'unavailable', status: res.status };
  const login = (body as Record<string, unknown>)['login'];
  return {
    state: 'verified',
    identity: verifiedFields(body),
    ...(login && typeof login === 'object' ? { login: plainFields(login) } : {}),
  };
}

/** What this process can see locally. Hints only, and never a secret value. */
export function localHints(): Record<string, string> {
  const url = shellUrl();
  const sent = resolveIdentity({ url, path: '/api/auth/whoami', intent: 'whoami' });
  const out: Record<string, string> = {
    shell: url,
    'shell trusted': isTrustedShellUrl(url) ? 'yes' : 'no (no implicit credentials are sent)',
    context: inSandbox() ? 'app sandbox' : 'no sandbox detected',
    'instance token': process.env['AURA_INSTANCE_TOKEN']
      ? (isRunnerShellUrl(url) ? 'present' : 'present, withheld from this URL')
      : 'none',
    // shellFetch adds the host operator's ticket when nothing else goes (lib/identity.ts).
    'credential sent': sent.source === 'none' && !inSandbox() && isTrustedShellUrl(url) ? 'operator-ticket' : sent.source,
  };
  const app = process.env['APP_ID'] ?? process.env['AURA_APP_ID'];
  const inst = process.env['APP_INSTANCE_ID'] ?? process.env['AURA_INSTANCE_ID'];
  if (app) out['app (claimed)'] = app;
  if (inst) out['instance (claimed)'] = inst;
  return out;
}

async function printCode(input: SetupTicketInput): Promise<void> {
  let ticket: { code: string; expiresAt: number };
  try {
    ticket = await issueSetupCode(input);
  } catch (err) {
    if (err instanceof SetupCodeRefused) fail(err.message);
    fail('could not create the code.');
    return;
  }
  process.stderr.write(`One-time code, valid until ${new Date(ticket.expiresAt).toISOString()}. It is shown only now:\n`);
  process.stdout.write(`${ticket.code}\n`);
}

export function registerIdentity(program: Command): void {
  program
    .command('whoami')
    .description('Who the shell says you are, shown separately from what this process can see locally.')
    .option('-o, --output <format>', 'json')
    .action(async (opts: { output?: string }) => {
      const server = await fetchWhoami();
      const local = localHints();
      if (opts.output === 'json') {
        console.log(JSON.stringify({ server, local }, null, 2));
        return;
      }
      console.log(color.bold('Verified by the server'));
      if (server.state === 'verified') {
        for (const [k, v] of Object.entries(server.identity)) console.log(`  ${k}: ${v}`);
        if (Object.keys(server.identity).length === 0) console.log('  (no identity fields returned)');
      } else if (server.state === 'unavailable') {
        warn(`  not available (HTTP ${server.status}): the shell could not report a verified identity.`);
      } else if (server.state === 'rejected') {
        warn('  the shell rejected the credential that was sent (401).');
      } else {
        warn(`  cannot reach the shell at ${shellUrl()}.`);
      }
      if (server.state === 'verified' && server.login) {
        console.log(color.bold('Login session (information only, grants no authority)'));
        for (const [k, v] of Object.entries(server.login)) console.log(`  ${k}: ${v}`);
      }
      console.log(color.bold('Local hints (not proof)'));
      for (const [k, v] of Object.entries(local)) console.log(`  ${k}: ${v}`);
    });

  program
    .command('setup-code')
    .description('Host command: create a one-time owner setup code.')
    .action(() => printCode({ purpose: 'setup' }));

  const user = program.command('user').description('Owner account recovery (host commands).');
  user
    .command('reset-password <username>')
    .description('Host command: create a one-time password reset code.')
    .action((username: string) => {
      const name = username.trim();
      if (!name) fail('aura user reset-password <username>');
      return printCode({ purpose: 'reset', username: name });
    });
}

