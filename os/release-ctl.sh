#!/bin/sh
# Host recovery for the Normal layout (Phase 6 L, D2): runs WITHOUT a working
# shell, from any kept shell image, with only the data volume and the Docker
# socket:
#
#   docker run --rm -v <project>_aura-app-data:/data -v /var/run/docker.sock:/var/run/docker.sock \
#     aura-shell:<any kept tag> /os/release-ctl.sh <command>
#
#   status                     the pointer, the releases on disk, the activation lock
#   rollback [--force-insecure]  switch back to the previous release, then restart the shell
#   use <id> [--force-insecure]  switch to a kept, complete release, then restart the shell
#   env [<id>]                 (re)write aura/release/compose.env for a release (default: current)
#   up                         start the shell of the current release (compose up of its own
#                              docker-compose.release.yml with compose.env)
#
# A switch takes the one activation lock (os/release/lock.mjs: refused while a
# build or activation runs), rewrites pointer.json durably (current ↔ previous),
# writes compose.env (the release's images) and then restarts the shell:
# `docker restart` when its image is unchanged, else a recreate from the
# release's own compose file. It never restores data (that is the owner's
# decision, stream U). A rollback away from a signed security update is
# refused without --force-insecure (5b owner answer 1: a rollback never
# silently reintroduces a resolved vulnerability).
#
# The node part runs from the image's own copies of the dependency-free
# release modules (/os/release/{layout,lock,durable}.mjs), never from a
# release tree.
set -eu
[ $# -ge 1 ] || { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }
exec node --input-type=module - "$@" <<'NODE'
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { COMPLETE_MARKER, RELEASE_RECORD, assertReleaseId, layout, newJobId } from '/os/release/layout.mjs';
import { LockError, acquireLock, lockStatus } from '/os/release/lock.mjs';
import { writeFileDurable, writeJsonDurable } from '/os/release/durable.mjs';

const DATA = process.env.AURA_DATA_DIR ?? '/data';
const L = layout(DATA);
const COMPOSE_ENV = join(DATA, 'aura', 'release', 'compose.env');
const SHELL = process.env.AURA_SHELL_CONTAINER ?? 'aura-shell';
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

const die = (code, msg) => { console.error(`release-ctl: ${msg}`); process.exit(code); };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const record = (id) => readJson(join(L.release(id), RELEASE_RECORD));
const complete = (id) => existsSync(join(L.release(id), COMPLETE_MARKER)) && record(id) !== null;
const docker = (a, opts = {}) => spawnSync('docker', a, { encoding: 'utf8', ...opts });

function releases() {
  if (!existsSync(L.releases)) return [];
  return readdirSync(L.releases).filter((n) => !n.startsWith('.')).sort().map((id) => ({ id, complete: complete(id), record: record(id) }));
}

/** compose.env: the project, the data volume, the release's images (the Normal layout reads nothing else). */
function readEnvFile() {
  const out = {};
  try {
    for (const l of readFileSync(COMPOSE_ENV, 'utf8').split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* none yet */ }
  return out;
}

/** The data volume this container got at /data (so recovery needs no other input). */
function ownDataVolume() {
  const r = docker(['inspect', '-f', '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}', hostname()]);
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function writeEnv(id) {
  const rec = record(id);
  if (!rec?.images?.shell || !rec?.images?.base) die(1, `release ${id} names no images (release.json images)`);
  const prev = readEnvFile();
  const volume = process.env.AURA_APP_DATA_VOLUME ?? prev.AURA_APP_DATA_VOLUME ?? ownDataVolume();
  if (!volume) die(1, 'cannot tell the data volume: set AURA_APP_DATA_VOLUME=<project>_aura-app-data');
  const project = process.env.COMPOSE_PROJECT_NAME ?? prev.COMPOSE_PROJECT_NAME ?? volume.replace(/_aura-app-data$/, '');
  const env = {
    ...prev,
    COMPOSE_PROJECT_NAME: project,
    AURA_APP_DATA_VOLUME: volume,
    AURA_SHELL_IMAGE: rec.images.shell,
    AURA_BASE_IMAGE: rec.images.base,
    AURA_RELEASE: id,
  };
  for (const [k, v] of Object.entries(env)) if (!/^[A-Za-z0-9_.:@\/+-]*$/.test(String(v))) die(1, `refusing a compose.env value for ${k}`);
  writeFileDurable(COMPOSE_ENV, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o644 });
  return env;
}

function composeUp(id, env) {
  const file = join(L.release(id), 'docker-compose.release.yml');
  if (!existsSync(file)) die(1, `release ${id} has no docker-compose.release.yml: it predates the Normal layout`);
  // The shared network outlives every layout (the Developer compose and ContainerRunner create it too).
  if (docker(['network', 'inspect', 'aura-net']).status !== 0) docker(['network', 'create', '--driver', 'bridge', 'aura-net']);
  const r = docker(['compose', '-p', env.COMPOSE_PROJECT_NAME, '--env-file', COMPOSE_ENV, '-f', file, 'up', '-d', '--no-build', '--force-recreate', 'aura-os'], { stdio: 'inherit' });
  if (r.status !== 0) die(1, `docker compose up of release ${id} failed`);
}

/** Restart onto the pointer: a plain restart when the image is the same, else a recreate. */
function restart(id, env) {
  const running = docker(['inspect', '-f', '{{.Config.Image}}', SHELL]);
  if (running.status === 0 && running.stdout.trim() === env.AURA_SHELL_IMAGE) {
    console.log(`release-ctl: restarting ${SHELL} (image unchanged)`);
    if (docker(['restart', SHELL], { stdio: 'inherit' }).status !== 0) die(1, `docker restart ${SHELL} failed`);
    return;
  }
  console.log(`release-ctl: recreating ${SHELL} from release ${id} (image ${env.AURA_SHELL_IMAGE})`);
  composeUp(id, env);
}

function switchTo(target, why) {
  assertReleaseId(target);
  const ptr = readJson(L.pointer);
  if (!ptr?.current) die(1, `no release pointer at ${L.pointer}: nothing is installed`);
  if (target === ptr.current) die(1, `release ${target} is already current`);
  if (!complete(target)) die(1, `release ${target} is not complete (no .complete or release.json): never served`);
  const cur = record(ptr.current);
  if (cur?.meta?.signed && cur.meta.securityUpdate && !flags.has('--force-insecure')) {
    die(3, `the current release ${ptr.current} is a signed security update${cur.meta.severity ? ` (${cur.meta.severity})` : ''}: `
      + `switching to ${target} may reintroduce what it fixed. Pass --force-insecure to do it anyway.`);
  }
  const jobId = newJobId();
  let lock;
  try { lock = acquireLock(L.lock, { jobId, by: `release-ctl.${why}`, autoHeartbeat: false }); }
  catch (e) { if (e instanceof LockError) die(2, e.message); throw e; }
  try {
    const next = { v: 1, current: target, previous: ptr.current, switchedAt: new Date().toISOString(), jobId };
    if (flags.has('--force-insecure')) console.error(`release-ctl: --force-insecure: leaving a security update (job ${jobId})`);
    writeJsonDurable(L.pointer, next);
    console.log(`release-ctl: ${why}: ${ptr.current} → ${target} (job ${jobId}); data is not restored`);
    restart(target, writeEnv(target));
  } finally { lock.release(); }
}

switch (cmd) {
  case 'status': {
    const ptr = readJson(L.pointer);
    console.log(`pointer:  ${ptr ? `current ${ptr.current}, previous ${ptr.previous ?? '-'} (switched ${ptr.switchedAt}, job ${ptr.jobId})` : 'none'}`);
    const lk = lockStatus(L.lock);
    console.log(`lock:     ${lk.held ? `held by ${lk.holder?.jobId} (${lk.holder?.by})${lk.stale ? ', stale' : ''}` : 'free'}`);
    for (const r of releases()) {
      const mark = r.id === ptr?.current ? '*' : r.id === ptr?.previous ? 'p' : ' ';
      const rec = r.record ?? {};
      console.log(`${mark} ${r.id}  ${r.complete ? 'complete' : 'INCOMPLETE'}  ${rec.version ?? 'main'} ${String(rec.commit ?? '').slice(0, 12)} ${rec.provenance ?? ''}${rec.meta?.securityUpdate ? ' security-update' : ''}`);
    }
    const env = readEnvFile();
    console.log(`compose:  ${env.AURA_RELEASE ? `release ${env.AURA_RELEASE}, image ${env.AURA_SHELL_IMAGE}, project ${env.COMPOSE_PROJECT_NAME}` : 'no compose.env yet'}`);
    break;
  }
  case 'rollback': {
    const ptr = readJson(L.pointer);
    if (!ptr?.previous) die(1, 'no previous release to roll back to');
    switchTo(ptr.previous, 'rollback');
    break;
  }
  case 'use':
    if (!args[0]) die(64, 'usage: release-ctl.sh use <id> [--force-insecure]');
    switchTo(args[0], 'use');
    break;
  case 'env': {
    const id = args[0] ?? readJson(L.pointer)?.current;
    if (!id) die(1, 'no release given and no pointer');
    assertReleaseId(id);
    if (!complete(id)) die(1, `release ${id} is not complete`);
    const env = writeEnv(id);
    console.log(`release-ctl: ${COMPOSE_ENV} → release ${id} (${env.AURA_SHELL_IMAGE})`);
    break;
  }
  case 'up': {
    const id = readJson(L.pointer)?.current;
    if (!id) die(1, 'no release pointer: nothing is installed');
    if (!complete(id)) die(1, `the current release ${id} is not complete: release-ctl.sh rollback`);
    composeUp(id, writeEnv(id));
    break;
  }
  default:
    die(64, `unknown command ${cmd ?? ''}: status | rollback | use <id> | env [<id>] | up`);
}
NODE
