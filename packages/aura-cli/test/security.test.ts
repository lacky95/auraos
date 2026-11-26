// `aura admin security [list] | set` (D64) against a fake shell on loopback:
// the list shows every option's value and source; `set` waits for the
// owner's fresh approval in the desktop and sends the same change again.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { registerAdmin } from '../src/commands/admin.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL', 'NO_COLOR'];
const ID = 'apr_AAAAAAAAAAAAAAAAAAAAAA';

interface Seen { method: string; url: string; body: Record<string, unknown>; approval?: string; auth?: string }
type Handler = (r: Seen) => [number, unknown];
const servers: http.Server[] = [];
const saved: Record<string, string | undefined> = {};
const originalExit = process.exit;

async function fakeShell(handler: Handler): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rec: Seen = {
      method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {},
      ...(typeof req.headers['x-aura-approval'] === 'string' ? { approval: req.headers['x-aura-approval'] } : {}),
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    };
    seen.push(rec);
    const [status, body] = handler(rec);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  process.env['AURA_SHELL_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return seen;
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env['NO_COLOR'] = '1';
  // In the System Terminal: the CLI carries its instance token.
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.exit = originalExit;
  for (const s of servers.splice(0)) s.close();
});

async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const [log, err, write] = [console.log, console.error, process.stdout.write];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out.push(String(chunk));
    return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  const program = new Command();
  program.exitOverride();
  registerAdmin(program);
  try {
    await program.parseAsync(['node', 'aura', 'admin', 'security', ...args]);
  } catch (e) {
    throw Object.assign(e as Error, { output: out.join('\n') });
  } finally {
    console.log = log; console.error = err; process.stdout.write = write;
  }
  return out.join('\n');
}

const OPTIONS = [
  { id: 'fresh-auth-require-https', title: 'Require HTTPS for password confirmations', value: false, source: 'policy', effectiveSource: 'default', writable: true },
  { id: 'access-enforce', title: 'Access enforcement', value: 'enforce', source: 'env', env: 'AURA_ACCESS_ENFORCE', effectiveSource: 'env AURA_ACCESS_ENFORCE', writable: false },
  { id: 'access-profile', title: 'Access profile', value: 'open', source: 'reserved', effectiveSource: 'reserved', writable: false },
];

test('list: every option with its value and where it comes from', async () => {
  await fakeShell((r) => (r.method === 'GET' && r.url === '/api/admin/security-options' ? [200, { options: OPTIONS }] : [404, {}]));
  const out = await run();
  assert.match(out, /fresh-auth-require-https\s+off\s+default\s+aura admin security set/);
  assert.match(out, /access-enforce\s+enforce\s+env AURA_ACCESS_ENFORCE\s+AURA_ACCESS_ENFORCE on the host/);
  assert.match(out, /access-profile\s+open\s+reserved\s+not yet available/);
  assert.match(await run('options'), /fresh-auth-require-https/);
  const json = JSON.parse(await run('-o', 'json'));
  assert.deepEqual(json.map((o: { id: string }) => o.id), OPTIONS.map((o) => o.id), '`aura admin security -o json` (diagnose reads it)');
});

test('set: asks the owner (fresh), then sends the same change with the approval', async () => {
  const NEEDS = { ok: false, error: 'needs-approval', needsApproval: true, approvalId: ID, level: 'fresh', display: { title: 'Require HTTPS for password confirmations: off → on', details: [], requestedBy: 'Terminal (com.aura.terminal-1)' } };
  const seen = await fakeShell((r) => {
    if (r.method === 'PUT' && r.url === '/api/admin/security-options') {
      return r.approval === ID ? [200, { ok: true, changed: true, option: { ...OPTIONS[0], value: true, effectiveSource: 'policy' } }] : [202, NEEDS];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${ID}`) return [200, { id: ID, state: 'approved' }];
    return [404, {}];
  });
  const out = await run('set', 'fresh-auth-require-https', 'on');
  const puts = seen.filter((r) => r.method === 'PUT');
  assert.deepEqual(puts.map((r) => [r.body, r.approval]), [
    [{ id: 'fresh-auth-require-https', value: true }, undefined],
    [{ id: 'fresh-auth-require-https', value: true }, ID],
  ]);
  assert.match(out, /fresh-auth-require-https = on/);
});

test('set: an env option is refused with where to set it', async () => {
  await fakeShell(() => [409, { error: 'set-on-host', message: 'Set on the host: AURA_ACCESS_ENFORCE in compose/.env, then restart.' }]);
  await assert.rejects(run('set', 'access-enforce', 'enforce'), /AURA_ACCESS_ENFORCE in compose\/\.env/);
});
