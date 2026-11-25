// `aura secret ask | ls | rm` (D56) against a fake shell on loopback: the
// secret is never typed here nor printed, `ls` shows no value, and `rm` goes
// through the owner's approval like Settings' Revoke.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { registerSecret } from '../src/commands/secret.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL', 'NO_COLOR'];
const ID = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const HANDLE = 'cred_0123456789abcdefghijkl';
const VALUE = 'ghp_never-reaches-the-cli';

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

/** Run `aura secret …`; everything it printed (stdout and stderr). */
async function run(...args: string[]): Promise<string> {
  const out: string[] = [];
  const [log, err, write] = [console.log, console.error, process.stdout.write];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
  // Recorded and passed on: the test runner's own report also goes to stdout meanwhile.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out.push(String(chunk));
    return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  const program = new Command();
  program.exitOverride();
  registerSecret(program);
  try {
    await program.parseAsync(['node', 'aura', 'secret', ...args]);
  } catch (e) {
    throw Object.assign(e as Error, { output: out.join('\n') });
  } finally {
    console.log = log; console.error = err; process.stdout.write = write;
  }
  return out.join('\n');
}

const NEEDS = { ok: false, error: 'needs-approval', needsApproval: true, approvalId: ID, level: 'session', display: { title: 'Revoke the secret GITHUB_TOKEN', details: [], requestedBy: 'Terminal (com.aura.terminal-1)' } };

test('ask: the owner types the secret in the desktop; the CLI prints only the handle', async () => {
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/credentials/requests') {
      return [201, { id: ID, action: 'credential.store', level: 'session', state: 'pending', expiresAt: Date.now() + 60_000, display: { title: 'Enter the secret GITHUB_TOKEN', details: ['For Notes'], requestedBy: 'Terminal' } }];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${ID}`) return [200, { id: ID, state: 'approved' }];
    if (r.method === 'POST' && r.url === `/api/credentials/requests/${ID}`) return [200, { handle: HANDLE, name: 'GITHUB_TOKEN' }];
    return [404, {}];
  });
  const out = await run('ask', 'GITHUB_TOKEN', '--for', 'com.example.notes', '--purpose', 'Push notes');
  assert.deepEqual(seen[0]!.body, { name: 'GITHUB_TOKEN', scope: { app: 'com.example.notes' }, purpose: 'Push notes' });
  assert.ok(seen.every((r) => !JSON.stringify(r.body).includes(VALUE)), 'the CLI never sends a secret');
  assert.deepEqual(seen[2]!.body, { name: 'GITHUB_TOKEN', scope: { app: 'com.example.notes' } });
  assert.match(out, new RegExp(`^${HANDLE}$`, 'm'));
  assert.match(out, /never passes through this terminal/);
});

test('ask: a denied request prints no handle and exits 1; a bad name never reaches the shell', async () => {
  const seen = await fakeShell((r) => (r.method === 'POST'
    ? [201, { id: ID, level: 'session', display: { title: 't', details: [], requestedBy: 'r' } }]
    : [200, { id: ID, state: 'denied' }]));
  await assert.rejects(run('ask', 'GITHUB_TOKEN'), (e: Error & { output?: string }) => /exit 1/.test(e.message) && /not stored: denied/.test(e.output ?? ''));
  assert.equal(seen.filter((r) => r.url.startsWith('/api/credentials/requests/')).length, 0, 'nothing collected');
  const before = seen.length;
  await assert.rejects(run('ask', 'github-token'), /exit 1/);
  assert.equal(seen.length, before);
});

test('ls: names, apps and last use after the owner approves the read; never a value or a handle', async () => {
  const at = Date.UTC(2026, 10, 25, 12, 0, 0);
  const seen = await fakeShell((r) => {
    if (r.method === 'GET' && r.url === '/api/admin/credentials') {
      return r.approval === ID
        ? [200, { credentials: [
          { name: 'GITHUB_TOKEN', label: 'GitHub token', createdAt: at, updatedAt: at, consumers: [{ appId: 'com.example.notes', name: 'Notes', since: at, canRead: true }, { appId: 'com.example.spy', since: at, canRead: false }], lastUsedAt: at, lastUsedBy: 'com.example.notes' },
          { name: 'OPENAI_KEY', createdAt: at, updatedAt: at, consumers: [] },
        ] }]
        : [202, { ...NEEDS, display: { title: 'Show your secrets (names and use, no values)', details: [], requestedBy: 'Terminal' } }];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${ID}`) return [200, { id: ID, state: 'approved' }];
    return [404, {}];
  });
  const out = await run('ls');
  const lists = seen.filter((r) => r.url === '/api/admin/credentials');
  assert.deepEqual(lists.map((r) => r.approval), [undefined, ID], 'asked, then the same read with the approval');
  assert.match(out, /NAME\s+LABEL\s+APPS\s+LAST-USED/);
  assert.match(out, /GITHUB_TOKEN\s+GitHub token\s+com\.example\.notes \(reads\), com\.example\.spy\s+2026-11-25 12:00:00Z by com\.example\.notes/);
  assert.match(out, /OPENAI_KEY\s+none\s+never/);
  assert.doesNotMatch(out, /cred_[0-9a-z]|ghp_/);
});

test('ls: an empty vault', async () => {
  await fakeShell(() => [200, { credentials: [] }]);
  assert.match(await run('ls'), /no secrets in your vault/);
});

test('rm: the whole secret, or one app\'s access, each through the owner\'s approval (the Settings Revoke route)', async () => {
  const seen = await fakeShell((r) => {
    if (r.method === 'DELETE' && r.url.startsWith('/api/admin/credentials/')) {
      return r.approval === ID ? [200, { ok: true, removed: !r.url.includes('OPENAI_KEY') }] : [202, NEEDS];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${ID}`) return [200, { id: ID, state: 'approved' }];
    return [404, {}];
  });
  assert.match(await run('rm', 'GITHUB_TOKEN', '--app', 'com.example.notes'), /revoked com\.example\.notes's access to GITHUB_TOKEN/);
  assert.match(await run('rm', 'GITHUB_TOKEN'), /revoked the secret GITHUB_TOKEN/);
  assert.match(await run('rm', 'OPENAI_KEY'), /nothing to revoke: no secret OPENAI_KEY/);
  const dels = seen.filter((r) => r.method === 'DELETE');
  assert.deepEqual(dels.map((r) => [r.url, r.approval ?? null]), [
    ['/api/admin/credentials/GITHUB_TOKEN?app=com.example.notes', null],
    ['/api/admin/credentials/GITHUB_TOKEN?app=com.example.notes', ID],
    ['/api/admin/credentials/GITHUB_TOKEN', null],
    ['/api/admin/credentials/GITHUB_TOKEN', ID],
    ['/api/admin/credentials/OPENAI_KEY', null],
    ['/api/admin/credentials/OPENAI_KEY', ID],
  ]);
});

test('rm: a denied approval revokes nothing; bad input never reaches the shell', async () => {
  const seen = await fakeShell((r) => (r.method === 'GET' ? [200, { id: ID, state: 'denied' }] : [202, NEEDS]));
  await assert.rejects(run('rm', 'GITHUB_TOKEN'), /not approved: denied/);
  assert.deepEqual(seen.filter((r) => r.method === 'DELETE').map((r) => r.approval ?? null), [null]);
  const before = seen.length;
  await assert.rejects(run('rm', 'not a name'), /exit 1/);
  await assert.rejects(run('rm', 'GITHUB_TOKEN', '--app', '../x'), /exit 1/);
  assert.equal(seen.length, before);
});
