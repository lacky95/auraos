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

test('tools/list exposes the seven tools with schemas', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['get_screen', 'kill_session', 'list_sessions', 'open_session', 'run_command', 'send_keys', 'type_text']);
  const screen = tools.find((t) => t.name === 'get_screen');
  assert.equal(screen.inputSchema.type, 'object');
  assert.deepEqual(screen.inputSchema.required, ['session']);
  assert.equal(screen.annotations.readOnlyHint, true);
});

test('list_sessions falls back to the local instance when the OS API is down', async () => {
  const { client } = await connect();
  const r = await client.callTool({ name: 'list_sessions', arguments: {} });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(r.structuredContent.instances.map((i) => i.instanceId), ['com.aura.terminal-7']);
});

test('bad arguments and unreachable sessions are isError results', async () => {
  const { client } = await connect();
  const badId = await client.callTool({ name: 'get_screen', arguments: { session: 'nonsense' } });
  assert.equal(badId.isError, true);
  assert.match(badId.content[0].text, /not a session id/);

  const noTmux = await client.callTool({ name: 'send_keys', arguments: { session: 'com.aura.terminal-7#a1', keys: ['Enter'] } });
  assert.equal(noTmux.isError, true);
  assert.match(noTmux.content[0].text, /tmux is disabled/);

  const badArgs = await client.callTool({ name: 'send_keys', arguments: { session: 'com.aura.terminal-7#a1' } });
  assert.equal(badArgs.isError, true);
  assert.match(badArgs.content[0].text, /Invalid arguments for send_keys/);

  const remote = await client.callTool({ name: 'kill_session', arguments: { session: 'com.aura.terminal-8#a1' } });
  assert.equal(remote.isError, true);
  assert.match(remote.content[0].text, /com\.aura\.terminal-8/);
});
