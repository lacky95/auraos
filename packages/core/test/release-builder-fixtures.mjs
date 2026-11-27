// Fixtures for the Phase 6 stream B release builder tests: a fake `docker`
// (a node script that records its argv and simulates images, the base check
// and the throwaway build containers on the data root) and a small source
// repository shaped like AuraOS (Dockerfile targets, packages, a system app).
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, makeRepo, release, tmp, write } from './release-fixtures.mjs';

const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2);
const S = process.env.FAKE_DOCKER_STATE;
fs.appendFileSync(path.join(S, 'calls.log'), 'docker ' + a.join(' ') + '\\n');
const imgs = path.join(S, 'images');
const has = (t) => fs.existsSync(imgs) && fs.readFileSync(imgs, 'utf8').split('\\n').includes(t);
const env = (k, d) => process.env[k] ?? d;
const exit = (c) => process.exit(c);
// install.sh's preflight and start (same answers as install-sh.test.mjs's shell fake)
if (a[0] === 'info') { console.log(a.join(' ').includes('DockerRootDir') ? env('FAKE_DOCKER_ROOT', '/nonexistent') : 'Server: fake'); exit(0); }
if (a[0] === 'version') { console.log(env('FAKE_DOCKER_VERSION', '27.3.1')); exit(0); }
if (a[0] === 'compose') { if (a[1] === 'version') console.log(env('FAKE_COMPOSE_VERSION', '2.29.7')); exit(0); }
if (a[0] === 'inspect') { console.log('running'); exit(0); }
if (a[0] === 'exec') exit(a.join(' ').includes('credentialsImported') ? 1 : 0);
if (a[0] === 'pull') exit(0);
if (a[0] === 'buildx' && a[1] === 'version') exit(env('FAKE_NO_BUILDX') ? 1 : 0);
if (a[0] === 'image' && a[1] === 'inspect') {
  const t = a[a.length - 1];
  if (!has(t)) exit(1);
  if (a.includes('{{.Id}}')) console.log('sha256:' + require('node:crypto').createHash('sha256').update(t).digest('hex'));
  exit(0);
}
// The registry manifest of a base image (metadata only): its bytes change with FAKE_BASE_V.
if (a[0] === 'buildx' && a[1] === 'imagetools') { console.log(JSON.stringify({ ref: a[a.length - 1], v: env('FAKE_BASE_V', '1') })); exit(0); }
if (a[0] === 'image' && a[1] === 'rm') exit(0);
if (a[0] === 'volume' && a[1] === 'inspect') {
  if (a.includes('-f')) { process.stdout.write(env('FAKE_DATA_ROOT', '') + '\\n'); exit(env('FAKE_DATA_ROOT') ? 0 : 1); }
  exit(1);
}
if ((a[0] === 'buildx' && a[1] === 'build') || a[0] === 'build') {
  if (env('FAKE_FAIL_IMAGE')) { console.error('image build failed'); exit(1); }
  const t = a[a.indexOf('-t') + 1];
  fs.appendFileSync(imgs, t + '\\n');
  exit(0);
}
if (a[0] === 'run') {
  // install.sh's builder runner: run its command here, with the data volume at FAKE_DATA_ROOT.
  const ri = a.findIndex((x) => x.startsWith('aura-release-runner:'));
  if (ri >= 0) {
    const cmd = a.slice(ri + 1).map((x, i, all) => (all[i - 1] === '--data-root' && x === '/data' ? env('FAKE_DATA_ROOT', '') : x));
    const r = require('node:child_process').spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    exit(r.status ?? 1);
  }
  if (a.includes('-v') && a[a.indexOf('--entrypoint') + 1] === 'node') { console.log(env('FAKE_NODE', 'v22.23.5')); exit(0); }
  const i = a.indexOf('os/release/build.sh');
  if (i < 0) exit(0);
  const stepName = a[i + 1];
  const mount = a.find((x) => x.includes('target=/workspace,'));
  const sub = mount && /volume-subpath=([^,]+)/.exec(mount)[1];
  const ws = sub && path.join(env('FAKE_DATA_ROOT', ''), sub);
  if (stepName === 'deps') {
    if (a.includes('--offline')) exit(Number(env('FAKE_OFFLINE_RC', '0')));
    if (env('FAKE_FAIL_DEPS')) { console.error('ERR_PNPM_OUTDATED_LOCKFILE'); exit(1); }
    exit(0);
  }
  if (stepName === 'build') {
    if (env('FAKE_FAIL_BUILD')) { console.error('error TS2304: compile error'); exit(1); }
    fs.mkdirSync(path.join(ws, 'packages/shell/dist-prod/server'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'packages/shell/dist-prod/server/entry.mjs'), 'export const handler = () => {};\\n');
    console.log('[release] building packages');
    console.log(JSON.stringify({ apps: [{ id: 'com.example.app', built: true, fingerprint: 'f00' }, { id: 'com.example.raw', built: false, skipped: 'own-entrypoint' }] }));
    exit(0);
  }
  if (stepName === 'check') exit(env('FAKE_FAIL_CHECK') ? 1 : 0);
  exit(0);
}
exit(0);
`;

/** A fake docker on PATH; returns { bin, state, calls(), env }. */
export function fakeDocker(dataRoot, { bin = tmp('aura-fakedocker-') } = {}) {
  const state = tmp('aura-fakedocker-state-');
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const log = join(state, 'calls.log');
  return {
    bin, state,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    log,
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, FAKE_DATA_ROOT: dataRoot, FAKE_DOCKER_ROOT: dataRoot },
  };
}

export const DOCKERFILE = `# test Dockerfile
FROM node:22.23.5-bookworm AS aura-base
COPY os/base/ /os/base/

FROM node:22.23.5-bookworm-slim AS base
COPY os/toolchain-path.sh /etc/profile.d/x.sh

FROM base AS deps
COPY packages/core/package.json ./packages/core/package.json

FROM base AS development
COPY --from=aura-base /os/base /os/base
COPY os/boot.sh \\
     /os/boot.sh
CMD ["sh", "/workspace/os/boot.sh"]
`;

/** A source repo shaped like AuraOS with signed release v<version>. */
export function auraSource(key, { version = '0.1.0', extra } = {}) {
  const dir = makeRepo();
  write(dir, 'package.json', `${JSON.stringify({ name: 'aura', version: '0.0.1', private: true, engines: { node: '>=22.23.4' } }, null, 2)}\n`);
  write(dir, 'Dockerfile', DOCKERFILE);
  write(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  write(dir, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
  write(dir, 'os/base/x', 'base\n');
  write(dir, 'os/boot.sh', '#!/bin/sh\n');
  write(dir, 'os/toolchain-path.sh', '#!/bin/sh\n');
  write(dir, 'packages/core/package.json', '{"name":"@aura/core"}\n');
  write(dir, 'packages/core/src/contract/appContract.ts', 'export const AURA_CONTRACT = 1;\n');
  write(dir, 'packages/core/src/runtimes/ari.ts', 'export const ARI_VERSION = 1;\n');
  write(dir, 'packages/shell/package.json', '{"name":"@aura/shell"}\n');
  write(dir, 'apps/com.example.app/app.manifest.json', '{"id":"com.example.app"}\n');
  write(dir, 'apps/com.example.raw/app.manifest.json', '{"id":"com.example.raw","runtime":"raw"}\n');
  if (extra) extra(dir);
  commitAll(dir, 'aura');
  const r = release(dir, version, key);
  return { dir, ...r };
}
