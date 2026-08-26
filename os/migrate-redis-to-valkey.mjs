#!/usr/bin/env node
/**
 * One-time Redis → Valkey data migration for /data/kv.
 *
 * Why this exists: Valkey 8.x refuses Redis 8.x's on-disk snapshot
 * ("Can't handle RDB format version 13") and aborts AOF loading, so simply
 * swapping the binary would leave the shell unable to boot — themes,
 * workspaces, and sealed Aura Context values all live in there. DUMP/RESTORE
 * is no help either: the payload footer carries the same RDB version.
 *
 * What does work is the wire protocol. Every key the OS writes is a plain
 * string (KvClient JSON-encodes on the way in), so a GET/SET round-trip is
 * lossless and format-independent.
 *
 * Usage — run BOTH halves from inside `aura-shell`:
 *
 *   # 1. while the OLD (Redis) shell is still running:
 *   node os/migrate-redis-to-valkey.mjs export /data/kv-migration.json
 *
 *   # 2. clear the unreadable snapshot, then restart the shell so it comes
 *   #    up on Valkey with an empty store:
 *   rm -rf /data/kv/appendonlydir /data/kv/aura.rdb
 *
 *   # 3. after the shell is back up:
 *   node os/migrate-redis-to-valkey.mjs import /data/kv-migration.json
 *
 * Or, if the shell already booted on Valkey and quarantined the old snapshot
 * itself (see `quarantineSnapshot` in packages/kv-store/src/server.ts), do the
 * whole thing in one step — no advance planning required:
 *
 *   node os/migrate-redis-to-valkey.mjs recover
 *
 * Both halves discover the running server's port from its process args, so
 * there's nothing to configure — pass `--port <n>` to override (needed when
 * old and new servers are up at once, e.g. a dry run). `import` refuses to
 * clobber existing keys unless --force is passed, so re-running it is safe.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

/** Locate the embedded server by its listen address in `ps` output. */
function discoverPort() {
  const ps = execFileSync('ps', ['ax', '-o', 'args='], { encoding: 'utf8' });
  const hit = ps.match(/(?:redis|valkey)-server 127\.0\.0\.1:(\d+)/);
  if (!hit) throw new Error('no embedded redis-server/valkey-server found in `ps` — is the shell running?');
  return Number(hit[1]);
}

/**
 * Minimal RESP client. Deliberately not ioredis: this script has to run
 * against whichever store is up, including before `pnpm install` has been
 * re-run, so it stays dependency-free.
 */
function connect(port) {
  const sock = createConnection({ host: '127.0.0.1', port });
  let buf = Buffer.alloc(0);
  let waiter = null;

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (waiter) waiter();
  });

  const ready = new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
  });

  /** Parse one reply off the head of `buf`, or return undefined if incomplete. */
  function parse(offset = 0) {
    const nl = buf.indexOf('\r\n', offset);
    if (nl === -1) return undefined;
    const type = String.fromCharCode(buf[offset]);
    const head = buf.toString('utf8', offset + 1, nl);
    const after = nl + 2;

    if (type === '+') return { value: head, end: after };
    if (type === '-') return { value: new Error(head), end: after };
    if (type === ':') return { value: Number(head), end: after };
    if (type === '$') {
      const len = Number(head);
      if (len === -1) return { value: null, end: after };
      if (buf.length < after + len + 2) return undefined;
      return { value: buf.toString('utf8', after, after + len), end: after + len + 2 };
    }
    if (type === '*') {
      const n = Number(head);
      if (n === -1) return { value: null, end: after };
      const out = [];
      let cur = after;
      for (let i = 0; i < n; i++) {
        const item = parse(cur);
        if (item === undefined) return undefined;
        out.push(item.value);
        cur = item.end;
      }
      return { value: out, end: cur };
    }
    throw new Error(`unexpected RESP type: ${type}`);
  }

  async function send(...args) {
    await ready;
    const cmd = `*${args.length}\r\n` +
      args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('');
    sock.write(cmd);
    for (;;) {
      const reply = parse();
      if (reply !== undefined) {
        buf = buf.subarray(reply.end);
        if (reply.value instanceof Error) throw reply.value;
        return reply.value;
      }
      await new Promise((res) => { waiter = res; });
      waiter = null;
    }
  }

  return { send, close: () => sock.end() };
}

/** Full keyspace walk. SCAN, not KEYS, so a large store can't stall the server. */
async function scanAll(db) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await db.send('SCAN', cursor, 'COUNT', '500');
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys.sort();
}

const argv = process.argv.slice(2);
const [mode, file] = argv.filter((a) => !a.startsWith('--'));
const force = argv.includes('--force');
const portFlag = argv.indexOf('--port');

if (mode !== 'export' && mode !== 'import' && mode !== 'recover') {
  console.error('usage: migrate-redis-to-valkey.mjs <export|import|recover> [file.json] [--port N] [--force]');
  process.exit(2);
}
if (!file && mode !== 'recover') {
  console.error('missing output/input file path');
  process.exit(2);
}

/**
 * Read a quarantined Redis snapshot by lending it a Redis that can.
 *
 * The shell's own image ships no Redis binary — that was the point of the
 * switch — but AuraOS already drives the host docker daemon to spawn sibling
 * app containers, so it can borrow one for the length of this call:
 *
 *   --volumes-from aura-shell   the quarantine dir lives in the aura-app-data
 *                               volume, so this mounts it without having to
 *                               resolve the compose-prefixed volume name
 *   --network container:...     shares the shell's netns, so the temp Redis
 *                               is reachable on 127.0.0.1 with nothing exposed
 *   --user 0:0 + --entrypoint   the quarantined files are root-owned, and the
 *                               redis image runs as `redis`. Loading an AOF
 *                               opens the incr file for append even when we
 *                               only ever read, so a non-root Redis loads all
 *                               the keys and then exits on "Permission denied".
 *                               --user alone is not enough: the image's
 *                               entrypoint re-drops to `redis` via gosu, so we
 *                               invoke redis-server directly to keep uid 0.
 *
 * The container is removed on the way out, including on failure. The Redis
 * image is pulled only here, only once, and never becomes part of the OS.
 */
async function recover(quarantineDir) {
  const shell = process.env.AURA_SHELL_HOSTNAME ?? 'aura-shell';
  const name  = 'aura-kv-recover';
  const port  = 41855;

  if (!quarantineDir) {
    // Newest quarantine dir wins: a second failed boot would park a second
    // (empty) one, and the timestamps sort lexicographically.
    const dirs = execFileSync('sh', ['-c', 'ls -d /data/kv.redis-* 2>/dev/null || true'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).sort();
    if (!dirs.length) throw new Error('no /data/kv.redis-* quarantine dir found — nothing to recover');
    quarantineDir = dirs[dirs.length - 1];
  }
  console.log(`[migrate] recovering from ${quarantineDir}`);

  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', name,
    '--user', '0:0', '--entrypoint', 'redis-server',
    '--volumes-from', shell,
    '--network', `container:${shell}`,
    'redis:8',
    '--bind', '127.0.0.1', '--port', String(port),
    '--dir', quarantineDir, '--appendonly', 'yes',
    // Capture rather than inherit: `docker run -d` echoes the container id, and
    // this runs under the shell's boot log where a bare hash reads as noise.
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    let old = null;
    for (let i = 0; i < 30; i++) {
      try { old = connect(port); await old.send('PING'); break; }
      catch { old = null; await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!old) {
      // Without this the caller sees a bare timeout; the container's own log
      // says exactly what went wrong (bad path, permissions, unreadable AOF).
      const log = execFileSync('docker', ['logs', '--tail', '15', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error(`temp Redis on :${port} never became reachable. Its log:\n${log}`);
    }

    const keys = await scanAll(old);
    const data = {};
    for (const key of keys) data[key] = await old.send('GET', key);
    old.close();
    console.log(`[migrate] read ${keys.length} keys from the quarantined snapshot`);
    return data;
  } finally {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }
}

const port = portFlag === -1 ? discoverPort() : Number(argv[portFlag + 1]);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`invalid --port: ${argv[portFlag + 1]}`);
  process.exit(2);
}
const db = connect(port);
// Valkey reports BOTH valkey_version and a redis_version compat field, so
// check for the fork first or every Valkey looks like Redis 7.2.4.
const info = await db.send('INFO', 'server');
const valkey = info.match(/^valkey_version:(.*)$/m);
const redis  = info.match(/^redis_version:(.*)$/m);
const flavour = valkey ? `valkey ${valkey[1].trim()}`
              : redis  ? `redis ${redis[1].trim()}`
              : 'unknown';
console.log(`[migrate] connected to 127.0.0.1:${port} (${flavour})`);

if (mode === 'export') {
  const keys = await scanAll(db);
  const data = {};
  for (const key of keys) {
    const type = await db.send('TYPE', key);
    if (type !== 'string') {
      // Every OS write goes through KvClient.set(), which JSON-encodes. A
      // non-string means something wrote outside that path — bail rather
      // than silently dropping it.
      throw new Error(`key "${key}" has type "${type}"; only strings are migratable`);
    }
    data[key] = await db.send('GET', key);
  }
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`[migrate] exported ${keys.length} keys → ${file}`);
  for (const key of keys) console.log(`             ${key}`);
} else {
  // `recover` always overwrites: the shell has necessarily booted on an empty
  // store by this point, so kvBootstrap seeded defaults for os/theme, os/keymap
  // and os/workspaces. Under NX those placeholders would outrank the user's
  // real data — the one case where not forcing is the destructive choice.
  const recovering = mode === 'recover';
  const data = recovering ? await recover(file) : JSON.parse(readFileSync(file, 'utf8'));
  const entries = Object.entries(data);
  let written = 0;
  let skipped = 0;
  for (const [key, value] of entries) {
    // NX unless --force: re-running after a partial import must not roll
    // back keys the OS has already updated on the new store.
    const res = (force || recovering)
      ? await db.send('SET', key, value)
      : await db.send('SET', key, value, 'NX');
    if (res === null) { skipped++; console.log(`             skip (exists) ${key}`); }
    else { written++; }
  }
  try {
    await db.send('BGREWRITEAOF');
  } catch (err) {
    // "already in progress" is the common case right after boot, and the
    // writes are in the AOF either way — never fail the migration over it.
    console.warn(`[migrate] BGREWRITEAOF skipped: ${err.message}`);
  }
  console.log(`[migrate] imported ${written}/${entries.length} keys (${skipped} already present)`);
}

db.close();
