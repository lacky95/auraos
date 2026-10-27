// The MCP surface over an in-memory transport, with every OS route scripted
// through the fetch hook — no shell, no browser. What is pinned: the tool
// list, the no-UI fallbacks, name ambiguity, the two-step stop, and that a
// browser's refusal (fullscreen) reaches the agent as text, not a transport error.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OS_API_BASE = 'http://os.test';

const { setFetch } = await import('../src/shell-api.ts');
const { buildShellServer, TOOL_NAMES, agentFromHeaders } = await import('../src/mcp/shell.ts');
const { _resetForTests } = await import('../src/challenges.ts');
const { _resetForTests: resetDedupe, LOOP_LIMIT } = await import('../src/dedupe.ts');
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
function fakeOs({ uiMode = 'no-ui', uiResult = {}, region = {}, theme = null } = {}) {
  resetDedupe();
  const calls = [];
  const state = { workspaces: JSON.parse(JSON.stringify(workspaces)), theme };
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
      case 'GET /api/kv/os/theme':       return state.theme ? json({ value: state.theme }) : json({ error: 'not found' }, 404);
      case 'PUT /api/kv/os/theme':       state.theme = body.value; return json({ ok: true });
      case 'GET /api/os/layouts':        return json(layouts);
      case 'GET /api/admin/apps/mru':    return json({ mru: { 'com.aura.terminal': 2, 'io.x.notes': 1 } });
      case 'GET /api/kv/os/lockscreen':  return json({ value: { lockAt: 5, unlockAt: 9 } });
      case 'GET /api/kv/os/timeZone':    return region.timeZone === undefined ? json({ error: 'not found' }, 404) : json({ value: region.timeZone });
      case 'GET /api/kv/os/locale':      return json({ value: region.locale ?? 'en-US' });
      case 'GET /api/kv/os/clockFormat': return json({ value: region.clockFormat ?? '24h' });
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

test('the tool list is the documented 35, all with object schemas', async () => {
  fakeOs();
  const { tools } = await (await connect()).listTools();
  assert.equal(tools.length, 35);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  assert.ok(tools.every((t) => t.inputSchema.type === 'object'));
  assert.equal(tools.find((t) => t.name === 'stop_process').annotations.destructiveHint, true);
});

test('overview without a browser: server-side facts, ui "not connected", names not ids', async () => {
  fakeOs();
  const r = await call(await connect(), 'get_shell_overview');
  assert.ok(!r.isError, r.content[0].text);
  const o = r.structuredContent;
  assert.equal(o.details.ui, 'not connected');
  assert.deepEqual(o.workspace, { number: 1, name: 'Main', windows: [{ app: 'Terminal', name: null, title: 'Terminal', viewId: 'com.aura.terminal-2#a1', workspace: '1 Main' }] });
  assert.deepEqual(o.otherWorkspaces, [{ number: 2, name: 'Work', windows: [] }]);
  assert.equal(o.details.lockScreen, false);
  assert.deepEqual(o.lastUsedApps, ['Terminal', 'Notes (io.x.notes)']);
  assert.deepEqual(o.runningApps, ['Terminal']);   // pool member hidden, service not an app
  assert.match(o.summary, /^Workspace 1 "Main" — nothing focused\. 1 window here, 1 app running, 2 workspaces\./);
  assert.deepEqual(o.attention, ['no shell UI is connected — window names, zoom and panels are unknown']);
});

test('overview with a browser merges the snapshot: names, zoom, panels', async () => {
  fakeOs({ uiMode: 'ok', uiResult: {
    desktop: { activeWorkspaceId: 'ws-1', focusedViewId: 'com.aura.terminal-2#a1', maximizedViewId: null, maximizedFull: false, navMode: 'app',
      windows: [{ viewId: 'com.aura.terminal-2#a1', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', activityId: 'com.aura.terminal-2#a1', title: 'Terminal', name: 'build', sessionLabel: null, state: 'normal', isFocused: true, workspaceId: 'ws-1' }] },
    statusBar: { zoom: { percent: 120, shellPercent: 100, appPercent: 100, min: 50, max: 400, step: 10 }, fullscreen: false, layouts },
    launcher: { open: false, query: '' }, processManager: { open: true, filters: { apps: true, services: false } }, lockScreen: { active: true },
  } });
  const o = (await call(await connect(), 'get_shell_overview')).structuredContent;
  assert.equal(o.details.ui, 'connected');
  assert.equal(o.details.zoom, '120%');
  assert.equal(o.details.lockScreen, true);
  assert.equal(o.focusedWindow.name, 'build');
  assert.equal(o.details.processManager.open, true);
  assert.match(o.summary, /focused: Terminal "build"/);
  assert.deepEqual(o.attention, ['the lock screen is active', 'the shell is zoomed to 120%', 'the process manager is open']);
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

test('an identical call within the window is answered from the first one, marked deduplicated', async () => {
  const os = fakeOs({ uiMode: 'ok', uiResult: { desktop: { activeWorkspaceId: 'ws-1', focusedViewId: null, maximizedViewId: null, maximizedFull: false, navMode: 'app', windows: [] } } });
  const client = await connect();
  const [a, b, c] = await Promise.all([
    call(client, 'get_shell_overview'), call(client, 'get_shell_overview'), call(client, 'get_shell_overview'),
  ]);
  assert.ok(!a.isError && !b.isError && !c.isError);
  const snapshots = os.calls.filter((x) => x.path === '/api/os/ui/command');
  assert.equal(snapshots.length, 1, 'three concurrent identical calls share one browser round trip');
  const dups = [a, b, c].filter((r) => r.structuredContent.deduplicated === true);
  assert.equal(dups.length, 2);
  assert.match(dups[0].content.at(-1).text, /deduplicated: identical get_shell_overview call/);
  // Different arguments are a different call.
  const other = await call(client, 'switch_workspace', { workspace: 2 });
  assert.equal(other.structuredContent.deduplicated, undefined);
});

test('get_datetime reports the browser clock when there is one, the server clock otherwise, and absorbs repeats', async () => {
  // 21:00 UTC is 23:00 in Berlin — the phrasings must be in the user's zone,
  // not the server's.
  fakeOs({ uiMode: 'ok', uiResult: (body) => body.action === 'clock'
    ? { iso: '2026-09-08T21:00:00.000Z', epochMs: Date.parse('2026-09-08T21:00:00.000Z'),
        timeZone: 'Europe/Berlin', locale: 'en-GB', utcOffsetMinutes: 120, hour12: false }
    : {} });
  const client = await connect();
  const r = await call(client, 'get_datetime');
  assert.equal(r.structuredContent.technical.timeZone, 'Europe/Berlin');
  assert.match(r.structuredContent.technical.source, /browser/);
  // One reading, four phrasings — the model picks by what was asked.
  const say = r.structuredContent.say;
  assert.match(say.date, /^\w+day, \d{1,2} \w+ 20\d\d$/, say.date);
  assert.match(say.time, /^\d{2}:\d{2}$/, say.time);
  assert.equal(say.dateTime, `${say.date}, ${say.time}`);
  assert.equal(say.date, 'Tuesday, 8 September 2026');
  assert.equal(say.time, '23:00', 'the user\'s zone, not the server\'s 21:00 UTC');
  assert.match(say.full, /at \d{2}:\d{2}:\d{2}, Europe\/Berlin \(UTC\+\d\)$/, say.full);
  assert.match(r.structuredContent.summary, /only what was asked/);
  assert.match(r.structuredContent.technical.timeWithSeconds, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(r.content[0].text.split('\n')[0], say.dateTime, 'the text leads with the everyday phrasing');
  // A repeat moments later is absorbed like any other tool: the reading is
  // to the minute, so the same answer is still the right answer.
  const again = await call(client, 'get_datetime');
  assert.equal(again.structuredContent.deduplicated, true);
  assert.equal(again.content[0].text, r.content[0].text);

  fakeOs();
  const s = (await call(await connect(), 'get_datetime')).structuredContent;
  assert.match(s.technical.source, /OS server/);
  assert.match(s.technical.iso, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof s.technical.epochMs, 'number');
  assert.match(s.technical.zoneSource, /set yours in Settings/);
  assert.ok(s.say.time && s.say.date && s.say.dateTime && s.say.full);

  // With a zone chosen in Settings → General, the server fallback is the user's time.
  fakeOs({ region: { timeZone: 'Europe/Berlin', locale: 'de-DE', clockFormat: '24h' } });
  const b = (await call(await connect(), 'get_datetime')).structuredContent;
  assert.equal(b.technical.timeZone, 'Europe/Berlin');
  assert.equal(b.technical.locale, 'de-DE');
  assert.match(b.technical.utcOffset, /^UTC\+\d/);
  assert.match(b.technical.zoneSource, /AuraOS setting/);
  assert.match(b.say.date, /20\d\d/);
  // The everyday phrasings never carry a zone label; only `full` does.
  const firstLine = (await call(await connect(), 'get_datetime')).content[0].text.split('\n')[0];
  assert.ok(!/UTC|GMT|Europe/.test(firstLine), firstLine);
  assert.ok(!/UTC|GMT|Europe/.test(b.say.time + b.say.date + b.say.dateTime));
  assert.match(b.say.full, /Europe\/Berlin/);

  // 12-hour clock in Settings reaches the phrasings.
  fakeOs({ region: { timeZone: 'America/New_York', locale: 'en-US', clockFormat: '12h' } });
  const h = (await call(await connect(), 'get_datetime')).structuredContent;
  assert.match(h.say.time, /(AM|PM)$/, h.say.time);
  assert.equal(h.technical.clockFormat, '12h');
});

test('reading the same thing in a loop hits the brake, and a change releases it', async () => {
  const os = fakeOs();
  const client = await connect();
  // Distinct arguments each time, so absorption never applies — only the brake can stop this.
  for (let i = 0; i <= LOOP_LIMIT; i++) {
    const r = await call(client, 'list_workspaces');
    if (i < LOOP_LIMIT) {
      assert.ok(!r.isError && r.structuredContent?.workspaces, `call ${i + 1} should answer with data`);
    } else {
      assert.equal(r.structuredContent, undefined, 'the brake returns text, not another payload');
      assert.match(r.content[0].text, /called list_workspaces 4 times/);
      assert.match(r.content[0].text, /Stop calling tools/);
      assert.ok(!r.isError, 'the brake is not an error — it is an instruction');
    }
  }
  // Changing something makes re-reading legitimate again.
  await call(client, 'switch_workspace', { workspace: 2 });
  const after = await call(client, 'list_workspaces');
  assert.ok(after.structuredContent?.workspaces, 'a mutating call clears the brake');
  assert.ok(os.calls.length > 0);
});

test('the brake repeats the answer the tool led with, not its JSON', async () => {
  fakeOs();
  const client = await connect();
  let last;
  for (let i = 0; i <= LOOP_LIMIT; i++) last = await call(client, 'get_shell_overview');
  assert.equal(last.structuredContent, undefined);
  // `summary` is the headline for a tool whose text body is JSON — an
  // opening brace would be no use to the model being told to answer.
  assert.match(last.content[0].text, /The answer is still: Workspace 1 "Main"/);
  assert.ok(!last.content[0].text.includes('The answer is still: {'));
});

test('zoom moves one step by default, `times` steps on request, and reports a limit', async () => {
  // The browser is scripted to answer as if it clamped at 400 %.
  let sent = null;
  fakeOs({ uiMode: 'ok', uiResult: (body) => { sent = body.params; return { percent: 400, from: 400 }; } });
  const client = await connect();

  await call(client, 'zoom', { action: 'in' });
  assert.deepEqual(sent, { step: 1 }, 'one step by default');
  await call(client, 'zoom', { action: 'out', times: 3 });
  assert.deepEqual(sent, { step: -3 }, '"zoom out three times" is one call');
  await call(client, 'zoom', { action: 'reset' });
  assert.deepEqual(sent, { reset: true });

  // Nothing moved: say so rather than report a zoom that did not happen.
  const capped = await call(client, 'zoom', { action: 'in', times: 2 });
  assert.equal(capped.structuredContent.zoom, '400%');
  assert.equal(capped.structuredContent.steps, 2);
  assert.match(capped.structuredContent.note, /already at the maximum zoom \(400%\)/);

  const bad = await call(client, 'zoom', { action: 'reset', times: 2 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /only applies to zoom in and out/);
});

test('zoom reports the move when the browser actually zoomed', async () => {
  fakeOs({ uiMode: 'ok', uiResult: () => ({ percent: 120, from: 100 }) });
  const r = await call(await connect(), 'zoom', { action: 'in', times: 2 });
  assert.deepEqual(r.structuredContent, { zoom: '120%', from: '100%', steps: 2 });
});

test('a repeated COMMAND runs again — only questions are absorbed', async () => {
  // The bug this pins: zoom set → reset → reset served the first reset's
  // answer and never zoomed, leaving the shell where it was.
  const seen = [];
  fakeOs({ uiMode: 'ok', uiResult: (body) => { seen.push(body.params); return { percent: 100, from: 150 }; } });
  const client = await connect();
  await call(client, 'zoom', { action: 'reset' });
  await call(client, 'zoom', { action: 'reset' });
  assert.equal(seen.length, 2, 'the second reset reached the browser');
  const r = await call(client, 'zoom', { action: 'reset' });
  assert.equal(r.structuredContent.deduplicated, undefined, 'a command is never marked deduplicated');

  // Questions still are.
  const a = await call(client, 'list_apps');
  const b = await call(client, 'list_apps');
  assert.equal(a.structuredContent.deduplicated, undefined);
  assert.equal(b.structuredContent.deduplicated, true);
});

// ── Viewport profiles and light/dark mode ──────────────────────────────────

const viewportInfo = {
  active: { id: 'default', name: 'Default', zoomPercent: 100, shellZoomPercent: 100, appZoomPercent: 100,
    margins: { top: 0, right: 0, bottom: 0, left: 0 }, themeIdLight: 'mist', themeIdDark: 'cyan' },
  profiles: [
    { id: 'default', name: 'Default' },
    { id: 'profile-2', name: 'hello world' },
    { id: 'profile-3', name: 'TV big' },
    { id: 'profile-4', name: 'TV small' },
  ],
};
/** A browser that answers getViewportInfo and setViewport like StatusBar.astro does. */
const viewportUi = (body) => {
  if (body.action === 'getViewportInfo') return viewportInfo;
  if (body.action === 'setViewport') {
    const to = viewportInfo.profiles.find((p) => p.id === body.params.id);
    return { from: { id: 'default', name: 'Default' }, to };
  }
  return {};
};
const uiCalls = (calls) => calls.filter((c) => c.path === '/api/os/ui/command').map((c) => c.body);

test('set_viewport switches by exact name, by a unique start, and says when it was already active', async () => {
  const { calls } = fakeOs({ uiMode: 'ok', uiResult: viewportUi });
  const client = await connect();
  let r = await call(client, 'set_viewport', { viewport: 'Hello World' });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(r.structuredContent, { viewport: 'hello world', from: 'Default' });
  assert.deepEqual(uiCalls(calls).at(-1), { action: 'setViewport', params: { id: 'profile-2' }, timeoutMs: 8000 });
  r = await call(client, 'set_viewport', { viewport: 'hello' });
  assert.equal(r.structuredContent.viewport, 'hello world');
  r = await call(client, 'set_viewport', { viewport: 'default' });
  assert.match(r.structuredContent.note, /already the active viewport/);
});

test('set_viewport: several matches give candidates, an unknown name lists what exists, and neither switches', async () => {
  const { calls } = fakeOs({ uiMode: 'ok', uiResult: viewportUi });
  const client = await connect();
  let r = await call(client, 'set_viewport', { viewport: 'tv' });
  assert.equal(r.structuredContent.ambiguous, true);
  assert.deepEqual(r.structuredContent.candidates, ['TV big', 'TV small']);
  r = await call(client, 'set_viewport', { viewport: 'phone' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no viewport profile called "phone"; available: Default, hello world, TV big, TV small/);
  assert.ok(!uiCalls(calls).some((b) => b.action === 'setViewport'));
});

test('set_viewport without a browser says so', async () => {
  fakeOs();
  const r = await call(await connect(), 'set_viewport', { viewport: 'default' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no shell UI is connected/);
});

test('get_viewport_info: the active profile, all names and the color mode; without a browser only the mode', async () => {
  fakeOs({ uiMode: 'ok', uiResult: viewportUi, theme: { colorMode: 'light' } });
  let o = (await call(await connect(), 'get_viewport_info')).structuredContent;
  assert.equal(o.colorMode, 'light');
  assert.equal(o.active.name, 'Default');
  assert.equal(o.active.zoom, '100%');
  assert.deepEqual(o.profiles, ['Default', 'hello world', 'TV big', 'TV small']);
  fakeOs();
  o = (await call(await connect(), 'get_viewport_info')).structuredContent;
  assert.equal(o.colorMode, 'dark', 'an unset theme is dark, the OS default');
  assert.equal(o.profiles, null);
  assert.match(o.summary, /Viewport profiles unknown: no shell UI is connected/);
});

test('set_dark_mode / set_light_mode write the KV without a browser and keep the theme picks', async () => {
  const { state } = fakeOs({ theme: { themeIdDark: 'cyan', themeIdLight: 'mist', colorMode: 'light' } });
  const client = await connect();
  let r = await call(client, 'set_dark_mode');
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(r.structuredContent, { colorMode: 'dark', from: 'light' });
  assert.deepEqual(state.theme, { themeIdDark: 'cyan', themeIdLight: 'mist', colorMode: 'dark' });
  r = await call(client, 'set_dark_mode');
  assert.equal(r.structuredContent.note, 'already in dark mode');
  r = await call(client, 'set_light_mode');
  assert.deepEqual(r.structuredContent, { colorMode: 'light', from: 'dark' });
  assert.equal(state.theme.themeIdDark, 'cyan');
});

test('overview details carry the viewport profile and the color mode', async () => {
  fakeOs({ uiMode: 'ok', uiResult: { viewport: { activeProfile: 'hello world', profileCount: 2 } }, theme: { colorMode: 'auto' } });
  const o = (await call(await connect(), 'get_shell_overview')).structuredContent;
  assert.equal(o.details.viewport, 'hello world');
  assert.equal(o.details.colorMode, 'auto');
});

// ── Notifications ───────────────────────────────────────────────────────────

const NID = 'ntf_0mvjsabcd12345678';
function notif(over = {}) {
  return {
    id: NID, type: 'dialogue', title: 'Deploy?', text: '', priority: 'medium', visibility: 'private', pinned: false, popup: false,
    state: 'active', senderKey: 'app:com.aura.aurashelld', createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    sender: { kind: 'agent', id: 'com.aura.aurashelld', attribution: 'verified' }, history: [], ...over,
  };
}

/** Script the notification routes; records method, path, query, headers and body. */
function fakeNotifOs(handler) {
  resetDedupe();
  const calls = [];
  setFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const rec = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body };
    calls.push(rec);
    const [status, data] = await handler(rec);
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

test('notification tools: Bearer only on notification calls; agent name forwarded as sender.actor; downgrade warnings reach the agent', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'aura1.test.token';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') {
        return [201, { ok: true, notification: notif({ sender: { kind: 'agent', id: 'com.aura.aurashelld', attribution: 'verified', actor: { name: 'tester', attribution: 'declared' } } }),
          warnings: [{ code: 'downgraded', field: 'popup', from: true, to: false, message: "popup requires the 'notifications.popup' permission … not granted" }] }];
      }
      if (path === '/api/apps') return [200, apps];
      return [404, { error: 'unscripted' }];
    });
    const client = await connect();
    const r = await call(client, 'create_notification', {
      type: 'dialogue', title: 'Deploy?', popup: true, agent: 'tester',
      components: [{ kind: 'button', id: 'yes', label: 'Deploy', variant: 'primary', action: 'resolve' }],
      context: { kind: 'task', id: 'deploy-42', label: 'Release' },
    });
    assert.equal(r.isError, undefined);
    const sc = r.structuredContent;
    assert.match(sc.summary, /DOWNGRADED \(popup: true → false\)/);
    assert.equal(sc.warnings[0].code, 'downgraded');
    assert.equal(sc.notification.sender.attribution, 'verified');
    assert.deepEqual(sc.notification.sender.actor, { name: 'tester', attribution: 'declared' });
    assert.match(sc.next, /wait_for_answer/);
    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.headers.authorization, 'Bearer aura1.test.token');
    assert.deepEqual(post.body.sender, { actor: { name: 'tester' } });
    assert.deepEqual(post.body.context, { kind: 'task', id: 'deploy-42', label: 'Release' });
    assert.equal('agent' in post.body, false, 'agent is not a notification field');
    // other routes stay token-less
    await call(client, 'list_apps');
    assert.ok(calls.filter((c) => c.path === '/api/apps').every((c) => c.headers.authorization === undefined));
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: no instance token → a clear refusal, nothing sent anonymously', async () => {
  delete process.env.AURA_INSTANCE_TOKEN;
  const calls = fakeNotifOs(() => [201, { notification: notif(), warnings: [] }]);
  const r = await call(await connect(), 'create_notification', { title: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /AURA_INSTANCE_TOKEN/);
  assert.equal(calls.length, 0);
});

test('wait_for_answer: bounded long-poll; pending → call again; resolved carries the answer; never deduplicated', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    let resolved = false;
    const calls = fakeNotifOs(({ path, query }) => {
      if (path === `/api/notifications/${NID}`) return [200, resolved ? notif({ state: 'resolved', answer: { button: 'yes' } }) : notif()];
      return [404, {}];
    });
    const client = await connect();
    const p = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 3 });
    assert.equal(p.structuredContent.status, 'pending');
    assert.match(p.structuredContent.next, /call wait_for_answer/);
    assert.deepEqual(calls[0].query, { waitFor: 'resolved', timeout: '3' });
    assert.equal(calls[0].headers.authorization, 'Bearer tok');
    resolved = true;
    // the same call right away must NOT be absorbed — it is a new wait
    const r = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 3 });
    assert.equal(r.structuredContent.status, 'resolved');
    assert.deepEqual(r.structuredContent.answer, { button: 'yes' });
    assert.equal(r.structuredContent.deduplicated, undefined);
    // default 20 s, capped at 25
    await call(client, 'wait_for_answer', { id: NID });
    assert.equal(calls.at(-1).query.timeout, '20');
    const tooLong = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 60 });
    assert.equal(tooLong.isError, true);
    // repeated waits never trip the read-loop brake
    for (let i = 0; i < 6; i++) assert.equal((await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 0 })).structuredContent.status, 'resolved');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('wait_for_answer interactions: returns a click while open, pins the baseline, and next carries after', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    let li = { componentId: 'ping', kind: 'button', at: 1000, actor: {} };
    const calls = fakeNotifOs(({ path, query }) => {
      if (path !== `/api/notifications/${NID}`) return [404, {}];
      if (query.waitFor === 'interaction' && Number(query.after) < 2000) li = { componentId: 'note', kind: 'input', value: 'hi', at: 2000, actor: {} };
      return [200, notif({ lastInteraction: li })];
    });
    const client = await connect();
    const r = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 3, interactions: true });
    assert.equal(calls[0].query.waitFor, undefined, 'a plain get first fixes the baseline');
    assert.deepEqual(calls[1].query, { waitFor: 'interaction', after: '1000', timeout: '3' });
    const sc = r.structuredContent;
    assert.equal(sc.status, 'interaction');
    assert.deepEqual(sc.interaction, { componentId: 'note', kind: 'input', value: 'hi', at: 2000 });
    assert.match(sc.next, /after: 2000/);
    assert.equal(sc.notification.lastInteraction.at, 2000);
    const p = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 0, interactions: true, after: 2000 });
    assert.equal(p.structuredContent.status, 'pending');
    assert.match(p.structuredContent.next, /interactions: true, after: 2000/);
    assert.equal(calls.at(-1).query.after, '2000');
    const bad = await call(client, 'wait_for_answer', { id: NID, after: 5 });
    assert.equal(bad.isError, true);
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: blocking / scope are forwarded; their downgrade reaches the agent; force-removed is reported', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') {
        return [201, { ok: true, notification: notif({ blocking: false, scope: 'auto' }), warnings: [
          { code: 'downgraded', field: 'blocking', from: true, to: false, message: "blocking only applies to the sender's own window: agents cannot block a window" },
          { code: 'downgraded', field: 'scope', from: 'desktop', to: 'auto', message: 'desktop-wide dialogues are reserved for AuraOS system decisions' },
        ] }];
      }
      if (path === `/api/notifications/${NID}`) return [200, notif({ type: 'locked', state: 'removed', removedReason: 'force-removed' })];
      return [404, {}];
    });
    const client = await connect();
    const r = await call(client, 'create_notification', {
      type: 'dialogue', title: 'Deploy?', blocking: true, scope: 'desktop', context: { kind: 'activity', id: 'x#a1' },
    });
    assert.equal(calls[0].body.blocking, true);
    assert.equal(calls[0].body.scope, 'desktop');
    const sc = r.structuredContent;
    assert.match(sc.summary, /blocking: true → false/);
    assert.match(sc.summary, /scope: desktop → auto/);
    assert.ok(sc.warnings.some((w) => /reserved for AuraOS/.test(w.message)));
    assert.equal(sc.notification.blocking, undefined, 'not blocking → omitted from the view');
    const w = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 0 });
    assert.equal(w.structuredContent.status, 'removed');
    assert.equal(w.structuredContent.removedReason, 'force-removed');
    const g = await call(client, 'get_notification', { id: NID });
    assert.equal(g.structuredContent.notification.removedReason, 'force-removed');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: select / combobox components are forwarded; > 50 options refused', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') return [201, { ok: true, notification: notif({ type: 'dialogue' }), warnings: [] }];
      return [404, {}];
    });
    const client = await connect();
    const opts = Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, label: `O ${i}` }));
    const components = [
      { kind: 'select', id: 'region', label: 'Region', required: true, default: 'o1', options: opts },
      { kind: 'combobox', id: 'owner', allowCustom: true, options: [] },
    ];
    const r = await call(client, 'create_notification', { type: 'dialogue', title: 'Where?', components });
    assert.equal(r.isError, undefined);
    assert.deepEqual(calls[0].body.components, components);
    const tooMany = await call(client, 'create_notification', { type: 'dialogue', title: 'x', components: [{ kind: 'select', id: 's', options: [...opts, { id: 'z', label: 'Z' }] }] });
    assert.equal(tooMany.isError, true);
    assert.equal(calls.length, 1, 'refused before sending');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: markdown components (reports) are forwarded; > 2, > 64 KB or a bad maxHeight are refused before sending', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') return [201, { ok: true, notification: notif({ type: 'dialogue' }), warnings: [] }];
      return [404, {}];
    });
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const create = tools.find((t) => t.name === 'create_notification');
    assert.match(create.description, /markdown/);
    assert.match(JSON.stringify(create.inputSchema), /"markdown"/);
    assert.match(JSON.stringify(tools.find((t) => t.name === 'update_notification').inputSchema), /"markdown"/);
    const components = [
      { kind: 'markdown', id: 'report', label: 'Report', text: '# Done\n\n' + 'x'.repeat(60_000), view: 'rendered', maxHeight: 'auto' },
      { kind: 'markdown', id: 'notes', text: '- a', editable: true, required: true, maxHeight: 400 },
    ];
    const r = await call(client, 'create_notification', { type: 'dialogue', title: 'Report', components });
    assert.equal(r.isError, undefined);
    assert.deepEqual(calls[0].body.components, components);
    for (const bad of [
      ['a', 'b', 'c'].map((id) => ({ kind: 'markdown', id, text: 't' })),
      [{ kind: 'markdown', id: 'm', text: 'x'.repeat(65_537) }],
      [{ kind: 'markdown', id: 'm', text: 't', maxHeight: 20 }],
      [{ kind: 'markdown', id: 'm', text: 't', view: 'html' }],
    ]) assert.equal((await call(client, 'create_notification', { type: 'dialogue', title: 'x', components: bad })).isError, true);
    assert.equal(calls.length, 1, 'refused before sending');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: options display + descriptions are forwarded; mismatches refused before sending', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') return [201, { ok: true, notification: notif({ type: 'dialogue' }), warnings: [] }];
      return [404, {}];
    });
    const client = await connect();
    const radio = { kind: 'options', id: 'when', display: 'radio', options: Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, label: `O${i}`, description: `about ${i}` })) };
    const r = await call(client, 'create_notification', { type: 'dialogue', title: 'When?', components: [radio] });
    assert.equal(r.isError, undefined);
    assert.deepEqual(calls[0].body.components, [radio]);
    for (const bad of [
      { kind: 'options', id: 'x', options: radio.options.slice(0, 5) },                         // segmented > 4
      { kind: 'options', id: 'x', multiple: true, display: 'radio', options: radio.options.slice(0, 2) },
      { kind: 'options', id: 'x', display: 'checkbox', options: radio.options.slice(0, 2) },
    ]) assert.equal((await call(client, 'create_notification', { type: 'dialogue', title: 'x', components: [bad] })).isError, true);
    assert.equal(calls.length, 1);
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: role buttons are forwarded; wait_for_answer / get_notification report the outcome', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    let cancelled = true;
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') return [201, { ok: true, notification: notif(), warnings: [] }];
      if (path === `/api/notifications/${NID}`) {
        return [200, cancelled
          ? notif({ state: 'resolved', outcome: 'cancelled', answer: { outcome: 'cancelled', buttonId: 'cancel' } })
          : notif({ state: 'resolved', answer: { buttonId: 'yes' } })];
      }
      return [404, {}];
    });
    const client = await connect();
    await call(client, 'create_notification', { type: 'dialogue', title: 'Deploy?', components: [{ kind: 'button', role: 'cancel', label: 'No thanks' }, { kind: 'button', role: 'submit' }] });
    assert.deepEqual(calls[0].body.components, [{ kind: 'button', role: 'cancel', label: 'No thanks' }, { kind: 'button', role: 'submit' }]);
    const w = await call(client, 'wait_for_answer', { id: NID, timeoutSeconds: 0 });
    assert.equal(w.structuredContent.status, 'resolved');
    assert.equal(w.structuredContent.outcome, 'cancelled');
    assert.match(w.structuredContent.summary, /Cancelled by the user/);
    cancelled = false;
    const g = await call(client, 'get_notification', { id: NID });
    assert.equal(g.structuredContent.notification.outcome, 'submitted');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: update / remove / list / get; 403 + 404 come back readable', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (path === '/api/notifications/ntf_0mvjsforbidden000') return [403, { error: 'a verified sender may only change its own notifications' }];
      if (method === 'PATCH') return [200, { notification: notif({ title: 'Deploy 1.4?' }), warnings: [] }];
      if (method === 'POST' && path.endsWith('/remove')) return [200, notif({ state: 'removed', removedReason: 'completed' })];
      if (method === 'GET' && path === '/api/notifications') return [200, { items: [notif(), notif({ id: 'ntf_0mvjsabcd99999999', state: 'resolved', answer: 'ok' })] }];
      if (path === '/api/notifications/ntf_0mvjsmissing00000') return [404, { error: 'notification not found' }];
      return [200, notif()];
    });
    const client = await connect();
    const u = await call(client, 'update_notification', { id: NID, title: 'Deploy 1.4?', components: [{ kind: 'progress', value: 0.5 }], agent: 'tester' });
    assert.equal(u.structuredContent.notification.title, 'Deploy 1.4?');
    assert.deepEqual(calls[0].body, { title: 'Deploy 1.4?', components: [{ kind: 'progress', value: 0.5 }], sender: { actor: { name: 'tester' } } });
    const l = await call(client, 'list_notifications', { state: 'all' });
    assert.equal(l.structuredContent.notifications.length, 2);
    assert.equal(l.structuredContent.notifications[1].answer, 'ok');
    assert.equal((await call(client, 'get_notification', { id: NID })).structuredContent.notification.state, 'active');
    const rm = await call(client, 'remove_notification', { id: NID });
    assert.equal(rm.structuredContent.notification.removedReason, 'completed');
    assert.ok(calls.every((c) => c.headers.authorization === 'Bearer tok'));
    const missing = await call(client, 'get_notification', { id: 'ntf_0mvjsmissing00000' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No such notification/);
    const forbidden = await call(client, 'update_notification', { id: 'ntf_0mvjsforbidden000', title: 'x' });
    assert.equal(forbidden.isError, true);
    assert.match(forbidden.content[0].text, /Refused: a verified sender may only change its own/);
    const bad = await call(client, 'get_notification', { id: 'not-an-id' });
    assert.equal(bad.isError, true);
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('the display actor falls back to x-aura-agent, then user-agent; the argument wins', async () => {
  assert.equal(agentFromHeaders({ 'x-aura-agent': 'Claude Code', 'user-agent': 'node' }), 'Claude Code');
  assert.equal(agentFromHeaders({ 'user-agent': 'codex/1.0' }), 'codex/1.0');
  assert.equal(agentFromHeaders({}), undefined);
  assert.equal(agentFromHeaders(undefined), undefined);

  // Through the real HTTP route: the header reaches sender.actor.
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(() => [201, { notification: notif(), warnings: [] }]);
    const { createMcpRoute } = await import('../src/mcp/serve.ts');
    const route = createMcpRoute(buildShellServer);
    const rpc = (body) => route({ request: new Request('http://svc/api/mcp/shell', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-aura-agent': 'header-agent' },
      body: JSON.stringify(body),
    }) });
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(init.status, 200);
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_notification', arguments: { title: 'via http' } } });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.at(-1).body.sender, { actor: { name: 'header-agent' } });
    await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_notification', arguments: { title: 'arg wins', agent: 'arg-agent' } } });
    assert.deepEqual(calls.at(-1).body.sender, { actor: { name: 'arg-agent' } });
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});

test('notification tools: popupDurationMs is forwarded on create and update (null = default)', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  try {
    const calls = fakeNotifOs(({ method, path }) => {
      if (method === 'POST' && path === '/api/notifications') return [201, { ok: true, notification: notif({ popupDurationMs: -1 }), warnings: [] }];
      if (method === 'PATCH' && path === `/api/notifications/${NID}`) return [200, { notification: notif({}), warnings: [] }];
      return [404, {}];
    });
    const client = await connect();
    const r = await call(client, 'create_notification', { title: 'Sticky', popupDurationMs: -1 });
    assert.equal(r.isError, undefined);
    assert.equal(calls[0].body.popupDurationMs, -1);
    await call(client, 'update_notification', { id: NID, popupDurationMs: 5000 });
    assert.equal(calls.at(-1).body.popupDurationMs, 5000);
    await call(client, 'update_notification', { id: NID, popupDurationMs: null });
    assert.equal(calls.at(-1).body.popupDurationMs, null);
    const bad = await call(client, 'create_notification', { title: 'x', popupDurationMs: 90_000_000 });
    assert.equal(bad.isError, true, 'over 24 h is refused by the tool schema');
  } finally { delete process.env.AURA_INSTANCE_TOKEN; }
});
