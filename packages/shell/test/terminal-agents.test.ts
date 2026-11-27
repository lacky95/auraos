// TerminalX's agent watch through the shell (lib/terminalAgents.ts): the agent
// events stream and the agent hooks, with fakes for the caller, the grants,
// the approval gate and the Terminal instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEventsRoute, createAgentHooksRoute } from '../src/lib/terminalAgents.ts';

const TX = { appId: 'io.lakner.terminalx' };
const INST = 'com.aura.terminal-2';
const sse = (body: ReadableStream<Uint8Array> | string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const req = (path: string, method = 'GET', signal?: AbortSignal) =>
  new Request(`http://shell.test${path}`, { method, ...(signal ? { signal } : {}) });
const status = async (r: Response) => `${r.status} ${r.status === 200 ? '' : (await r.json() as { error: string }).error}`.trim();

test('agent events: the instance\'s own stream, for a verified caller naming an instance', async () => {
  const opened: string[] = [];
  const route = createAgentEventsRoute({
    caller: async (r) => (r.headers.get('x-bad') ? 'invalid' : TX),
    holdsListGrant: async () => true,
    open: async (id) => {
      opened.push(id);
      return id === INST ? sse('event: snapshot\ndata: {"agents":{}}\n\n') : id === 'gone' ? null : Response.json({ error: 'x' }, { status: 500 });
    },
  });
  const ok = await route(req(`/api/terminal/sessions/events?instance=${INST}`));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/event-stream');
  assert.equal(await ok.text(), 'event: snapshot\ndata: {"agents":{}}\n\n');
  assert.equal(await status(await route(req('/api/terminal/sessions/events'))), '400 instance required');
  assert.equal(await status(await route(req('/api/terminal/sessions/events?instance=gone'))), '404 instance-not-running');
  assert.equal(await status(await route(req('/api/terminal/sessions/events?instance=x'))), '500 x');
  const bad = new Request(`http://shell.test/api/terminal/sessions/events?instance=${INST}`, { headers: { 'x-bad': '1' } });
  assert.equal(await status(await route(bad)), '401 caller-invalid');
  assert.deepEqual(opened, [INST, 'gone', 'x']);
});

test('agent events: a revoked grant ends the stream; a client that leaves ends the upstream', async () => {
  let held = true;
  let upstreamSignal: AbortSignal | null = null;
  const route = createAgentEventsRoute({
    caller: async () => TX,
    holdsListGrant: async () => held,
    recheckMs: 5,
    open: async (_id, signal) => {
      upstreamSignal = signal;
      // Open until aborted, as the Terminal's stream is.
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode(': hello\n\n'));
          signal.addEventListener('abort', () => ctrl.error(new Error('aborted')));
        },
      });
      return sse(body);
    },
  });
  const res = await route(req(`/api/terminal/sessions/events?instance=${INST}`));
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ': hello\n\n');
  held = false;
  await assert.rejects(reader.read(), 'the stream ends once the grant is gone');
  assert.equal(upstreamSignal!.aborted, true);

  const client = new AbortController();
  held = true;
  await route(req(`/api/terminal/sessions/events?instance=${INST}`, 'GET', client.signal));
  client.abort();
  assert.equal(upstreamSignal!.aborted, true);
});

test('agent hooks: status as is; an app\'s install or removal waits for the owner\'s approval of the files the Terminal names', async () => {
  const forwarded: string[] = [];
  const changes: unknown[] = [];
  let approved = false;
  const route = createAgentHooksRoute({
    caller: async (r) => (r.headers.get('x-owner') ? null : TX),
    approve: async (_r, change) => {
      changes.push(change);
      return approved ? null : Response.json({ error: 'needs-approval', op: change.op }, { status: 202 });
    },
    forward: async (id, method) => {
      forwarded.push(`${method} ${id}`);
      if (id !== INST) return null;
      // The adapter's own status names its files (audit #1): the shell takes them from here.
      return Response.json({ installed: method === 'POST', paths: { a: '/home/aura/.agent-a/settings.json', b: '/home/aura/.agent-b/conf', s: '/home/aura/.aura/hook.sh' } });
    },
  });
  const at = `/api/terminal/agent-hooks?instance=${INST}`;
  assert.equal((await route(req(at))).status, 200, 'status needs no approval');
  const asked = await route(req(at, 'POST'));
  assert.equal(asked.status, 202);
  assert.deepEqual(await asked.json(), { error: 'needs-approval', op: 'install' });
  assert.deepEqual(changes[0], { what: 'the Terminal\'s session hooks', op: 'install', files: ['~/.agent-a/settings.json', '~/.agent-b/conf', '~/.aura/hook.sh'] });
  assert.equal((await route(req(at, 'DELETE'))).status, 202);
  assert.deepEqual(forwarded, [`GET ${INST}`, `GET ${INST}`, `GET ${INST}`], 'nothing changed before the approval (only the status was read)');
  approved = true;
  assert.equal((await (await route(req(at, 'POST'))).json()).installed, true);
  approved = false;
  const owner = new Request(`http://shell.test${at}`, { method: 'DELETE', headers: { 'x-owner': '1' } });
  assert.equal((await route(owner)).status, 200, 'the owner (or the System Terminal) needs no approval');
  assert.deepEqual(forwarded.slice(3), [`GET ${INST}`, `POST ${INST}`, `DELETE ${INST}`]);
  assert.equal(await status(await route(req('/api/terminal/agent-hooks?instance=gone'))), '404 instance-not-running');
  assert.equal(await status(await route(req('/api/terminal/agent-hooks?instance=gone', 'POST'))), '404 instance-not-running');
  assert.equal(await status(await route(req('/api/terminal/agent-hooks', 'POST'))), '400 instance required');
});
