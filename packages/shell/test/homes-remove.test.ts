// B7 (app lifecycle review): `rm app --delete-home` / `nexus app uninstall
// --delete-home` name the App Homes to delete by the app's installation. An
// app without its installation record is repaired first (AppManager
// `ensureInstallation`); one that can't be is refused before anything is
// removed, never a silent "deleted nothing".
//
//   node tools/run-tests.mjs --only=shell
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import { deleteHomeRefusal, deleteHomesAfterRemove, installationBeforeRemove } from '../src/lib/homesAdmin.ts';

const root = mkdtempSync(join(tmpdir(), 'aura-homes-rm-'));
const savedDataDir = process.env['AURA_DATA_DIR'];
process.env['AURA_DATA_DIR'] = root;
after(() => {
  if (savedDataDir === undefined) delete process.env['AURA_DATA_DIR'];
  else process.env['AURA_DATA_DIR'] = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

const INST = '11111111-1111-4111-8111-111111111111';

test('B7: delete-home of an app whose installation record was missing: repaired, then its App Homes are deleted', async () => {
  let repaired = false;
  const mgr = {
    ensureInstallation: async (appId: string) => {
      repaired = true;
      return { installation: { installationId: INST, appId } as core.AppInstallation };
    },
  };
  const home = join(core.installationHomesDir(root, INST), 'default');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.bashrc'), 'x');
  const r = await installationBeforeRemove('org.a.notes', mgr);
  assert.ok(repaired);
  assert.deepEqual(r, { installationId: INST });
  assert.equal(await deleteHomesAfterRemove('org.a.notes', INST), true);
  assert.equal(existsSync(core.installationHomesDir(root, INST)), false);
});

test('B7: no installation even after the repair (or an unreadable record): a clear refusal, never a silent no-op', async () => {
  const none = await installationBeforeRemove('org.a.notes', {
    ensureInstallation: async () => ({ installation: null, error: 'org.a.notes has no installation record and it could not be created (kv down)' }),
  });
  assert.ok('error' in none);
  assert.match(deleteHomeRefusal('org.a.notes', none.error), /^org\.a\.notes was not removed: .*\(kv down\).*Nothing was changed/);
  const unreadable = await installationBeforeRemove('org.a.notes', { ensureInstallation: async () => { throw new Error('ECONNREFUSED'); } });
  assert.ok('error' in unreadable && /can't be read \(ECONNREFUSED\)/.test(unreadable.error));
});

test('B7: both uninstall routes refuse a delete-home they cannot honour BEFORE removing anything, and look up only when asked', () => {
  for (const [file, removal] of [
    ['../src/pages/api/apps/[id]/remove.ts', 'removeInstalledApp(appId)'],
    ['../src/pages/api/nexus/uninstall/[id].ts', 'nexus.uninstall(id'],
  ] as const) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    const lookup = src.indexOf('deleteHome ? await installationBeforeRemove(');
    const refusal = src.indexOf('deleteHomeRefusal(');
    assert.ok(lookup > 0 && refusal > lookup, `${file}: looked up only with deleteHome, then refused`);
    assert.ok(refusal < src.indexOf(removal), `${file}: before the removal`);
  }
});
