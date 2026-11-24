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
// One build per frame route (Phase 2, lib/base-path.mjs): a Next basePath is
// fixed at build time, and the proxy route needs `/api/proxy/<instance>`
// while an App Host serves from `/`. This process owns $APP_PORT and passes
// each request to the `next start` of its route, picked by the App Host
// route header the shell's router sets (and strips everywhere else). The
// `proxy` build always runs: it also answers the machine paths, the
// lifecycle calls and the agents' MCP at /api/proxy/<instance>/mcp. The
// `host` build is only built and started on the first App Host request, so
// an install that never moves Docs to its App Host costs what it did before.
//
// Health: while a build has no server yet (the first build, a swap), this
// process answers /api/lifecycle/health with the identity body the
// AppManager's spawn gate expects, so a cold boot never trips the 60 s
// health deadline; everything else gets a 503 "building" page.
//
// Usage: node serve.mjs                     serve (build first if stale)
//        node serve.mjs --build-only        just build the proxy route (CI, pre-warming)
//        node serve.mjs --build-only --host also build the App Host route
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import {
  existsSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, renameSync, watch,
} from 'node:fs';
import { join } from 'node:path';
import { docsBasePath, docsInstanceId, requestRoute } from './lib/base-path.mjs';

const ROOT = process.cwd();
const PORT = Number(process.env.APP_PORT || 4101);
const APP_ID = process.env.APP_ID || 'com.aura.docs';
const INSTANCE_ID = docsInstanceId();
const STAMP = 'aura-build.json';
/** Everything a build depends on. Directories are walked recursively. */
const SOURCES = [
  'content', 'app', 'lib',
  'mdx-components.tsx', 'middleware.ts', 'next.config.mjs', 'source.config.ts',
  'postcss.config.mjs', 'package.json',
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

/** One build and its `next start`, for one frame route. */
function variant(route, dist, staging) {
  return {
    route, dist, staging,
    basePath: docsBasePath(route, INSTANCE_ID),
    wanted: false,   // serve it (and rebuild it on edits)
    starting: null,  // the first build + start in flight
    server: null,    // running `next start`
    port: null,      // its loopback port
    ready: false,    // accepting connections
    stopping: false, // killed on purpose
    lastBuilt: null,
  };
}

const VARIANTS = {
  // PHASE2-CUTOVER: the proxy build goes with the proxy route; `host` becomes the only build, in `.next`.
  proxy: variant('proxy', '.next', '.next-staging'),
  host: variant('host', '.next-host', '.next-host-staging'),
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

function readStamp(v) {
  try { return JSON.parse(readFileSync(join(ROOT, v.dist, STAMP), 'utf8')); } catch { return null; }
}

function isStale(v, fp) {
  if (!existsSync(join(ROOT, v.dist, 'BUILD_ID'))) return 'no build';
  const s = readStamp(v);
  if (!s) return 'no build stamp';
  if (s.basePath !== v.basePath) return `basePath changed (${s.basePath} → ${v.basePath})`;
  if (s.newest < fp.newest || s.count !== fp.count) return 'sources changed';
  return null;
}

// ---------------------------------------------------------------------------
//  Build into STAGING, then swap into DIST (caller stops the server first).
// ---------------------------------------------------------------------------
function run(v, args, env, heapMb) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], {
      cwd: ROOT, stdio: 'inherit',
      env: {
        ...process.env, ...env,
        // next.config.mjs picks the basePath from this, at build and start alike.
        DOCS_FRAME_ROUTE: v.route,
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

async function buildStaging(v, fp) {
  rmSync(join(ROOT, v.staging), { recursive: true, force: true });
  const t0 = Date.now();
  log(`next build → ${v.staging} (route=${v.route}, basePath=${v.basePath || '/'})`);
  const { code } = await run(v, ['build'], { NEXT_DIST_DIR: v.staging }, BUILD_HEAP_MB);
  if (code !== 0) { log(`build FAILED (exit ${code}) — keeping the previous build`); return false; }
  writeFileSync(join(ROOT, v.staging, STAMP), JSON.stringify({
    basePath: v.basePath, newest: fp.newest, count: fp.count, builtAt: new Date().toISOString(),
  }));
  // `next build` rewrites next-env.d.ts to reference the dist dir it built
  // into; point it back at `.next` whichever build ran (keeps git clean —
  // this file is tracked).
  try {
    const envDts = join(ROOT, 'next-env.d.ts');
    const txt = readFileSync(envDts, 'utf8');
    const fixed = txt.replace(/\.\/\.next[A-Za-z-]*\//g, './.next/');
    if (fixed !== txt) writeFileSync(envDts, fixed);
  } catch { /* file optional */ }
  log(`build ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

function swapStaging(v) {
  rmSync(join(ROOT, v.dist), { recursive: true, force: true });
  renameSync(join(ROOT, v.staging), join(ROOT, v.dist));
}

// ---------------------------------------------------------------------------
//  Placeholder: identity-correct health while a route has no `next start`.
// ---------------------------------------------------------------------------
function identityHeaders() {
  return { 'X-Aura-App-Id': APP_ID, 'X-Aura-Instance-Id': INSTANCE_ID };
}

function placeholder(req, res) {
  const url = req.url || '/';
  if (/\/api\/lifecycle\/health(\?|$)/.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...identityHeaders() });
    res.end(JSON.stringify({ ok: true, appId: APP_ID, instanceId: INSTANCE_ID, building: true }));
    return;
  }
  if (/\/api\/lifecycle\//.test(url)) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...identityHeaders() });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5', ...identityHeaders() });
  res.end('<!doctype html><meta http-equiv="refresh" content="5"><title>Aura Docs</title>'
    + '<body style="font-family:system-ui;padding:2rem;color:#888">Aura Docs is building… this page reloads itself.</body>');
}

// ---------------------------------------------------------------------------
//  Front: $APP_PORT, passed on to the `next start` of the request's route.
// ---------------------------------------------------------------------------
function forward(v, req, res) {
  const up = httpRequest({
    host: '127.0.0.1', port: v.port, method: req.method, path: req.url, headers: req.headers,
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
    const v = VARIANTS[requestRoute(req.headers)];
    if (!v.wanted) {
      log(`first ${v.route} request — building that route`);
      v.wanted = true;
      void ensureVariant(v).catch((e) => log(`${v.route} route failed to start: ${e.message}`));
    }
    if (!v.ready) return placeholder(req, res);
    return forward(v, req, res);
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

async function startServer(v) {
  v.stopping = false;
  v.port = await freePort();
  const p = run(v, ['start', '--hostname', '127.0.0.1', '--port', String(v.port)],
    { NEXT_DIST_DIR: v.dist }, SERVE_HEAP_MB);
  const child = run.last;
  v.server = child;
  log(`next start (${v.route}) on 127.0.0.1:${v.port} (heap ≤ ${SERVE_HEAP_MB} MB, pid ${child.pid})`);
  p.then(({ code, sig }) => {
    if (v.stopping || shuttingDown) return;
    log(`next start (${v.route}) exited unexpectedly (code=${code} sig=${sig}) — giving up so the OS sees the crash`);
    process.exit(code ?? 1);
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (child.exitCode === null && !(await accepting(v.port))) {
    if (Date.now() > deadline) { log(`next start (${v.route}) not accepting after ${READY_TIMEOUT_MS / 1000}s`); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode === null && v.server === child) v.ready = true;
}

function stopServer(v) {
  v.ready = false;
  return new Promise((resolve) => {
    if (!v.server || v.server.exitCode !== null) return resolve();
    v.stopping = true;
    const s = v.server;
    const t = setTimeout(() => { try { s.kill('SIGKILL'); } catch {} }, 8000);
    s.once('exit', () => { clearTimeout(t); resolve(); });
    s.kill('SIGTERM');
  });
}

/** Build when stale, then start. Shared by boot and the first request of a route. */
async function prepare(v, { serve }) {
  const fp = fingerprint();
  const why = isStale(v, fp);
  if (why) {
    log(`${v.route} build is stale: ${why}`);
    const ok = await buildStaging(v, fp);
    // The next source change retries (rebuildIfChanged), as for any broken edit.
    if (!ok) { v.lastBuilt = fp; throw new Error(`${v.route} build failed`); }
    swapStaging(v);
  } else {
    log(`${v.route} build is current (${readStamp(v)?.builtAt ?? 'unknown'})`);
  }
  v.lastBuilt = fp;
  if (serve) await startServer(v);
}

/** Builds share the build lock with rebuilds, so two never run at once. */
function ensureVariant(v) {
  v.starting ??= withBuildLock(() => prepare(v, { serve: true }));
  return v.starting;
}

let building = Promise.resolve();
function withBuildLock(fn) {
  const next = building.then(fn, fn);
  building = next.catch(() => {});
  return next;
}

let pending = false;
let rebuildQueued = false;

async function rebuildVariant(v, reason) {
  const fp = fingerprint();
  if (v.lastBuilt && fp.newest === v.lastBuilt.newest && fp.count === v.lastBuilt.count) return;
  log(`change detected (${reason}) — rebuilding ${v.route}`);
  const ok = await buildStaging(v, fp);
  if (!ok) { v.lastBuilt = fp; return; } // don't loop on a broken edit; next change retries
  await stopServer(v);   // this process answers with the placeholder meanwhile
  swapStaging(v);
  await startServer(v);
  v.lastBuilt = fp;
}

function rebuildIfChanged(reason) {
  if (rebuildQueued) { pending = true; return; }
  rebuildQueued = true;
  void withBuildLock(async () => {
    try {
      for (const v of Object.values(VARIANTS)) {
        if (v.wanted && v.lastBuilt) await rebuildVariant(v, reason);
      }
    } finally {
      rebuildQueued = false;
      if (pending) { pending = false; rebuildIfChanged('queued change'); }
    }
  });
}

function startWatcher() {
  let timer = null;
  const kick = (what) => {
    if (/(^|\/)(\.next[A-Za-z-]*|node_modules|\.source)(\/|$)/.test(what)) return;
    clearTimeout(timer);
    timer = setTimeout(() => rebuildIfChanged(what), DEBOUNCE_MS);
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
  if (process.argv.includes('--build-only')) {
    const routes = process.argv.includes('--host') ? ['proxy', 'host'] : ['proxy'];
    for (const r of routes) {
      try { await prepare(VARIANTS[r], { serve: false }); } catch { process.exit(1); }
    }
    return;
  }
  const proxy = VARIANTS.proxy;
  proxy.wanted = true;
  await startFront();
  try {
    await ensureVariant(proxy);
  } catch (e) {
    log(`fatal: ${e.message}`);
    process.exit(1);
  }
  startWatcher();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${sig} — stopping`);
    await Promise.all(Object.values(VARIANTS).map(stopServer));
    process.exit(0);
  });
}

main().catch((e) => { log('fatal:', e); process.exit(1); });
