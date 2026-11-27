// Aura Docs — production supervisor (runs `next build` + `next start`).
//
// Why not `next dev`: a Next dev server keeps its whole module graph, HMR
// history and source maps in memory for as long as it lives. With
// `backgroundService: true` this app lives as long as the shell, and on
// 2026-11-19 it had grown to 11 GB and pushed the host into swap. A
// production build serves the same pages from a flat ~150 MB process.
//
// Why it still feels like a dev server: this supervisor watches the content
// and app sources; on a change it rebuilds into a staging dir (the old build
// keeps serving meanwhile), then swaps the build and restarts `next start`.
// A page edit shows up after one build (~30-60 s) instead of instantly —
// for heavy layout work switch to dev mode (see entrypoint.sh).
//
// One build, served from `/`: the window opens on Docs' App Host, the
// runner calls /api/lifecycle/* directly, and the shell proxy strips
// `/api/proxy/<id>` from the agents' MCP, so it arrives as `/mcp`.
//
// This process owns $APP_PORT and passes every request to `next start` on a
// loopback port. That front is what keeps the port answering while there is
// no `next start` (the first build, a swap): it replies to
// /api/lifecycle/health with the identity body the AppManager's spawn gate
// expects, so a cold boot never trips the 60 s health deadline; everything
// else gets a 503 "building" page.
//
// Usage: node serve.mjs              serve (build first if stale)
//        node serve.mjs --build-only just build (CI, pre-warming)
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import {
  existsSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, renameSync, watch,
} from 'node:fs';
import { join } from 'node:path';
import {
  LIFECYCLE_TOKEN_HEADER, lifecycleRequestRefused,
} from '@aura/app-sdk/runtime/lifecycle-guard';

const ROOT = process.cwd();
const PORT = Number(process.env.APP_PORT || 4101);
const APP_ID = process.env.APP_ID || 'com.aura.docs';
const INSTANCE_ID = process.env.APP_INSTANCE_ID || APP_ID;
const STAMP = 'aura-build.json';
/** Everything a build depends on. Directories are walked recursively. */
const SOURCES = [
  'content', 'app', 'lib',
  'mdx-components.tsx', 'proxy.ts', 'next.config.mjs', 'source.config.ts',
  'postcss.config.mjs', 'package.json',
  // The SDK is bundled into the build (runtime/next, the lifecycle guard): a new one rebuilds.
  'node_modules/@aura/app-sdk/dist',
  // NOT tsconfig.json: `next build` rewrites its `include` on every run,
  // which would make every build look like a new source change.
];
const SERVE_HEAP_MB = process.env.DOCS_HEAP_MB || '768';
const BUILD_HEAP_MB = process.env.DOCS_BUILD_HEAP_MB || '2048';
const DEBOUNCE_MS = 1500;
const READY_TIMEOUT_MS = 60_000;
const NEXT_BIN = join(ROOT, 'node_modules/next/dist/bin/next');
const TAG = `[${APP_ID}]`;

const log = (...a) => console.log(TAG, ...a);

const DIST = '.next';
const STAGING = '.next-staging';

/** The build's `next start`. */
const next = {
  server: null,    // running `next start`
  port: null,      // its loopback port
  ready: false,    // accepting connections
  stopping: false, // killed on purpose
  lastBuilt: null,
};

// ---------------------------------------------------------------------------
//  Fingerprint: newest mtime over every source path (dirs included, so a
//  deleted file bumps its parent). Cheap: content/ is a few hundred KB.
// ---------------------------------------------------------------------------
function fingerprint() {
  let newest = 0;
  let count = 0;
  const visit = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    count++;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) for (const n of readdirSync(p)) visit(join(p, n));
  };
  for (const s of SOURCES) visit(join(ROOT, s));
  return { newest, count };
}

function readStamp() {
  try { return JSON.parse(readFileSync(join(ROOT, DIST, STAMP), 'utf8')); } catch { return null; }
}

function isStale(fp) {
  if (!existsSync(join(ROOT, DIST, 'BUILD_ID'))) return 'no build';
  const s = readStamp();
  if (!s) return 'no build stamp';
  if (s.newest < fp.newest || s.count !== fp.count) return 'sources changed';
  return null;
}

// ---------------------------------------------------------------------------
//  Build into STAGING, then swap into DIST (caller stops the server first).
// ---------------------------------------------------------------------------
function run(args, env, heapMb) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], {
      cwd: ROOT, stdio: 'inherit',
      env: {
        ...process.env, ...env,
        NEXT_TELEMETRY_DISABLED: '1',
        // The runner exports a non-standard NODE_ENV; Next wants production.
        NODE_ENV: 'production',
        NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
      },
    });
    child.on('exit', (code, sig) => resolve({ child, code, sig }));
    child.on('error', (e) => { log('spawn failed:', e.message); resolve({ child, code: 1, sig: null }); });
    run.last = child;
  });
}

async function buildStaging(fp) {
  rmSync(join(ROOT, STAGING), { recursive: true, force: true });
  const t0 = Date.now();
  log(`next build → ${STAGING}`);
  const { code } = await run(['build'], { NEXT_DIST_DIR: STAGING }, BUILD_HEAP_MB);
  if (code !== 0) { log(`build FAILED (exit ${code}) — keeping the previous build`); return false; }
  writeFileSync(join(ROOT, STAGING, STAMP), JSON.stringify({
    newest: fp.newest, count: fp.count, builtAt: new Date().toISOString(),
  }));
  // `next build` rewrites next-env.d.ts to reference the dist dir it built
  // into; point it back at `.next` (keeps git clean — this file is tracked).
  try {
    const envDts = join(ROOT, 'next-env.d.ts');
    const txt = readFileSync(envDts, 'utf8');
    const fixed = txt.replace(/\.\/\.next[A-Za-z-]*\//g, './.next/');
    if (fixed !== txt) writeFileSync(envDts, fixed);
  } catch { /* file optional */ }
  log(`build ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

function swapStaging() {
  rmSync(join(ROOT, DIST), { recursive: true, force: true });
  renameSync(join(ROOT, STAGING), join(ROOT, DIST));
}

// ---------------------------------------------------------------------------
//  Placeholder: identity-correct health while there is no `next start`.
// ---------------------------------------------------------------------------
function identityHeaders() {
  return { 'X-Aura-App-Id': APP_ID, 'X-Aura-Instance-Id': INSTANCE_ID };
}

/**
 * The SDK's lifecycle-token check, here at the front for every request (the
 * placeholder and `next start` alike): the guard never depends on what the
 * current build bundled. True when it answered (401).
 */
function refusedLifecycle(req, res) {
  if (!lifecycleRequestRefused(req.url || '/', req.headers[LIFECYCLE_TOKEN_HEADER])) return false;
  res.writeHead(401, { 'Content-Type': 'application/json', ...identityHeaders() });
  res.end('{"ok":false,"error":"lifecycle-token-required"}');
  return true;
}

function placeholder(req, res) {
  const url = req.url || '/';
  if (/^\/api\/lifecycle\/health(\?|$)/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...identityHeaders() });
    res.end(JSON.stringify({ ok: true, appId: APP_ID, instanceId: INSTANCE_ID, building: true }));
    return;
  }
  if (/^\/api\/lifecycle\//.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...identityHeaders() });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5', ...identityHeaders() });
  res.end('<!doctype html><meta http-equiv="refresh" content="5"><title>Aura Docs</title>'
    + '<body style="font-family:system-ui;padding:2rem;color:#888">Aura Docs is building… this page reloads itself.</body>');
}

// ---------------------------------------------------------------------------
//  Front: $APP_PORT, passed on to `next start`.
// ---------------------------------------------------------------------------
function forward(req, res) {
  const up = httpRequest({
    host: '127.0.0.1', port: next.port, method: req.method, path: req.url, headers: req.headers,
  }, (ures) => {
    res.writeHead(ures.statusCode ?? 502, ures.headers);
    ures.pipe(res);
  });
  up.on('error', () => {
    if (res.headersSent) res.destroy();
    else placeholder(req, res);
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

function startFront() {
  const srv = createServer((req, res) => {
    if (refusedLifecycle(req, res)) return;
    if (next.ready) forward(req, res); else placeholder(req, res);
  });
  // A production build opens no WebSocket.
  srv.on('upgrade', (_req, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(PORT, '0.0.0.0', () => resolve(srv));
  });
}

// ---------------------------------------------------------------------------
//  Serve loop
// ---------------------------------------------------------------------------
let shuttingDown = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function accepting(port) {
  return new Promise((resolve) => {
    const c = connect({ host: '127.0.0.1', port }, () => { c.destroy(); resolve(true); });
    c.on('error', () => resolve(false));
  });
}

async function startServer() {
  next.stopping = false;
  next.port = await freePort();
  const p = run(['start', '--hostname', '127.0.0.1', '--port', String(next.port)],
    { NEXT_DIST_DIR: DIST }, SERVE_HEAP_MB);
  const child = run.last;
  next.server = child;
  log(`next start on 127.0.0.1:${next.port} (heap ≤ ${SERVE_HEAP_MB} MB, pid ${child.pid})`);
  p.then(({ code, sig }) => {
    if (next.stopping || shuttingDown) return;
    log(`next start exited unexpectedly (code=${code} sig=${sig}) — giving up so the OS sees the crash`);
    process.exit(code ?? 1);
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (child.exitCode === null && !(await accepting(next.port))) {
    if (Date.now() > deadline) { log(`next start not accepting after ${READY_TIMEOUT_MS / 1000}s`); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode === null && next.server === child) next.ready = true;
}

function stopServer() {
  next.ready = false;
  return new Promise((resolve) => {
    if (!next.server || next.server.exitCode !== null) return resolve();
    next.stopping = true;
    const s = next.server;
    const t = setTimeout(() => { try { s.kill('SIGKILL'); } catch {} }, 8000);
    s.once('exit', () => { clearTimeout(t); resolve(); });
    s.kill('SIGTERM');
  });
}

/** Build when stale; used at boot and by --build-only. */
async function prepare() {
  const fp = fingerprint();
  const why = isStale(fp);
  if (why) {
    log(`build is stale: ${why}`);
    const ok = await buildStaging(fp);
    if (!ok) throw new Error('build failed');
    swapStaging();
  } else {
    log(`build is current (${readStamp()?.builtAt ?? 'unknown'})`);
  }
  next.lastBuilt = fp;
}

let building = false;
let pending = false;

async function rebuildIfChanged(reason) {
  if (building) { pending = true; return; }
  building = true;
  try {
    const fp = fingerprint();
    if (next.lastBuilt && fp.newest === next.lastBuilt.newest && fp.count === next.lastBuilt.count) return;
    log(`change detected (${reason}) — rebuilding`);
    const ok = await buildStaging(fp);
    if (!ok) { next.lastBuilt = fp; return; } // don't loop on a broken edit; next change retries
    await stopServer();   // this process answers with the placeholder meanwhile
    swapStaging();
    await startServer();
    next.lastBuilt = fp;
  } finally {
    building = false;
    if (pending) { pending = false; void rebuildIfChanged('queued change'); }
  }
}

function startWatcher() {
  let timer = null;
  const kick = (what) => {
    if (/(^|\/)(\.next[A-Za-z-]*|node_modules|\.source)(\/|$)/.test(what)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rebuildIfChanged(what), DEBOUNCE_MS);
  };
  for (const s of SOURCES) {
    const p = join(ROOT, s);
    if (!existsSync(p)) continue;
    const recursive = statSync(p).isDirectory();
    try {
      watch(p, { recursive, persistent: true }, (_ev, file) => kick(`${s}/${file ?? ''}`));
    } catch (e) { log(`watch ${s} failed: ${e.message}`); }
  }
  log(`watching ${SOURCES.join(', ')} — edits rebuild + restart automatically`);
}

async function main() {
  // The second build of the old two-route layout.
  for (const d of ['.next-host', '.next-host-staging']) rmSync(join(ROOT, d), { recursive: true, force: true });
  if (process.argv.includes('--build-only')) {
    try { await prepare(); } catch { process.exit(1); }
    return;
  }
  await startFront();
  building = true;
  try {
    await prepare();
    await startServer();
  } catch (e) {
    log(`fatal: ${e.message}`);
    process.exit(1);
  } finally {
    building = false;
  }
  startWatcher();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — stopping`);
    await stopServer();
    process.exit(0);
  });
}

main().catch((e) => { log('fatal:', e); process.exit(1); });
