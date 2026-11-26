// Owner decision (5-main, member semantics): `aura jump` / `aura exec` reach the exec bridge, which authorizes the
// session per target, from every entry point. The instance list is the owner's; a member (its login or its own
// System Terminal) is refused it, so an exact instance id goes straight to the bridge. Anything else fails closed.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveSessionTarget } from '../src/lib/resolve.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID'];
const saved: Record<string, string | undefined> = {};
const servers: http.Server[] = [];
const originalExit = process.exit;

async function fakeShell(status: number, body: unknown): Promise<string[]> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
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

test('the owner: the list resolves an app id to its one running instance', async () => {
  await fakeShell(200, [{ manifest: { id: 'io.ex.notes' }, instances: [{ instanceId: 'io.ex.notes-1', appId: 'io.ex.notes', state: 'resumed' }] }]);
  assert.deepEqual(await resolveSessionTarget('io.ex.notes').then((i) => [i.instanceId, i.appId]), ['io.ex.notes-1', 'io.ex.notes']);
});

test('a member (the list refused): an exact instance id goes to the bridge, which authorizes per target', async () => {
  for (const status of [401, 403]) {
    const seen = await fakeShell(status, { error: 'access-denied' });
    assert.deepEqual(await resolveSessionTarget('io.ex.notes-2'), { instanceId: 'io.ex.notes-2', appId: 'io.ex.notes-2' });
    assert.deepEqual(seen, ['GET /api/apps'], 'nothing else is asked or assumed');
  }
});

test('fail closed: not an instance id, or any other failure, never becomes a target', async () => {
  await fakeShell(403, { error: 'access-denied' });
  await assert.rejects(resolveSessionTarget('../etc'));
  await assert.rejects(resolveSessionTarget('a b'));
  await fakeShell(500, { error: 'boom' });
  await assert.rejects(resolveSessionTarget('io.ex.notes-2'));
});
