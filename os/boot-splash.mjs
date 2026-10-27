// "AuraOS is starting" — the page on :3000 while the shell container installs
// and builds (os/boot.sh), before the real shell listens. Without it a first
// start answers "connection refused" for minutes.
//
//   /                → the splash page (polls /__boot/status)
//   /__boot/status   → { phase, detail, lines[] } from os/boot.sh's files
//   /api/*           → 503 JSON, so the CLI says "starting" instead of hanging
//
// Every response carries `x-aura-boot-splash: 1`. boot.sh stops this server
// right before the shell starts; the page then polls / until an answer comes
// WITHOUT that header (the shell) and reloads into the desktop.
//
// No dependencies: it runs before `pnpm install`.

import { createServer } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BOOT_DIR = process.env.AURA_BOOT_DIR ?? '/data/aura/boot';
const PORT = Number(process.env.AURA_BOOT_SPLASH_PORT ?? process.env.AURA_SHELL_PORT ?? 3000);
const TAIL_BYTES = 64 * 1024;
const TAIL_LINES = 40;

function readPhase() {
  try {
    const [phase, ...rest] = readFileSync(join(BOOT_DIR, 'phase'), 'utf-8').trim().split(' ');
    return { phase: phase || 'starting', detail: rest.join(' ') };
  } catch { return { phase: 'starting', detail: '' }; }
}

function tail() {
  const f = join(BOOT_DIR, 'boot.log');
  if (!existsSync(f)) return [];
  const size = statSync(f).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(f, 'r');
  try {
    const b = Buffer.alloc(size - start);
    readSync(fd, b, 0, b.length, start);
    // Progress bars redraw with \r — keep the last state of each line.
    return b.toString('utf-8').split('\n').map((l) => l.split('\r').pop()).filter((l) => l.trim()).slice(-TAIL_LINES);
  } finally { closeSync(fd); }
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AuraOS is starting</title>
<style>
:root { --bg:#f6f7f9; --fg:#1b1e24; --muted:#5d6470; --card:#fff; --line:#dfe3ea; --accent:#5b5bd6; --bad:#c2410c; --log:#f0f2f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --fg:#e7e9ee; --muted:#9aa1ad; --card:#171a21; --line:#2a2f3a; --accent:#8b8bff; --bad:#fb923c; --log:#11141a; } }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:16px; }
main { width:min(720px,100%); background:var(--card); border:1px solid var(--line); border-radius:14px; padding:24px; }
h1 { margin:0 0 4px; font-size:22px; } p { margin:0 0 16px; color:var(--muted); }
ol { list-style:none; padding:0; margin:0 0 16px; display:grid; gap:6px; }
li { display:flex; gap:10px; align-items:center; color:var(--muted); }
li.now { color:var(--fg); font-weight:600; } li.done { color:var(--fg); }
.dot { width:10px; height:10px; border-radius:50%; border:2px solid var(--line); flex:none; }
li.done .dot { background:var(--accent); border-color:var(--accent); }
li.now .dot { border-color:var(--accent); animation:pulse 1.2s infinite; }
li.bad { color:var(--bad); } li.bad .dot { background:var(--bad); border-color:var(--bad); }
@keyframes pulse { 50% { opacity:.3; } }
pre { margin:0; background:var(--log); border:1px solid var(--line); border-radius:8px; padding:10px; max-height:280px;
  overflow:auto; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-all; }
.err { color:var(--bad); font-weight:600; }
</style></head>
<body><main>
<h1>AuraOS is starting</h1>
<p id="sub">The first start installs and builds everything — a few minutes. This page switches to the desktop by itself.</p>
<ol id="steps"></ol>
<pre id="log" aria-label="Boot log"></pre>
</main>
<script>
const STEPS = [['installing','Installing dependencies'],['building','Building AuraOS'],['starting','Starting the desktop']];
const $ = (id) => document.getElementById(id);
let handover = false;
function draw(s) {
  const at = STEPS.findIndex(([k]) => k === s.phase);
  const failed = s.phase === 'failed';
  const failedAt = failed ? STEPS.findIndex(([k]) => k === s.detail.split(' ')[0]) : -1;
  $('steps').innerHTML = STEPS.map(([k, label], i) => {
    let c = '';
    if (failed) c = i < failedAt ? 'done' : i === failedAt ? 'bad' : '';
    else c = i < at ? 'done' : i === at ? 'now' : '';
    return '<li class="' + c + '"><span class="dot"></span>' + label + '</li>';
  }).join('');
  if (failed) {
    $('sub').innerHTML = '<span class="err">Starting AuraOS failed.</span> See the log below or <code>docker logs aura-shell</code>. The container retries in a few minutes.';
  }
  const log = $('log');
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = s.lines.join('\\n');
  if (stick) log.scrollTop = log.scrollHeight;
}
async function tick() {
  if (handover) {
    try {
      const r = await fetch('/', { cache: 'no-store' });
      if (r.ok && !r.headers.get('x-aura-boot-splash')) { location.reload(); return; }
    } catch {}
    setTimeout(tick, 1500); return;
  }
  try {
    const r = await fetch('/__boot/status', { cache: 'no-store' });
    if (!r.headers.get('x-aura-boot-splash')) { location.reload(); return; }
    draw(await r.json());
  } catch {
    // The splash stopped: the shell is taking over the port.
    handover = true;
    $('sub').textContent = 'Opening the desktop…';
    $('steps').querySelectorAll('li').forEach((li) => { li.className = 'done'; });
  }
  setTimeout(tick, 1000);
}
tick();
</script>
</body></html>`;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const h = { 'x-aura-boot-splash': '1', 'cache-control': 'no-store' };
  if (url.pathname === '/__boot/status') {
    res.writeHead(200, { ...h, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...readPhase(), lines: tail() }));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    res.writeHead(503, { ...h, 'content-type': 'application/json', 'retry-after': '5' });
    res.end(JSON.stringify({ error: 'starting', message: 'AuraOS is still starting — try again in a moment' }));
    return;
  }
  res.writeHead(200, { ...h, 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(PORT, '0.0.0.0', () => console.log(`[boot-splash] serving the "AuraOS is starting" page on :${PORT}`));
