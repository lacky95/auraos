// `aura sdk install` against a stub `oras`: an installed copy is refreshed by
// layer digest (the version tag never changes), survives an unreachable
// registry, and a directory that is not one of our copies is never replaced.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIGEST_FILE, installOne } from '../src/commands/sdk.js';

const root = mkdtempSync(join(tmpdir(), 'aura-sdk-install-'));
const stub = join(root, 'registry');
const bin = join(root, 'bin');
mkdirSync(stub); mkdirSync(bin);
writeFileSync(join(bin, 'oras'), `#!/bin/sh
[ -f '${stub}/offline' ] && exit 1
case "$1" in
  manifest) cat '${stub}/manifest.json' ;;
  pull) echo pull >> '${stub}/pulls'; cp '${stub}/app-sdk-0.0.1.tgz' "$4/" ;;
esac
`);
chmodSync(join(bin, 'oras'), 0o755);
const savedPath = process.env['PATH'];
process.env['PATH'] = `${bin}:${savedPath}`;
after(() => { process.env['PATH'] = savedPath; rmSync(root, { recursive: true, force: true }); });

const PKG = { fullName: '@aura/app-sdk', basename: 'app-sdk', version: '0.0.1' };
const install = (cwd: string) => installOne(cwd, 'registry.test', [], PKG, true);
const pulls = () => existsSync(join(stub, 'pulls')) ? readFileSync(join(stub, 'pulls'), 'utf8').trim().split('\n').length : 0;

function publish(content: string, tamper = false): string {
  const src = mkdtempSync(join(root, 'pack-'));
  mkdirSync(join(src, 'package', 'dist'), { recursive: true });
  writeFileSync(join(src, 'package', 'package.json'), JSON.stringify({ name: '@aura/app-sdk', version: '0.0.1' }));
  writeFileSync(join(src, 'package', 'dist', 'index.js'), content);
  const tgz = join(stub, 'app-sdk-0.0.1.tgz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', src, 'package']).status, 0);
  const digest = `sha256:${createHash('sha256').update(readFileSync(tgz)).digest('hex')}`;
  writeFileSync(join(stub, 'manifest.json'), JSON.stringify({ layers: [{ digest: tamper ? `sha256:${'0'.repeat(64)}` : digest }] }));
  return digest;
}
function appDir(): string {
  const dir = mkdtempSync(join(root, 'app-'));
  mkdirSync(join(dir, 'node_modules', '@aura'), { recursive: true });
  return dir;
}
const installed = (dir: string, rel = 'dist/index.js') => readFileSync(join(dir, 'node_modules', '@aura', 'app-sdk', rel), 'utf8');

beforeEach(() => {
  rmSync(join(stub, 'offline'), { force: true });
  rmSync(join(stub, 'pulls'), { force: true });
});

test('a new digest at the same version replaces the copy; the same digest pulls nothing', () => {
  const dir = appDir();
  const first = publish('one');
  assert.equal(install(dir), true);
  assert.equal(installed(dir), 'one');
  assert.equal(installed(dir, DIGEST_FILE).trim(), first);
  assert.equal(pulls(), 1);

  assert.equal(install(dir), true);
  assert.equal(pulls(), 1, 'unchanged digest: no pull');

  publish('two');
  assert.equal(install(dir), true);
  assert.equal(installed(dir), 'two');
  assert.equal(pulls(), 2);
});

test('a copy from before digests were recorded is refreshed once', () => {
  const dir = appDir();
  const dest = join(dir, 'node_modules', '@aura', 'app-sdk');
  mkdirSync(join(dest, 'dist'), { recursive: true });
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: '@aura/app-sdk', version: '0.0.1' }));
  writeFileSync(join(dest, 'dist', 'index.js'), 'legacy');
  publish('fresh');
  assert.equal(install(dir), true);
  assert.equal(installed(dir), 'fresh');
});

test('with the registry unreachable an installed copy stays and the install succeeds', () => {
  const dir = appDir();
  publish('kept');
  install(dir);
  writeFileSync(join(stub, 'offline'), '');
  assert.equal(install(dir), true);
  assert.equal(installed(dir), 'kept');
});

test('with the registry unreachable and no copy, the install reports failure', () => {
  const dir = appDir();
  writeFileSync(join(stub, 'offline'), '');
  assert.equal(install(dir), false);
});

test('a symlink or a foreign directory at the path is never replaced', () => {
  publish('registry');
  const linked = appDir();
  const own = join(linked, 'my-sdk');
  mkdirSync(own);
  writeFileSync(join(own, 'mine.js'), 'mine');
  symlinkSync(own, join(linked, 'node_modules', '@aura', 'app-sdk'));
  assert.equal(install(linked), true);
  assert.equal(readFileSync(join(linked, 'node_modules', '@aura', 'app-sdk', 'mine.js'), 'utf8'), 'mine');

  const foreign = appDir();
  const dest = join(foreign, 'node_modules', '@aura', 'app-sdk');
  mkdirSync(dest);
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'my-fork' }));
  assert.equal(install(foreign), true);
  assert.equal(JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).name, 'my-fork');
  assert.equal(pulls(), 0);
});

test('a tarball that does not match its digest leaves the installed copy alone', () => {
  const dir = appDir();
  publish('good');
  install(dir);
  publish('bad', true);
  assert.equal(install(dir), false);
  assert.equal(installed(dir), 'good');
});
