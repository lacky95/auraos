// D102 in the CLI: a request the owner put on hold (Later). A non-interactive
// caller (an agent) gets a structured `on_hold` result and exit code 75; with
// AURA_WAIT_ON_HOLD=1 (or a terminal) it keeps waiting. Re-running resumes
// the same request; a denial carries the owner's optional feedback; Ctrl-C
// withdraws. Against a fake shell on loopback.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { registerSecret } from '../src/commands/secret.js';
import { askOwner, EXIT_ON_HOLD, waitForApproval, withdrawApproval } from '../src/lib/approval.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_WAIT_ON_HOLD', 'NO_COLOR'];
const ID = 'apr_BBBBBBBBBBBBBBBBBBBBBB';
const HANDLE = 'cred_0123456789abcdefghijkl';
const DISPLAY = { title: 'Enter the secret GITHUB_TOKEN', details: ['For Notes'], requestedBy: 'Terminal' };

interface Seen { method: string; url: string; body: Record<string, unknown> }
type Handler = (r: Seen) => [number, unknown];
const servers: http.Server[] = [];
const saved: Record<string, string | undefined> = {};
const originalExit = process.exit;

async function fakeShell(handler: Handler): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rec: Seen = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {} };
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
  const [log, err, write, ewrite] = [console.log, console.error, process.stdout.write, process.stderr.write];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out.push(String(chunk));
    return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const program = new Command();
  program.exitOverride();
  registerSecret(program);
  try {
    await program.parseAsync(['node', 'aura', 'secret', ...args]);
  } catch (e) {
    throw Object.assign(e as Error, { output: out.join('\n') });
  } finally {
    console.log = log; console.error = err; process.stdout.write = write; process.stderr.write = ewrite;
  }
  return out.join('\n');
}

const asked = (over: Record<string, unknown> = {}) => ({
  id: ID, action: 'credential.store', level: 'session', state: 'pending', class: 'deferrable',
  expiresAt: Date.now() + 60_000, display: DISPLAY, ...over,
});

test('an agent (no terminal): on hold → structured on_hold result and exit 75; nothing collected', async () => {
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/credentials/requests') return [201, asked()];
    if (r.method === 'GET') return [200, asked({ heldAt: Date.now(), expiresAt: Date.now() + 86_400_000 })];
    return [404, {}];
  });
  await assert.rejects(run('ask', 'GITHUB_TOKEN'), (e: Error & { output?: string }) => {
    assert.equal(e.message, `exit ${EXIT_ON_HOLD}`);
    const line = (e.output ?? '').split('\n').find((l) => l.startsWith('{"approval"'));
    assert.ok(line, e.output);
    const r = JSON.parse(line!).approval;
    assert.equal(r.outcome, 'on_hold');
    assert.equal(r.approvalId, ID);
    assert.match(r.resume, /same command again/);
    assert.ok(r.heldUntil);
    return true;
  });
  assert.equal(seen.filter((r) => r.url.startsWith('/api/credentials/requests/')).length, 0);
  assert.equal(seen.filter((r) => r.url.endsWith('/cancel')).length, 0, 'on hold is not withdrawn: it can be resumed');
});

test('a re-run of a held request answers at once (no second request, no waiting)', async () => {
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/credentials/requests') return [201, asked({ heldAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 })];
    return [404, {}];
  });
  await assert.rejects(run('ask', 'GITHUB_TOKEN'), /exit 75/);
  assert.equal(seen.length, 1, 'no poll at all');
});

test('AURA_WAIT_ON_HOLD=1: says it is on hold once, keeps waiting, then collects the handle', async () => {
  process.env['AURA_WAIT_ON_HOLD'] = '1';
  let polls = 0;
  await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/credentials/requests') return [201, asked()];
    if (r.method === 'GET') { polls += 1; return [200, polls < 2 ? asked({ heldAt: Date.now() }) : asked({ state: 'approved' })]; }
    if (r.method === 'POST' && r.url === `/api/credentials/requests/${ID}`) return [200, { handle: HANDLE, name: 'GITHUB_TOKEN' }];
    return [404, {}];
  });
  const out = await run('ask', 'GITHUB_TOKEN');
  assert.match(out, /On hold in the AuraOS desktop/);
  assert.match(out, new RegExp(`^${HANDLE}$`, 'm'));
});

test('a denial carries the owner\'s feedback, human and structured', async () => {
  await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/credentials/requests') return [201, asked()];
    return [200, asked({ state: 'denied', feedback: 'Use the read-only token.' })];
  });
  await assert.rejects(run('ask', 'GITHUB_TOKEN'), (e: Error & { output?: string }) => {
    assert.equal(e.message, 'exit 1');
    assert.match(e.output ?? '', /not stored: denied by the owner: Use the read-only token\./);
    const r = JSON.parse((e.output ?? '').split('\n').find((l) => l.startsWith('{"approval"'))!).approval;
    assert.deepEqual([r.outcome, r.feedback], ['denied', 'Use the read-only token.']);
    return true;
  });
});

test('outcomes stay distinguishable: expired, cancelled (withdrawn / no longer valid)', async () => {
  for (const [view, outcome] of [
    [{ state: 'expired' }, 'expired'],
    [{ state: 'cancelled', cancelledBy: 'requester' }, 'cancelled'],
    [{ state: 'cancelled', cancelledBy: 'system' }, 'cancelled'],
  ] as const) {
    await fakeShell(() => [200, { id: ID, ...view }]);
    const r = await waitForApproval(ID, { sleep: async () => undefined, withdraw: false });
    assert.equal(r.outcome, outcome);
  }
});

test('askOwner: an approved resumed request needs no waiting; a held one exits 75 for an agent', async () => {
  await fakeShell(() => [200, { id: ID, state: 'approved' }]);
  const lines: string[] = [];
  const ok = await askOwner({ needsApproval: true, approvalId: ID, display: DISPLAY, state: 'approved', resumed: true }, { print: (l) => lines.push(l) });
  assert.deepEqual(ok, { approvalId: ID });
  assert.ok(lines.some((l) => /Continuing your earlier request/.test(l)));
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await assert.rejects(askOwner({ needsApproval: true, approvalId: ID, display: DISPLAY, state: 'pending', heldAt: 1, resumed: true }, { print: () => undefined }), /exit 75/);
  } finally {
    process.stdout.write = write;
  }
});

test('withdraw: POST …/cancel with the process identity', async () => {
  const seen = await fakeShell(() => [200, { ok: true, state: 'cancelled' }]);
  assert.equal(await withdrawApproval(ID), true);
  assert.deepEqual([seen[0]!.method, seen[0]!.url], ['POST', `/api/approvals/${ID}/cancel`]);
});
