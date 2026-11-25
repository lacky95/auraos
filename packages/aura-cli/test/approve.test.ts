// Installs need the owner's approval (D31) and `aura approve` (D18), against
// fake shells on loopback: the sandbox asks and waits, -y is refused there,
// the host operator confirms with a one-time code.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { defaultSetupTicketDir, FileSetupTickets, operatorRequestSubject } from '@aura/core/setup-tickets';
import { installWithChoices } from '../src/commands/nexus.js';
import { registerApprove } from '../src/commands/approve.js';
import { shellFetch } from '../src/lib/identity.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_ADMIN_SESSION', 'AURA_ADMIN_CREDENTIAL'];
const ID = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const DIFF = { appId: 'com.example.notes', versionFrom: null, versionTo: '1.0.0', toolsAdded: ['git'], toolsRemoved: [], permissionsAdded: [], permissionsRemoved: [], dataProviderAdded: false, dataProviderRemoved: false, intentFiltersAdded: [] };
const DISPLAY = { title: 'Install Notes 1.0.0', details: ['Scope: user'], requestedBy: 'Terminal (t-1)' };

interface Seen { method: string; url: string; body: Record<string, unknown>; approval?: string; auth?: string; operator?: string }
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
      ...(typeof req.headers['x-aura-operator'] === 'string' ? { operator: req.headers['x-aura-operator'] } : {}),
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
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.exit = originalExit;
  for (const s of servers.splice(0)) s.close();
});

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [log, err] = [console.log, console.error];
  console.log = () => undefined; console.error = () => undefined;
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

function ticketSubjects(): string[] {
  const dir = defaultSetupTicketDir(process.env['AURA_DATA_DIR']);
  return readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => (JSON.parse(readFileSync(join(dir, n), 'utf-8')) as { subject?: string }).subject ?? '');
}

test('in a sandbox: the CLI asks, waits for the desktop, then installs with the approval', async () => {
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  let polls = 0;
  const seen = await fakeShell((r) => {
    if (r.method === 'POST' && r.url === '/api/nexus/install') {
      return r.approval === ID
        ? [200, { ok: true, record: { id: 'com.example.notes', version: '1.0.0' } }]
        : [202, { ok: false, error: 'needs-approval', needsApproval: true, approvalId: ID, level: 'session', diff: DIFF, display: DISPLAY }];
    }
    if (r.method === 'GET' && r.url === `/api/approvals/${ID}`) return [200, { id: ID, state: ++polls < 2 ? 'pending' : 'approved' }];
    return [404, {}];
  });
  const res = await quiet(() => installWithChoices('/api/nexus/install', { ref: 'notes', scope: 'user' }, {}, 'install'));
  assert.equal(res?.ok, true);
  const posts = seen.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.approval, undefined);
  assert.equal(posts[1]!.approval, ID, 'the retry names the approval');
  assert.ok(posts.every((r) => !('autoApprove' in r.body) && !('operatorCode' in r.body)));
  assert.equal(polls, 2);
});

test('in a sandbox: a denied request installs nothing, and -y is refused', async () => {
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  const seen = await fakeShell((r) => (r.method === 'GET'
    ? [200, { id: ID, state: 'denied' }]
    : [202, { ok: false, needsApproval: true, approvalId: ID, diff: DIFF, display: DISPLAY }]));
  assert.equal(await quiet(() => installWithChoices('/api/nexus/install', { ref: 'notes' }, {}, 'install')), null);
  assert.equal(seen.filter((r) => r.method === 'POST').length, 1);
  await assert.rejects(quiet(() => installWithChoices('/api/nexus/install', { ref: 'notes' }, { yes: true }, 'install')), /exit 1/);
  assert.equal(seen.filter((r) => r.method === 'POST').length, 1, '-y never reached the shell');
});

test('on the host: -y confirms as the operator with a code for exactly that subject', async () => {
  const subject = `nexus.install:${'a'.repeat(64)}`;
  const seen = await fakeShell((r) => (typeof r.body['operatorCode'] === 'string'
    ? [200, { ok: true, record: { id: 'com.example.notes', version: '1.0.0' } }]
    : [202, { ok: false, needsApproval: true, operatorOnly: true, operatorSubject: subject, diff: DIFF }]));
  const res = await quiet(() => installWithChoices('/api/nexus/install', { ref: 'notes' }, { yes: true }, 'install'));
  assert.equal(res?.ok, true);
  assert.match(String(seen[1]!.body['operatorCode']), /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.ok(ticketSubjects().includes(subject), 'the ticket names the subject the shell asked for');
});

test('aura approve <id>: preview, then the decision with the same operator code', async () => {
  const seen = await fakeShell((r) => (r.body['preview'] === true
    ? [200, { id: ID, action: 'nexus.install', level: 'fresh', state: 'pending', expiresAt: 0, display: DISPLAY }]
    : [200, { ok: true, state: 'approved' }]));
  const program = new Command();
  program.exitOverride();
  registerApprove(program);
  await quiet(() => program.parseAsync(['node', 'aura', 'approve', ID, '-y']));
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [`POST /api/approvals/${ID}/approve`, `POST /api/approvals/${ID}/approve`]);
  assert.equal(seen[0]!.body['operatorCode'], seen[1]!.body['operatorCode']);
  assert.equal(seen[1]!.body['preview'], undefined);
  assert.ok(ticketSubjects().includes(`approve:${ID}`));
});

test('aura approve is a host command: refused in a sandbox before any request', async () => {
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  const seen = await fakeShell(() => [200, {}]);
  const program = new Command();
  program.exitOverride();
  registerApprove(program);
  await assert.rejects(quiet(() => program.parseAsync(['node', 'aura', 'approve', ID, '-y'])), /exit 1/);
  assert.equal(seen.length, 0);
});

test('on the host: each call to its own shell carries a one-time operator ticket for exactly that request', async () => {
  const seen = await fakeShell(() => [200, {}]);
  process.env['OS_API_BASE'] = process.env['AURA_SHELL_URL'];  // the master's own shell
  await shellFetch('/api/apps');
  await shellFetch('/api/nexus/install', { method: 'POST', body: '{}' });
  await shellFetch('/api/proxy/com.aura.docs/mcp', { method: 'POST', body: '{}' });
  await shellFetch('/api/auth/status', { intent: 'anonymous' });
  const [get, post, proxy, anon] = seen;
  assert.ok(get!.operator && post!.operator && get!.operator !== post!.operator, 'a new code per request');
  assert.equal(proxy!.operator, undefined, 'nothing goes to an app through the proxy');
  assert.equal(anon!.operator, undefined);
  const tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(process.env['AURA_DATA_DIR']) });
  assert.equal((await tickets.claim(get!.operator!, 'operator'))?.subject, operatorRequestSubject('GET', '/api/apps'));
  assert.equal((await tickets.claim(post!.operator!, 'operator'))?.subject, operatorRequestSubject('POST', '/api/nexus/install'));
  assert.equal(await tickets.claim(get!.operator!, 'operator'), null, 'used up');
});

test('in a sandbox, or to another shell, no operator ticket is made', async () => {
  const seen = await fakeShell(() => [200, {}]);
  await shellFetch('/api/apps');  // not this system's shell
  process.env['OS_API_BASE'] = process.env['AURA_SHELL_URL'];
  process.env['APP_INSTANCE_ID'] = 'com.example.counter-1';
  await shellFetch('/api/apps');
  assert.deepEqual(seen.map((r) => r.operator), [undefined, undefined]);
});

test('an install the shell refuses (not the owner, D31) says how to install', async () => {
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.example.counter-1';
  await fakeShell(() => [403, { error: 'access-denied', reason: 'wrong-target' }]);
  const lines: string[] = [];
  const err = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.join(' ')); };
  try {
    await assert.rejects(installWithChoices('/api/nexus/install', { ref: 'notes' }, {}, 'install'), /exit 1/);
  } finally {
    console.error = err;
  }
  assert.match(lines.join('\n'), /only the owner may install apps/);
  assert.match(lines.join('\n'), /System Terminal/);
  assert.match(lines.join('\n'), /docker exec -it aura-shell aura/);
});
