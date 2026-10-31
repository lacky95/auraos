// The logs MCP in-process over an in-memory transport: tool list, results
// and errors, against a temp log file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG = join(mkdtempSync(join(tmpdir(), 'console-mcp-')), 'console.log');
process.env.AURA_CONSOLE_LOG = LOG;

const T0 = Date.UTC(2026, 9, 31, 14, 0, 0, 0);
const entries = [
  { type: 'aura.console', level: 'log',   timestamp: T0,          source: 'shell',          args: ['desktop ready'] },
  { type: 'aura.console', level: 'error', timestamp: T0 + 1000,   source: 'io.lakner.foo',  args: ['fetch failed', 'ECONNRESET'] },
  { type: 'aura.console', level: 'warn',  timestamp: T0 + 2000,   source: 'io.lakner.foo',  args: ['retrying'] },
  { type: 'aura.console', level: 'info',  timestamp: T0 + 3000,   source: 'com.aura.notepad', args: ['saved note 12'] },
];
writeFileSync(LOG, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

const { buildLogsServer } = await import('../src/mcp/logs.ts');
const { emitLogEntry } = await import('../src/log-server.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildLogsServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

test('tools/list: four read-only tools with object schemas', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_sources', 'search_logs', 'tail_logs', 'wait_for_log']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.$schema, undefined);
  }
  assert.deepEqual(tools.find((t) => t.name === 'search_logs').inputSchema.required, ['query']);
  assert.deepEqual(tools.find((t) => t.name === 'tail_logs').inputSchema.properties.levels.items.enum, ['log', 'info', 'warn', 'error', 'debug']);
});

test('tail_logs: newest first-in-order, trailer, structured counts', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'tail_logs', arguments: { limit: 2 } });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.entries.map((e) => e.args[0]), ['retrying', 'saved note 12']);
  assert.equal(r.structuredContent.matched, 4);
  assert.equal(r.structuredContent.shown, 2);
  assert.equal(r.structuredContent.window_truncated, false);
  const lines = r.content[0].text.split('\n');
  assert.equal(lines[0], '2026-10-31T14:00:02.000Z WARN  [io.lakner.foo] retrying');
  assert.equal(lines.at(-1), '— 2 shown of 4 matched (4 scanned, window: last 4 MiB, whole file)');
});

test('tail_logs filters: source + levels + since; an empty result is not an error', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'tail_logs', arguments: { source: 'io.lakner.foo', levels: ['error'] } });
  assert.deepEqual(r.structuredContent.entries.map((e) => e.args.join(' ')), ['fetch failed ECONNRESET']);
  const none = await client.callTool({ name: 'tail_logs', arguments: { source: 'nobody' } });
  assert.ok(!none.isError);
  assert.equal(none.structuredContent.matched, 0);
  assert.match(none.content[0].text, /^\(no matching entries; 4 scanned/);
  const since = await client.callTool({ name: 'tail_logs', arguments: { since: new Date(T0 + 2500).toISOString() } });
  assert.equal(since.structuredContent.matched, 1);
});

test('search_logs: regex query, bad regex and bad since are bad-arguments', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'search_logs', arguments: { query: '/econn|saved/' } });
  assert.deepEqual(r.structuredContent.entries.map((e) => e.source), ['io.lakner.foo', 'com.aura.notepad']);
  assert.match(r.content[0].text, /window: last 16 MiB/);
  const bad = await client.callTool({ name: 'search_logs', arguments: { query: '/[/' } });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error.code, 'bad-arguments');
  const badSince = await client.callTool({ name: 'tail_logs', arguments: { since: 'later' } });
  assert.equal(badSince.structuredContent.error.code, 'bad-arguments');
  const missing = await client.callTool({ name: 'search_logs', arguments: {} });
  assert.equal(missing.structuredContent.error.code, 'bad-arguments');
});

test('list_sources: counts per source, most recently active first', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'list_sources', arguments: {} });
  assert.deepEqual(r.structuredContent.sources.map((s) => [s.source, s.count]), [['com.aura.notepad', 1], ['io.lakner.foo', 2], ['shell', 1]]);
  assert.equal(r.structuredContent.sources[1].byLevel.error, 1);
  assert.equal(r.content[0].text.split('\n')[0], 'source            count  error  warn  last');
  assert.equal(r.content[0].text.split('\n')[2], 'io.lakner.foo         2      1     1  2026-10-31T14:00:02.000Z');
});

test('wait_for_log resolves on the next matching arrival and ignores others', async () => {
  const client = await connect();
  const pending = client.callTool({ name: 'wait_for_log', arguments: { contains: 'smoke', levels: ['warn'], timeout_ms: 5000 } });
  await new Promise((r) => setTimeout(r, 20));
  emitLogEntry({ type: 'aura.console', level: 'log', timestamp: Date.now(), source: 'x', args: ['smoke but wrong level'] });
  emitLogEntry({ type: 'aura.console', level: 'warn', timestamp: Date.now(), source: 'x', args: ['no match'] });
  emitLogEntry({ type: 'aura.console', level: 'warn', timestamp: Date.now(), source: 'io.lakner.foo', args: ['mcp-smoke ok'] });
  const r = await pending;
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.timed_out, false);
  assert.equal(r.structuredContent.entry.args[0], 'mcp-smoke ok');
  assert.match(r.content[0].text, /WARN {2}\[io\.lakner\.foo\] mcp-smoke ok$/);
});

test('wait_for_log times out as a normal result', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'wait_for_log', arguments: { contains: 'never', timeout_ms: 100 } });
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.timed_out, true);
  assert.equal(r.structuredContent.entry, null);
});

test('unknown tool is an isError result naming the tools', async () => {
  const client = await connect();
  const r = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.error.code, 'unknown-tool');
  assert.match(r.content[0].text, /tail_logs/);
});
