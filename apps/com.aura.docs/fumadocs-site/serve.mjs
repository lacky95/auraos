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
// Health: while the FIRST build runs (no server yet) and during the swap, a
// tiny placeholder answers /api/lifecycle/health with the identity body the
// AppManager's spawn gate expects, so a cold boot never trips the 60 s
// health deadline; everything else gets a 503 "building" page.
//
// Usage: node serve.mjs            serve (build first if stale)
//        node serve.mjs --build-only   just build (CI, pre-warming)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, renameSync, watch,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.APP_PORT || 4101);
const APP_ID = process.env.APP_ID || 'com.aura.docs';
const INSTANCE_ID = process.env.APP_INSTANCE_ID || APP_ID;
const BASE_PATH = `/api/proxy/${INSTANCE_ID}`;
const DIST = '.next';
const STAGING = '.next-staging';
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
const NEXT_BIN = join(ROOT, 'node_modules/next/dist/bin/next');
const TAG = `[${APP_ID}]`;

const log = (...a) => console.log(TAG, ...a);

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
  if (s.basePath !== BASE_PATH) return `basePath changed (${s.basePath} → ${BASE_PATH})`;
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
  log(`next build → ${STAGING} (basePath=${BASE_PATH})`);
  const { code } = await run(['build'], { NEXT_DIST_DIR: STAGING }, BUILD_HEAP_MB);
  if (code !== 0) { log(`build FAILED (exit ${code}) — keeping the previous build`); return false; }
  writeFileSync(join(ROOT, STAGING, STAMP), JSON.stringify({
    basePath: BASE_PATH, newest: fp.newest, count: fp.count, builtAt: new Date().toISOString(),
  }));
  // `next build` rewrites next-env.d.ts to reference the dist dir it built
  // into; the staging dir becomes `.next` on swap, so point it back there
  // (keeps git clean — this file is tracked).
  try {
    const envDts = join(ROOT, 'next-env.d.ts');
    const txt = readFileSync(envDts, 'utf8');
    if (txt.includes(`./${STAGING}/`)) writeFileSync(envDts, txt.replaceAll(`./${STAGING}/`, `./${DIST}/`));
  } catch { /* file optional */ }
  log(`build ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

function swapStaging() {
  rmSync(join(ROOT, DIST), { recursive: true, force: true });
  renameSync(join(ROOT, STAGING), join(ROOT, DIST));
}

// ---------------------------------------------------------------------------
//  Placeholder: identity-correct health while no `next start` is listening.
// ---------------------------------------------------------------------------
function identityHeaders() {
  return { 'X-Aura-App-Id': APP_ID, 'X-Aura-Instance-Id': INSTANCE_ID };
}

function startPlaceholder() {
  const srv = createServer((req, res) => {
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
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(PORT, '0.0.0.0', () => resolve(srv));
  });
}

function stopPlaceholder(srv) {
  return new Promise((resolve) => { srv.closeAllConnections?.(); srv.close(() => resolve()); });
}

// ---------------------------------------------------------------------------
//  Serve loop
// ---------------------------------------------------------------------------
let server = null;        // running `next start`
let stopping = false;     // set while we kill the server on purpose
let shuttingDown = false;

function startServer() {
  stopping = false;
  const p = run(['start', '--hostname', '0.0.0.0', '--port', String(PORT)],
    { NEXT_DIST_DIR: DIST }, SERVE_HEAP_MB);
  server = run.last;
  log(`next start on :${PORT} (heap ≤ ${SERVE_HEAP_MB} MB, pid ${server.pid})`);
  p.then(({ code, sig }) => {
    if (stopping || shuttingDown) return;
    log(`next start exited unexpectedly (code=${code} sig=${sig}) — giving up so the OS sees the crash`);
    process.exit(code ?? 1);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    stopping = true;
    const s = server;
    const t = setTimeout(() => { try { s.kill('SIGKILL'); } catch {} }, 8000);
    s.once('exit', () => { clearTimeout(t); resolve(); });
    s.kill('SIGTERM');
  });
}

let building = false;
let pending = false;
let lastBuilt = null;

async function rebuildIfChanged(reason) {
  if (building) { pending = true; return; }
  building = true;
  try {
    const fp = fingerprint();
    if (lastBuilt && fp.newest === lastBuilt.newest && fp.count === lastBuilt.count) return;
    log(`change detected (${reason}) — rebuilding`);
    const ok = await buildStaging(fp);
    if (!ok) { lastBuilt = fp; return; } // don't loop on a broken edit; next change retries
    await stopServer();
    const ph = await startPlaceholder().catch(() => null);
    swapStaging();
    if (ph) await stopPlaceholder(ph);
    startServer();
    lastBuilt = fp;
  } finally {
    building = false;
    if (pending) { pending = false; void rebuildIfChanged('queued change'); }
  }
}

function startWatcher() {
  let timer = null;
  const kick = (what) => {
    if (/(^|\/)(\.next|node_modules|\.source)(\/|$)/.test(what)) return;
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
  const buildOnly = process.argv.includes('--build-only');
  const fp = fingerprint();
  const why = isStale(fp);
  if (why) {
    log(`build is stale: ${why}`);
    const ph = buildOnly ? null : await startPlaceholder().catch((e) => { log(`placeholder failed: ${e.message}`); return null; });
    const ok = await buildStaging(fp);
    if (ph) await stopPlaceholder(ph);
    if (!ok) process.exit(1);
    swapStaging();
  } else {
    log(`build is current (${readStamp()?.builtAt ?? 'unknown'})`);
  }
  lastBuilt = fp;
  if (buildOnly) return;
  startServer();
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
