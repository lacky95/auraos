// The MCP surface over an in-memory transport, with every OS route scripted
// through the fetch hook — no shell, no browser. What is pinned: the tool
// list, the no-UI fallbacks, name ambiguity, the two-step stop, and that a
// browser's refusal (fullscreen) reaches the agent as text, not a transport error.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_API_BASE = 'http://os.test';

const { setFetch } = await import('../src/shell-api.ts');
const { buildShellServer, TOOL_NAMES } = await import('../src/mcp/shell.ts');
const { _resetForTests } = await import('../src/challenges.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const apps = [
  { manifest: { id: 'com.aura.terminal', name: 'Terminal' }, enabled: true,
    instances: [{ instanceId: 'com.aura.terminal-2', appId: 'com.aura.terminal', state: 'resumed', pid: 10, port: 4002 },
                { instanceId: 'com.aura.terminal-9', appId: 'com.aura.terminal', state: 'resumed', pid: 11, port: 4009, inPool: true }],
    activities: [{ activityId: 'com.aura.terminal-2#a1', parentInstanceId: 'com.aura.terminal-2', appId: 'com.aura.terminal', path: '/', title: 'Terminal' }] },
  { manifest: { id: 'io.x.notes', name: 'Notes' }, enabled: true, instances: [], activities: [] },
  { manifest: { id: 'io.y.notes', name: 'Notes' }, enabled: true, instances: [], activities: [] },
  { manifest: { id: 'com.aura.registry', name: 'Registry', componentType: 'service' }, enabled: true,
    instances: [{ instanceId: 'com.aura.registry', appId: 'com.aura.registry', state: 'resumed', pid: 3, port: 4090 }], activities: [] },
];
const workspaces = {
  workspaces: [
    { id: 'ws-1', name: 'Main', layoutId: 'tiling', members: ['com.aura.terminal-2#a1'] },
    { id: 'ws-2', name: 'Work', layoutId: 'stack', members: [] },
  ],
  activeWorkspaceId: 'ws-1',
};
const layouts = [{ id: 'tiling', name: 'Tiling' }, { id: 'stack', name: 'Free Window' }];

/** Script the OS. `uiMode` decides what /api/os/ui/command answers. */
function fakeOs({ uiMode = 'no-ui', uiResult = {} } = {}) {
  const calls = [];
  const state = { workspaces: JSON.parse(JSON.stringify(workspaces)) };
  setFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/apps':              return json(apps);
      case 'GET /api/kv/os/workspaces':  return json({ value: state.workspaces });
      case 'PUT /api/kv/os/workspaces':  state.workspaces = body.value; return json({ ok: true });
      case 'GET /api/os/layouts':        return json(layouts);
      case 'GET /api/admin/apps/mru':    return json({ mru: { 'com.aura.terminal': 2, 'io.x.notes': 1 } });
      case 'GET /api/kv/os/lockscreen':  return json({ value: { lockAt: 5, unlockAt: 9 } });
      case 'POST /api/os/lock':          return json({ locked: true });
      case 'POST /api/apps/com.aura.terminal/start': return json({ instanceId: 'com.aura.terminal-3' });
      case 'POST /api/instances/com.aura.terminal-2/stop': return json({ stopped: true });
      case 'POST /api/os/ui/command':
        if (uiMode === 'no-ui') return json({ error: 'no-ui', message: 'no shell UI is connected — open the shell in a browser' }, 504);
        if (uiMode === 'refuse') return json({ error: 'ui-error', message: 'the browser refused to enter fullscreen: it only allows that from a user gesture' }, 500);
        return json({ ok: true, result: typeof uiResult === 'function' ? uiResult(body) : uiResult });
      default: return json({ error: `unscripted ${method} ${url.pathname}` }, 404);
    }
  });
  return { calls, state };
}

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildShellServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('the tool list is the documented 24, all with object schemas', async () => {
  fakeOs();
  const { tools } = await (await connect()).listTools();
  assert.equal(tools.length, 24);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assert.ok(tools.every((t) => t.inputSchema.type === 'object'));
  assert.equal(tools.find((t) => t.name === 'stop_process').annotations.destructiveHint, true);
});

test('overview without a browser: server-side facts, ui "not connected", names not ids', async () => {
  fakeOs();
  const r = await call(await connect(), 'get_shell_overview');
  assert.ok(!r.isError, r.content[0].text);
  const o = r.structuredContent;
  assert.equal(o.ui, 'not connected');
  assert.deepEqual(o.workspace, { number: 1, name: 'Main', layout: 'Tiling' });
  assert.equal(o.workspaces[0].windows[0].app, 'Terminal');
  assert.equal(o.lockScreen, false);
  assert.deepEqual(o.lastUsedApps, ['Terminal', 'Notes (io.x.notes)']);
  assert.deepEqual(o.runningApps, ['Terminal']);   // pool member hidden, service not an app
});

test('overview with a browser merges the snapshot: names, zoom, panels', async () => {
  fakeOs({ uiMode: 'ok', uiResult: {
    desktop: { activeWorkspaceId: 'ws-1', focusedViewId: 'com.aura.terminal-2#a1', maximizedViewId: null, maximizedFull: false, navMode: 'app',
      windows: [{ viewId: 'com.aura.terminal-2#a1', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', activityId: 'com.aura.terminal-2#a1', title: 'Terminal', name: 'build', sessionLabel: null, state: 'normal', isFocused: true, workspaceId: 'ws-1' }] },
    statusBar: { zoom: { percent: 120, shellPercent: 100, appPercent: 100, min: 50, max: 400, step: 10 }, fullscreen: false, layouts },
    launcher: { open: false, query: '' }, processManager: { open: true, filters: { apps: true, services: false } }, lockScreen: { active: true },
  } });
  const o = (await call(await connect(), 'get_shell_overview')).structuredContent;
  assert.equal(o.ui, 'connected');
  assert.equal(o.zoom, '120%');
  assert.equal(o.lockScreen, true);
  assert.equal(o.focusedWindow.name, 'build');
  assert.equal(o.processManager.open, true);
});

test('start_app: shared names return candidates with ids; unique names launch into the current workspace', async () => {
  const os = fakeOs({ uiMode: 'ok', uiResult: { launched: true } });
  const client = await connect();
  const amb = await call(client, 'start_app', { app: 'Notes' });
  assert.equal(amb.structuredContent.ambiguous, true);
  assert.deepEqual(amb.structuredContent.candidates.map((c) => c.id), ['io.x.notes', 'io.y.notes']);

  const r = await call(client, 'start_app', { app: 'terminal' });
  assert.ok(!r.isError, r.content[0].text);
  const launch = os.calls.find((c) => c.path === '/api/os/ui/command');
  assert.deepEqual(launch.body.params, { appId: 'com.aura.terminal', workspaceId: 'ws-1' });
  assert.deepEqual(r.structuredContent.workspace, { number: 1, name: 'Main', layout: 'Tiling' });

  const svc = await call(client, 'start_app', { app: 'Registry' });
  assert.equal(svc.isError, true);
  assert.match(svc.content[0].text, /is a service/);
});

test('start_app without a browser falls back to the OS start route and says so', async () => {
  const os = fakeOs();
  const r = await call(await connect(), 'start_app', { app: 'Terminal' });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(r.structuredContent.instanceId, 'com.aura.terminal-3');
  assert.match(r.structuredContent.note, /no shell UI is connected/);
  assert.ok(os.calls.some((c) => c.path === '/api/apps/com.aura.terminal/start'));
});

test('switch_workspace without a browser writes the KV blob; the result carries the new workspace', async () => {
  const os = fakeOs();
  const r = await call(await connect(), 'switch_workspace', { workspace: 'work' });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(os.state.workspaces.activeWorkspaceId, 'ws-2');
  assert.deepEqual(r.structuredContent.workspace, { number: 2, name: 'Work', layout: 'Free Window' });
  const bad = await call(await connect(), 'switch_workspace', { workspace: 7 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /no workspace 7/);
});

test('switch_layout with no name cycles to the next layout', async () => {
  const os = fakeOs();
  const r = await call(await connect(), 'switch_layout', {});
  assert.equal(r.structuredContent.layout, 'Free Window');
  assert.equal(os.state.workspaces.workspaces[0].layoutId, 'stack');
});

test('stop_process is two-step: a challenge first, the stop only with the code', async () => {
  _resetForTests();
  const os = fakeOs();
  const client = await connect();
  const first = await call(client, 'stop_process', { process: 'Terminal' });
  assert.ok(!first.isError, first.content[0].text);
  const { challenge, question } = first.structuredContent;
  assert.match(question, /Do you want to stop Terminal \(com\.aura\.terminal-2\)\?/);
  assert.ok(!os.calls.some((c) => c.path.endsWith('/stop')), 'nothing stopped yet');

  const wrongMode = await call(client, 'stop_process', { process: 'Terminal', mode: 'kill', challenge });
  assert.equal(wrongMode.isError, true);
  assert.match(wrongMode.content[0].text, /different process or mode/);

  const done = await call(client, 'stop_process', { process: 'Terminal', mode: 'stop', challenge });
  assert.ok(!done.isError, done.content[0].text);
  assert.equal(done.structuredContent.stopped, 'Terminal');
  assert.ok(os.calls.some((c) => c.path === '/api/instances/com.aura.terminal-2/stop'));

  const reused = await call(client, 'stop_process', { process: 'Terminal', challenge });
  assert.equal(reused.isError, true);
});

test('a browser refusal (fullscreen) and a missing browser (zoom) are readable isError results', async () => {
  fakeOs({ uiMode: 'refuse' });
  const fs = await call(await connect(), 'fullscreen', { mode: 'on' });
  assert.equal(fs.isError, true);
  assert.match(fs.content[0].text, /user gesture/);
  fakeOs();
  const z = await call(await connect(), 'zoom', { action: 'in' });
  assert.equal(z.isError, true);
  assert.match(z.content[0].text, /no shell UI is connected/);
  const bad = await call(await connect(), 'zoom', { action: 'set' });
  assert.match(bad.content[0].text, /needs `percent`/);
});

test('lock_screen without a browser uses the OS route', async () => {
  const os = fakeOs();
  const r = await call(await connect(), 'lock_screen', { mode: 'on' });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(r.structuredContent.locked, true);
  assert.ok(os.calls.some((c) => c.path === '/api/os/lock'));
});

test('invalid arguments are rejected before anything runs', async () => {
  const os = fakeOs();
  const r = await call(await connect(), 'rename_workspace', { name: '' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments for rename_workspace/);
  assert.equal(os.calls.length, 0);
});
