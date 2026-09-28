/**
 * Unit test for per-MCP-server blocking/non-blocking (app-level async):
 *   1. fast tool on a non-blocking server → normal result, no placeholder
 *   2. slow tool on a non-blocking server → `working` placeholder at ~2.5 s,
 *      real result via onAsyncResult when it finishes
 *   3. slow tool on a BLOCKING server → single full-wait response
 *   4. default (behavior field missing) ⇒ non-blocking
 *   5. callBridge deferred injection: queued while "user speaking" /
 *      mid-turn, injected via sendClientContent(turnComplete:true) once idle;
 *      huge results truncated
 * Runs against a real Streamable-HTTP MCP server started in-process.
 */
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectAll, NON_BLOCKING_PLACEHOLDER_MS } from './mcp.mjs';

const SLOW_MS = 6000;
let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
}
const now = () => Date.now();

async function startMock(port) {
  const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'fast_tool', description: 'fast', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'slow_tool', description: 'slow', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === 'fast_tool') return { content: [{ type: 'text', text: 'fast result ok' }] };
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return { content: [{ type: 'text', text: 'slow result ready value=42' }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'test-session' });
  await server.connect(transport);
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
        .catch((err) => { console.error('mock handleRequest:', err.message); res.destroy(); });
    });
  });
  await new Promise((r) => httpServer.listen(port, r));
  return httpServer;
}

let nextPort = 45123;
/** The mock transport is single-session, so each connectAll gets a fresh mock. */
async function withMock(fn) {
  const port = nextPort++;
  const mock = await startMock(port);
  try { await fn(`http://127.0.0.1:${port}/`); } finally { mock.close(); }
}

async function testDispatch() {

  // ── non-blocking server (explicit) ──
  await withMock(async (url) => {
    const asyncResults = [];
    const mcp = await connectAll([{ url, behavior: 'non-blocking' }], {
      onAsyncResult: (evt) => asyncResults.push({ ...evt, at: now() }),
    });
    check('declarations stay BLOCKING', mcp.functionDeclarations.every((d) => d.behavior === 'BLOCKING'));

    const t0 = now();
    const [fastP, slowP] = mcp.dispatchBatch([
      { id: 'function-call-1', name: 'fast_tool', args: {} },
      { id: 'function-call-2', name: 'slow_tool', args: {} },
    ]);
    const fast = await fastP;
    check('fast tool → normal result, quickly', fast.result === 'fast result ok' && now() - t0 < 2000, `dt=${now() - t0}ms`);
    const slow = await slowP;
    const dt = now() - t0;
    check('slow tool → working placeholder at ~2.5s',
      slow.status === 'working' && /Long-running/.test(slow.note) && dt > NON_BLOCKING_PLACEHOLDER_MS - 200 && dt < NON_BLOCKING_PLACEHOLDER_MS + 1500,
      `dt=${dt}ms`);
    check('no async result yet at placeholder time', asyncResults.length === 0);
    await new Promise((r) => setTimeout(r, SLOW_MS));
    check('real result handed to onAsyncResult',
      asyncResults.length === 1 && asyncResults[0].name === 'slow_tool' && asyncResults[0].response?.result === 'slow result ready value=42',
      JSON.stringify(asyncResults[0] ?? null)?.slice(0, 120));
    await mcp.close();
  });

  // ── default behavior (field missing) ⇒ non-blocking ──
  await withMock(async (url) => {
    const asyncResults = [];
    const mcp = await connectAll([{ url }], { onAsyncResult: (evt) => asyncResults.push(evt) });
    const t0 = now();
    const [slowP] = mcp.dispatchBatch([{ id: 'function-call-3', name: 'slow_tool', args: {} }]);
    const slow = await slowP;
    check('missing behavior defaults to non-blocking (placeholder)', slow.status === 'working', `dt=${now() - t0}ms`);
    await new Promise((r) => setTimeout(r, SLOW_MS));
    check('…and the real result still arrives', asyncResults.length === 1);
    await mcp.close();
  });

  // ── blocking server: full wait, single response ──
  await withMock(async (url) => {
    const asyncResults = [];
    const mcp = await connectAll([{ url, behavior: 'blocking' }], { onAsyncResult: (evt) => asyncResults.push(evt) });
    const t0 = now();
    const [slowP] = mcp.dispatchBatch([{ id: 'function-call-4', name: 'slow_tool', args: {} }]);
    const slow = await slowP;
    const dt = now() - t0;
    check('blocking server: full-wait real result', slow.result === 'slow result ready value=42' && dt >= SLOW_MS - 200, `dt=${dt}ms`);
    check('blocking server: no onAsyncResult', asyncResults.length === 0);
    await mcp.close();
  });
}

async function testInjection() {
  const { CallSession } = await import('./callBridge.mjs');
  const fakeWs = { on() {}, readyState: 99, OPEN: 1, send() {}, close() {} };
  const cs = new CallSession(fakeWs);
  const sent = [];
  cs.session = { sendClientContent: (payload) => sent.push({ payload, at: now() }), close() {} };

  // Model mid-turn (accrual open) → deferred.
  cs.accrual = { role: 'model', text: 'talking…' };
  cs.onAsyncToolResult({ name: 'slow_tool', response: { result: 'X'.repeat(5000) } });
  await new Promise((r) => setTimeout(r, 300));
  check('deferred while a turn is accruing', sent.length === 0 && cs.pendingToolResults.length === 1);

  // Turn completes → retry timer picks it up.
  cs.accrual = { role: null, text: '' };
  await new Promise((r) => setTimeout(r, 1300));
  check('injected once idle', sent.length === 1);
  const turn = sent[0]?.payload;
  const text = turn?.turns?.[0]?.parts?.[0]?.text ?? '';
  check('injection shape: user turn + turnComplete',
    turn?.turnComplete === true && turn?.turns?.[0]?.role === 'user' && text.startsWith('[TOOL RESULT for slow_tool]: '));
  check('huge result truncated with note', /truncated/.test(text) && text.length < 4200, `len=${text.length}`);

  // User speaking → deferred until the speech grace window passes.
  cs.userSpeakingUntil = now() + 1500;
  cs.onAsyncToolResult({ name: 'fast_tool', response: { result: 'late but small' } });
  await new Promise((r) => setTimeout(r, 500));
  check('deferred while user is speaking', sent.length === 1);
  await new Promise((r) => setTimeout(r, 2200));
  check('injected after user speech grace', sent.length === 2 && /late but small/.test(sent[1].payload.turns[0].parts[0].text));

  // Error result formatting.
  cs.onAsyncToolResult({ name: 'fast_tool', response: { error: 'boom' } });
  await new Promise((r) => setTimeout(r, 100));
  check('error result injected as ERROR text', sent.length === 3 && /ERROR: boom/.test(sent[2].payload.turns[0].parts[0].text));

  cs.session = null;
  cs.close();
}

try {
  await testDispatch();
  await testInjection();
} catch (err) {
  console.error('TEST CRASH:', err);
  failures++;
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
