// list_sessions against a fake OS API (TM-8): paused instances are not
// queried unless asked, a slow instance costs at most ~1.2 s and comes back
// `stale` with its last known sessions, the OS instance list is cached, and
// the compact view keeps today's field names while verbose keeps everything.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hits = { instances: 0, '-1': 0, '-2': 0, '-3': 0 };
let slow = false;                       // instance -2 hangs while true
const session = (inst, n, command) => ({
  id: `com.aura.terminal${inst}#a${n}`, label: `#a${n}`, live: true, inUse: false, bytes: 42,
  cols: 80, rows: 24, alternate: false, command, title: 't', attached: 1,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/apps/com.aura.terminal/instances') {
    hits.instances++;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([
      { instanceId: 'com.aura.terminal-1', state: 'resumed' },
      { instanceId: 'com.aura.terminal-2', state: 'resumed' },
      { instanceId: 'com.aura.terminal-3', state: 'paused' },
      { instanceId: 'com.aura.terminal-9', state: 'resumed', inPool: true },
    ]));
  }
  const m = /^\/api\/proxy\/com\.aura\.terminal(-\d+)\/api\/sessions$/.exec(url.pathname);
  if (m) {
    hits[m[1]]++;
    const reply = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sessions: [session(m[1], 1, 'bash')] })); };
    if (m[1] === '-2' && slow) { setTimeout(reply, 4_000).unref(); return; }
    return reply();
  }
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.closeAllConnections(); server.close(); });

process.env.AURA_TERM_TMUX = '0';
process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'tm8-'));
process.env.OS_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.APP_INSTANCE_ID = 'com.aura.terminal-7';   // not in the OS list: every row is remote

const router = await import('../src/session-router.ts');
const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildTerminalServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

const reset = () => { router.invalidateListing(); for (const k of Object.keys(hits)) hits[k] = 0; };

test('paused instances are listed but not queried unless include_paused', async () => {
  reset();
  const { instances } = await router.listAll();
  assert.deepEqual(instances.map((i) => i.instanceId), ['com.aura.terminal-1', 'com.aura.terminal-2', 'com.aura.terminal-3']);
  const paused = instances.find((i) => i.instanceId === 'com.aura.terminal-3');
  assert.equal(paused.state, 'paused');
  assert.equal(paused.reachable, false);
  assert.match(paused.error, /include_paused/);
  assert.equal(hits['-3'], 0, 'a paused instance must not be contacted (it would resume)');

  const all = await router.listAll({ includePaused: true });
  assert.equal(hits['-3'], 1);
  const p2 = all.instances.find((i) => i.instanceId === 'com.aura.terminal-3');
  assert.equal(p2.reachable, true);
  assert.equal(p2.sessions[0].id, 'com.aura.terminal-3#a1');

  // Its last known sessions now ride along (stale) in the default listing.
  const again = (await router.listAll()).instances.find((i) => i.instanceId === 'com.aura.terminal-3');
  assert.equal(again.stale, true);
  assert.equal(again.sessions[0].id, 'com.aura.terminal-3#a1');
  assert.equal(hits['-3'], 1);
});

test('the OS instance list is cached for a few seconds', async () => {
  reset();
  await router.listAll();
  await router.listAll();
  await router.listAll();
  assert.equal(hits.instances, 1);
  router.invalidateListing();
  await router.listAll();
  assert.equal(hits.instances, 2);
});

test('a slow instance costs ~1.2 s and comes back stale with its last sessions', async () => {
  reset();
  await router.listAll();                     // -2 answers: last good list recorded
  slow = true;
  try {
    const t0 = Date.now();
    const { instances } = await router.listAll();
    const ms = Date.now() - t0;
    assert.ok(ms < 1_450, `took ${ms} ms`);
    assert.ok(ms >= 1_000, `took ${ms} ms — timeout should be ~1.2 s`);
    const row = instances.find((i) => i.instanceId === 'com.aura.terminal-2');
    assert.equal(row.reachable, false);
    assert.equal(row.stale, true);
    assert.equal(row.sessions[0].id, 'com.aura.terminal-2#a1');
    assert.equal(instances.find((i) => i.instanceId === 'com.aura.terminal-1').reachable, true);
  } finally { slow = false; }
});

test('list_sessions: compact rows keep today\'s names, verbose keeps every field, include_paused passes through', async () => {
  reset();
  const client = await connect();
  const r = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r));
  const sc = r.structuredContent;
  const row = sc.instances.find((i) => i.instanceId === 'com.aura.terminal-1').sessions[0];
  assert.deepEqual(Object.keys(row).sort(), ['alias', 'id', 'inUse', 'live', 'program', 'state']);
  assert.deepEqual(row, { id: 'com.aura.terminal-1#a1', alias: '1a1', live: true, inUse: false, program: 'shell', state: 'shell_prompt' });
  assert.deepEqual(JSON.parse(r.content[0].text), sc, 'text is the same record, compact');
  assert.ok(!r.content[0].text.includes('\n'));
  assert.equal(hits['-3'], 0);

  const v = await client.callTool({ name: 'list_sessions', arguments: { verbose: true } });
  const vrow = v.structuredContent.instances.find((i) => i.instanceId === 'com.aura.terminal-1').sessions[0];
  for (const k of ['id', 'label', 'live', 'inUse', 'bytes', 'cols', 'rows', 'alternate', 'command', 'title', 'attached']) {
    assert.ok(k in vrow, `verbose row has ${k}`);
  }

  const p = await client.callTool({ name: 'list_sessions', arguments: { include_paused: true } });
  assert.equal(p.structuredContent.instances.find((i) => i.instanceId === 'com.aura.terminal-3').reachable, true);
  assert.equal(hits['-3'], 1);
});
