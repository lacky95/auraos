// The MCP surface itself, in-process over an in-memory transport: the tool
// list is what the docs promise, arguments are validated, and every failure
// comes back as an isError result rather than a transport error.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AURA_TERM_TMUX = '0';                 // no tmux needed here
process.env.OS_API_BASE = 'http://127.0.0.1:9';   // nothing listens: forces the local fallback
process.env.APP_INSTANCE_ID = 'com.aura.terminal-7';

const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildTerminalServer();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return { client, server };
}

test('tools/list: the agent tool set; dialog tools hidden unless review mode', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['act', 'get_screen', 'get_status', 'kill_session', 'list_sessions', 'open_session', 'run_command', 'select_menu_option', 'select_option', 'send_keys', 'type_text']);
  const screen = tools.find((t) => t.name === 'get_screen');
  assert.equal(screen.inputSchema.type, 'object');
  assert.ok(screen.inputSchema.properties.target, 'target field');
  assert.ok(screen.inputSchema.properties.session, 'deprecated session alias kept');
  assert.equal(screen.inputSchema.required, undefined, 'target is optional (default target)');
  assert.equal(screen.annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'kill_session').annotations.destructiveHint, true);
});

test('list_sessions falls back to the local instance when the OS API is down, flagged degraded', async () => {
  const { client } = await connect();
  const r = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.instances.map((i) => i.instanceId), ['com.aura.terminal-7']);
  assert.equal(r.structuredContent.degraded, true);
  assert.equal(r.structuredContent.default_target, null);
  assert.ok(!r.content[0].text.includes('\n  '), 'compact JSON text, not pretty-printed');
});

test('errors are structured { code, message, hint, candidates }', async () => {
  const { client } = await connect();
  const badId = await client.callTool({ name: 'get_screen', arguments: { target: 'nonsense' } });
  assert.equal(badId.isError, true);
  assert.match(badId.content[0].text, /not a session id/);
  assert.equal(badId.structuredContent.error.code, 'unknown-target');
  assert.ok(badId.structuredContent.error.hint);

  // Masked id and no sessions at all: no default target, says why.
  const masked = await client.callTool({ name: 'get_screen', arguments: { session: '***' } });
  assert.equal(masked.isError, true);
  assert.equal(masked.structuredContent.error.code, 'no-target');
  assert.match(masked.structuredContent.error.hint, /masked placeholder/);

  const noTmux = await client.callTool({ name: 'send_keys', arguments: { target: 'com.aura.terminal-7#a1', keys: ['Enter'] } });
  assert.equal(noTmux.isError, true);
  assert.match(noTmux.content[0].text, /tmux is disabled/);
  assert.equal(noTmux.structuredContent.error.code, 'tmux-disabled');

  const deprecated = await client.callTool({ name: 'send_keys', arguments: { session: 'com.aura.terminal-7#a1', keys: ['Enter'] } });
  assert.match(deprecated.content[0].text, /tmux is disabled/, 'the session alias still addresses the session');

  const badArgs = await client.callTool({ name: 'send_keys', arguments: { target: 'com.aura.terminal-7#a1' } });
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.content[0].text, /Invalid arguments for send_keys/);

  const typo = await client.callTool({ name: 'send_keys', arguments: { target: 'com.aura.terminal-7#a1', keys: ['Enterr'] } });
  assert.equal(typo.structuredContent.error.code, 'bad-key');

  const remote = await client.callTool({ name: 'kill_session', arguments: { target: 'com.aura.terminal-8#a1', confirm: true } });
  assert.equal(remote.isError, true);
  assert.match(remote.content[0].text, /com\.aura\.terminal-8/);
  assert.ok(remote.structuredContent.error.hint, 'unreachable instance carries a hint');
});

test('kill_session and open_session instance:"new" need explicit confirmation', async () => {
  const { client } = await connect();
  const kill = await client.callTool({ name: 'kill_session', arguments: { target: 'com.aura.terminal-8#a1' } });
  assert.ok(!kill.isError);
  assert.equal(kill.structuredContent.refused, true);
  assert.equal(kill.structuredContent.target_used, 'com.aura.terminal-8#a1');

  const open = await client.callTool({ name: 'open_session', arguments: { instance: 'new' } });
  assert.ok(!open.isError);
  assert.equal(open.structuredContent.refused, true);

  const notRunning = await client.callTool({ name: 'open_session', arguments: { instance: 'com.aura.terminal-99' } });
  // The OS API is down in this test (degraded listing), so an unknown instance cannot be ruled out;
  // the call then fails on reaching it rather than claiming it is not running.
  assert.equal(notRunning.isError, true);
});

test('hidden dialog tools still answer by name', async () => {
  const { client } = await connect();
  const r = await client.callTool({ name: 'get_dialog', arguments: { target: 'com.aura.terminal-8#a1' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /com\.aura\.terminal-8/);
});
