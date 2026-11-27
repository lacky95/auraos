// Phase 6 L (D34): the one answer for a write into the active release (lib/releaseReadOnly.ts).
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_READ_ONLY, isReleasePath, refuseReleaseWrite, releaseReadOnlyBody, releaseReadOnlyFailure,
} from '../src/lib/releaseReadOnly.ts';

let root: string;
const saved = { data: process.env['AURA_DATA_DIR'], ws: process.env['AURA_WORKSPACE_DIR'] };
const ID = '0.1.0-0123456789ab-cafebabe';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aura-relro-'));
  const rel = join(root, 'data', 'releases', ID);
  mkdirSync(join(rel, 'apps'), { recursive: true });
  writeFileSync(join(rel, '.complete'), '');
  writeFileSync(join(rel, 'release.json'), JSON.stringify({ id: ID, commit: 'c0ffee' }));
  symlinkSync(rel, join(root, 'workspace'));
  mkdirSync(join(root, 'data', 'scopes', 'users', 'default', 'apps'), { recursive: true });
  process.env['AURA_DATA_DIR'] = join(root, 'data');
  process.env['AURA_WORKSPACE_DIR'] = join(root, 'workspace');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [['AURA_DATA_DIR', saved.data], ['AURA_WORKSPACE_DIR', saved.ws]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('the D34 body: code, category, the release, the aura system patch workflow (D105 shape)', () => {
  const b = releaseReadOnlyBody('Creating io.x.app in the system scope');
  assert.equal(b.error, RELEASE_READ_ONLY);
  assert.equal(b.category, 'not-grantable');
  assert.match(b.message, /^Creating io\.x\.app in the system scope: the active release \(0\.1\.0-0123456789ab-cafebabe\) is read-only in Normal Mode\.$/);
  assert.match(b.hint ?? '', /aura system patch start.*save.*activate/);
  assert.deepEqual(b.details, { mode: 'normal', release: ID });
});

test('refuseReleaseWrite: a path in the release (also one not created yet, through the /workspace link) is refused', async () => {
  for (const p of [join(root, 'workspace', 'apps', 'io.new.app'), join(root, 'data', 'releases', ID, 'apps'), '/releases/x/apps/y']) {
    assert.equal(isReleasePath(p), true, p);
    const res = refuseReleaseWrite(p, 'Writing');
    assert.equal(res?.status, 409);
    assert.equal((await res!.json() as { error: string }).error, RELEASE_READ_ONLY);
  }
  assert.equal(refuseReleaseWrite(join(root, 'data', 'scopes', 'users', 'default', 'apps', 'io.new.app')), null, 'a user app is writable');
});

test('releaseReadOnlyFailure: only an EROFS in a release', () => {
  const erofs = (path?: string) => Object.assign(new Error('read-only file system'), { code: 'EROFS', ...(path ? { path } : {}) });
  assert.equal(releaseReadOnlyFailure(erofs(join(root, 'workspace', 'apps', 'x')))?.status, 409);
  assert.equal(releaseReadOnlyFailure(erofs())?.body.error, RELEASE_READ_ONLY, 'AuraOS runs from a release here');
  assert.equal(releaseReadOnlyFailure(erofs('/mnt/aura/io.shop.app/x')), null, 'a closed install is source-closed, not this');
  assert.equal(releaseReadOnlyFailure(Object.assign(new Error('x'), { code: 'EACCES' })), null);
});
