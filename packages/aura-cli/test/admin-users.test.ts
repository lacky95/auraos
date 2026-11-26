// `aura admin user …` (Phase 5 I.2 part 2, D82): host only, the operator's
// ticket on every request, the enrolment code made on the host and bound to
// the new account's id, never a password on the command line, no owner role.
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
import { defaultSetupTicketDir } from '@aura/core/setup-tickets';
import { registerAdminUsers } from '../src/commands/admin-users.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID'];
const MEMBER = 'uaaaaaaaaaaaaaaa';
interface Seen { method: string; url: string; body: Record<string, unknown>; operator?: string; auth?: string }
const servers: http.Server[] = [];
const saved: Record<string, string | undefined> = {};
const originalExit = process.exit;

async function fakeShell(handler: (r: Seen) => [number, unknown]): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rec: Seen = {
      method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : {},
      ...(typeof req.headers['x-aura-operator'] === 'string' ? { operator: req.headers['x-aura-operator'] } : {}),
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
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.exit = originalExit;
  for (const s of servers.splice(0)) s.close();
});

async function run(...args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerAdminUsers(program.command('admin'));
  const out: string[] = [];
  const [log, err, write] = [console.log, console.error, process.stdout.write.bind(process.stdout)];
  const errWrite = process.stderr.write.bind(process.stderr);
  console.log = () => undefined; console.error = () => undefined;
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { await program.parseAsync(['node', 'aura', 'admin', 'user', ...args]); }
  finally { console.log = log; console.error = err; process.stdout.write = write; process.stderr.write = errWrite; }
  return out.join('');
}

function resetTickets(): Array<{ purpose: string; userId?: string; username?: string }> {
  const dir = defaultSetupTicketDir(process.env['AURA_DATA_DIR']);
  return readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf-8')) as { purpose: string; userId?: string; username?: string })
    .filter((t) => t.purpose === 'reset');
}

test('add: the operator creates a member, and the enrolment code is a host-made reset ticket bound to its id', async () => {
  const seen = await fakeShell((r) => (r.method === 'POST' && r.url === '/api/admin/users'
    ? [201, { user: { id: MEMBER, username: 'bob', role: 'member' }, created: true }] : [404, {}]));
  const out = await run('add', 'bob');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.body, { username: 'bob', role: 'member' }, 'no password, no code over HTTP');
  // The operator's one-time ticket rides only to the shell's own address (isTrustedShellUrl), not this fake.
  assert.equal(seen[0]!.auth, undefined, 'never an instance token');
  assert.match(out, /(^|\n|\x02)[0-9A-Z]{5}(-[0-9A-Z]{5}){3}\n$/, 'the one code, last on stdout');
  assert.deepEqual(resetTickets().map((t) => [t.userId, t.username]), [[MEMBER, 'bob']]);
});

test('add --role owner is refused before any request: there is one owner', async () => {
  const seen = await fakeShell(() => [200, {}]);
  await assert.rejects(run('add', 'boss', '--role', 'owner'), /exit 1/);
  assert.equal(seen.length, 0);
});

test('every command is a host command: refused in a sandbox before any request', async () => {
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  const seen = await fakeShell(() => [200, {}]);
  for (const args of [['add', 'bob'], ['ls'], ['disable', 'bob'], ['enable', 'bob'], ['reset-password', 'bob'], ['grant', 'bob', 'use', 'com.aura.terminal']]) {
    await assert.rejects(run(...args), /exit 1/, args.join(' '));
  }
  assert.equal(seen.length, 0);
});

test('disable, enable and grants name the user in the path and say what they change', async () => {
  const seen = await fakeShell((r) => (r.url.endsWith('/grants')
    ? [200, { ok: true, user: { id: MEMBER, username: 'bob' }, permission: 'app.jump:inst-1', changed: true }]
    : [200, { ok: true, user: { id: MEMBER, username: 'bob' }, changed: true, sessionsRevoked: 2, ended: { terminals: 1, terminalsFailed: 0, jumpSessions: null } }]));
  await run('disable', 'bob');
  await run('enable', MEMBER);
  await run('grant', 'bob', 'jump', 'com.aura.counter');
  await run('revoke', 'bob', 'use', 'com.aura.counter');
  await assert.rejects(run('grant', 'bob', 'root', 'com.aura.counter'), /exit 1/);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.body)}`), [
    'POST /api/admin/users/bob {"action":"disable"}',
    `POST /api/admin/users/${MEMBER} {"action":"enable"}`,
    'POST /api/admin/users/bob/grants {"change":"grant","access":"jump","appId":"com.aura.counter"}',
    'POST /api/admin/users/bob/grants {"change":"revoke","access":"use","appId":"com.aura.counter"}',
  ]);
  assert.ok(seen.every((r) => r.auth === undefined));
});
