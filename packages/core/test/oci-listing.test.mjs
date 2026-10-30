/**
 * OciListing — the registry-hosted store listing (screenshots + texts).
 * The oras round trip is covered end-to-end against the local registry; this
 * pins the pure rules: text limits, path confinement, URL mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normaliseListingMeta, screenshotInput, listingScreenshotUrls, listingAssetPath, ociAppTarget, isDigest,
} from '../dist/nexus/OciListing.js';
import { AppManifestSchema } from '../dist/types/manifest.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('normaliseListingMeta trims, clears empties, enforces limits', () => {
  assert.deepEqual(normaliseListingMeta({ description: '  hi ', longDescription: '', tags: [' a', 'a', 'b', ''] }),
    { description: 'hi', tags: ['a', 'b'] });
  assert.deepEqual(normaliseListingMeta(null), {});
  assert.throws(() => normaliseListingMeta({ description: 'x'.repeat(281) }), /longer than 280/);
  assert.throws(() => normaliseListingMeta({ homepage: 'ftp://x' }), /http\(s\) URL/);
  assert.throws(() => normaliseListingMeta({ tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }), /16 tags/);
  assert.throws(() => normaliseListingMeta({ tags: 'a,b' }), /must be a list/);
});

test('screenshotInput: https URL, image file, confinement, non-images', () => {
  const dir = mkdtempSync(join(tmpdir(), 'listing-'));
  mkdirSync(join(dir, 'store'));
  writeFileSync(join(dir, 'store', 'a.png'), PNG);
  writeFileSync(join(dir, 'store', 'b.txt'), 'nope');
  assert.deepEqual(screenshotInput('https://x.example/a.png'), { url: 'https://x.example/a.png' });
  const f = screenshotInput('store/a.png', dir);
  assert.equal(f.info.mime, 'image/png');
  assert.throws(() => screenshotInput('../a.png', dir), /inside the app/);
  assert.throws(() => screenshotInput('http://x/a.png', dir), /https/);
  assert.throws(() => screenshotInput('store/b.txt', dir), /not a recognised image/);
  assert.throws(() => screenshotInput('store/none.png', dir), /no such file/);
});

test('listing URLs: registry images go through the shell, URLs stay', () => {
  const d = `sha256:${'a'.repeat(64)}`;
  assert.ok(isDigest(d));
  assert.equal(listingAssetPath('my store', 'com.x', d), `/api/nexus/assets/my%20store/com.x/${d}`);
  assert.deepEqual(listingScreenshotUrls({ screenshots: [{ digest: d, mime: 'image/png' }, { url: 'https://u' }], meta: {} }, 'local', 'com.x'),
    [`/api/nexus/assets/local/com.x/${d}`, 'https://u']);
  assert.deepEqual(ociAppTarget('http://reg:4090', 'com.x'), { host: 'reg:4090', repo: 'aura-apps/com.x', flags: ['--plain-http'] });
});

test('manifest store.screenshots accepts https URLs and in-app image paths only', () => {
  const base = { id: 'com.x.y', name: 'Y', version: '1.0.0' };
  const ok = (shots) => AppManifestSchema.safeParse({ ...base, store: { screenshots: shots } }).success;
  assert.ok(ok(['https://x/a.png', 'store/a.png', 'a.png']));
  assert.ok(!ok(['http://x/a.png']));
  assert.ok(!ok(['/abs/a.png']));
  assert.ok(!ok(['../a.png']));
  assert.ok(!ok(['store/../../a.png']));
});
