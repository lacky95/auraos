#!/usr/bin/env node
// Runs every package and app test suite, continues past failures, and prints
// per-suite results. Usage: pnpm test [-- --only=core,shell] [--timeout=600] [--with-security]
//
// --with-security runs the security gate (tools/security-check.mjs) first; its
// findings fail the run like a failed suite.
//
// This runs inside the master container, which holds the real Docker socket
// and data, so each suite gets throwaway state plus a guard: a `docker` stub
// that always fails, and a Node preload that refuses connections to the Docker
// socket, every port already listening on loopback when the run starts, and
// any non-loopback host.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const OVERRIDE = '--allow-live-workspace';
const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

if (ROOT === '/workspace' && !args.includes(OVERRIDE)) {
  console.error(`Refusing to run in /workspace: the live shell watches it and tests rewrite dist.\nUse a git worktree, or pass ${OVERRIDE} if the live shell is not using this checkout.`);
  process.exit(2);
}

// Libraries first: later suites import their built dist.
const ORDER = ['packages/kv-store', 'packages/core', 'packages/app-sdk'];
// app-hosts.test.ts passes but leaves a handle open, so its process never exits.
// Remove this once that test closes its connections (see tools/test-baseline.md).
const FORCE_EXIT = new Set(['packages/shell']);
const only = opt('only')?.split(',');
const matchesOnly = (dir, o) => Boolean(o) && dir.endsWith(o);
const timeoutMs = Number(opt('timeout') ?? 600) * 1000;
const allSuites = ['packages', 'apps']
  .flatMap((group) => readdirSync(join(ROOT, group)).sort().map((name) => `${group}/${name}`))
  .filter((dir) => existsSync(join(ROOT, dir, 'package.json')))
  .map((dir) => ({ dir, script: JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf-8')).scripts?.test }))
  .filter((s) => s.script);
const unmatched = only?.filter((o) => !allSuites.some((s) => matchesOnly(s.dir, o))) ?? [];
if (unmatched.length) {
  console.error(`--only matched no suite: ${unmatched.map((o) => o || '(empty)').join(', ')}`);
  process.exit(2);
}
const suites = allSuites
  .filter((s) => !only || only.some((o) => matchesOnly(s.dir, o)))
  .sort((a, b) => rank(a.dir) - rank(b.dir));
function rank(dir) { const i = ORDER.indexOf(dir); return i < 0 ? ORDER.length : i; }

const runDir = mkdtempSync(join(tmpdir(), 'aura-test-run-'));
const guardLog = join(runDir, 'guard-blocked.log');
const binDir = join(runDir, 'bin');
mkdirSync(binDir);
writeFileSync(join(binDir, 'docker'), `#!/bin/sh\necho "docker $*" >> '${guardLog}'\necho 'docker is blocked during tests' >&2\nexit 1\n`);
chmodSync(join(binDir, 'docker'), 0o755);

// /proc hex: IPv4 is little-endian, so 127.x ends in 7F. Wildcards reach loopback too.
const reachesLoopback = (addr) => /^0+$/.test(addr) || (addr.length === 8
  ? addr.endsWith('7F')
  : addr === '00000000000000000000000001000000' || /^0{16}FFFF0{4}[0-9A-F]{6}7F$/.test(addr));

/** Read once, before any suite, so ports the tests open later stay usable. */
function liveLoopbackPorts() {
  const ports = new Set([3000]);
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (state !== '0A') continue;
      const [addr, port] = local.split(':');
      if (reachesLoopback(addr)) ports.add(parseInt(port, 16));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

const guardFile = join(runDir, 'guard.cjs');
writeFileSync(guardFile, `
const net = require('node:net'), fs = require('node:fs');
const connect = net.Socket.prototype.connect;
const loopback = (h) => !h || h === 'localhost' || h === '::1' || /^127\\./.test(h);
const livePorts = new Set(${JSON.stringify(liveLoopbackPorts())});
net.Socket.prototype.connect = function (...a) {
  let o = Array.isArray(a[0]) ? a[0][0] : a[0];
  if (typeof o === 'string') o = { path: o };
  else if (typeof o !== 'object' || o === null) o = { port: o, host: typeof a[1] === 'string' ? a[1] : undefined };
  const why = o.path ? (String(o.path).includes('docker.sock') ? o.path : null)
    : (!loopback(o.host) || livePorts.has(Number(o.port))) ? (o.host || 'localhost') + ':' + o.port : null;
  if (!why) return connect.apply(this, a);
  try { fs.appendFileSync(${JSON.stringify(guardLog)}, 'connect ' + why + '\\n'); } catch {}
  const err = Object.assign(new Error('blocked by test guard: ' + why), { code: 'ECONNREFUSED' });
  process.nextTick(() => this.destroy(err));
  return this;
};
`);

function suiteEnv(dir, id) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(AURA_|OS_API|DOCKER_|NODE_OPTIONS$|TMUX)/.test(k)) env[k] = v;
  }
  const state = join(runDir, id);
  for (const d of ['data', 'home', 'tmux']) mkdirSync(join(state, d), { recursive: true });
  return {
    ...env,
    PATH: [binDir, join(ROOT, dir, 'node_modules/.bin'), join(ROOT, 'node_modules/.bin'), process.env.PATH].join(':'),
    HOME: join(state, 'home'),
    AURA_DATA_DIR: join(state, 'data'),
    AURA_STATE_PATH: join(state, 'data/capabilities.json'),
    AURA_CONSOLE_LOG: join(state, 'data/console.log'),
    AURA_TERM_HOME: join(state, 'home'),
    AURA_TERM_TMUX_SOCKET: `aura-test-${process.pid}-${id}`,
    TMUX_TMPDIR: join(state, 'tmux'),
    DOCKER_HOST: 'unix:///nonexistent',
    NODE_OPTIONS: `--require=${guardFile}`,
  };
}

function runSuite({ dir, script: declared }) {
  const script = FORCE_EXIT.has(dir) ? declared.replace('--test ', '--test --test-force-exit ') : declared;
  const id = dir.replace(/\W+/g, '-');
  const logPath = join(runDir, `${id}.log`);
  const log = createWriteStream(logPath);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-c', script], { cwd: join(ROOT, dir), env: suiteEnv(dir, id), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end(() => resolve({ dir, code, timedOut, logPath, seconds: Math.round((Date.now() - started) / 1000), ...parse(readFileSync(logPath, 'utf-8')) }));
    });
  });
}

function parse(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const m of clean.matchAll(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) counts[m[1]] += Number(m[2]);
  const section = clean.split(/^✖ failing tests:$/m)[1] ?? '';
  const failures = [...new Set([
    ...[...clean.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]),
    ...[...section.matchAll(/^✖ (.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => m[1]),
  ])];
  return { ...counts, failures };
}

// --test-force-exit can cut off the summary, so a clean exit with no counted
// tests proves nothing.
const incomplete = (r) => r.code === 0 && r.tests === 0;
const passed = (r) => r.code === 0 && !incomplete(r);
const label = (r) => r.timedOut ? 'TIMEOUT' : incomplete(r) ? 'FAILED (no test summary)' : r.code === 0 ? 'ok' : `FAILED (exit ${r.code})`;

const security = args.includes('--with-security') ? runSecurity() : null;

function runSecurity() {
  process.stdout.write('running security gate ... ');
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/security-check.mjs')], { cwd: ROOT, encoding: 'utf-8' });
  const lines = (r.stdout || r.stderr || '').trim().split('\n');
  console.log(r.status === 0 ? 'ok' : `FAILED (exit ${r.status})`);
  return { code: r.status, lines };
}

const results = [];
for (const suite of suites) {
  process.stdout.write(`running ${suite.dir} ... `);
  let r = await runSuite(suite);
  if (incomplete(r)) r = await runSuite(suite);
  results.push(r);
  console.log(label(r));
}

console.log('\nsuite                          tests  pass  fail  cancel  skip  todo  time  result');
for (const r of results) {
  const n = (v, w) => String(v).padStart(w);
  const result = label(r);
  console.log(`${r.dir.padEnd(30)} ${n(r.tests, 5)} ${n(r.pass, 5)} ${n(r.fail, 5)} ${n(r.cancelled, 7)} ${n(r.skipped, 5)} ${n(r.todo, 5)} ${n(r.seconds, 4)}s  ${result}`);
  for (const f of r.failures) console.log(`    x ${f}`);
  if (!passed(r)) console.log(`    log: ${r.logPath}`);
}
if (existsSync(guardLog)) {
  const blocked = [...new Set(readFileSync(guardLog, 'utf-8').trim().split('\n'))];
  console.log(`\nguard blocked ${blocked.length} distinct live-system attempt(s):`);
  for (const b of blocked.slice(0, 40)) console.log(`    ${b.slice(0, 120)}`);
}
if (security) {
  console.log(`\n${security.lines[0]}`);
  for (const l of security.lines.slice(1, 41)) console.log(`    ${l.slice(0, 160)}`);
  if (security.lines.length > 41) console.log(`    … ${security.lines.length - 41} more: node tools/security-check.mjs`);
}
console.log(`\nlogs: ${runDir}`);
process.exit(results.every(passed) && (!security || security.code === 0) ? 0 : 1);
