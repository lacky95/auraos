/**
 * StoreAssets — screenshot validation and naming.
 *
 * These files get committed to a repository that IS a public website, and
 * served straight to browsers. So the checks here are the ones that decide
 * whether something untrusted ends up hosted under your own domain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyImage, assetPath, assetUrl, isOwnAsset,
  MAX_IMAGE_BYTES, MAX_SCREENSHOTS,
} from '../dist/nexus/StoreAssets.js';

const INDEX = 'https://nexus.aura.lakner.io/index.yaml';

/** Minimal but genuine file headers. */
const PNG  = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG  = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const GIF  = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16)]);

test('recognises the four formats worth accepting', () => {
  assert.equal(identifyImage(PNG).ext, 'png');
  assert.equal(identifyImage(JPG).ext, 'jpg');
  assert.equal(identifyImage(GIF).ext, 'gif');
  assert.equal(identifyImage(WEBP).ext, 'webp');
  assert.equal(identifyImage(PNG).mime, 'image/png');
});

test('identifies by content, so a renamed file does not get through', () => {
  // The exact attack the sniffing exists for: an HTML document called .png,
  // which would otherwise be committed to the site and served from our origin.
  const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
  assert.throws(() => identifyImage(html), /not a recognised image/);
  // And the message must say why renaming will not help.
  assert.throws(() => identifyImage(html), /renaming the file will not help/);
});

test('rejects an SVG — it is a document, not a bitmap', () => {
  // SVG is XML that can carry script. It would render, which is exactly what
  // makes accepting it on your own origin a bad idea.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');
  assert.throws(() => identifyImage(svg), /not a recognised image/);
});

test('rejects an empty or truncated file rather than guessing', () => {
  assert.throws(() => identifyImage(Buffer.alloc(0)), /not a recognised image/);
  assert.throws(() => identifyImage(Buffer.from([0x89, 0x50])), /not a recognised image/);
});

test('enforces the size ceiling, and says what the limit is', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 1)]);
  assert.throws(() => identifyImage(big), /limit is 2 MB/);
  // The reason matters: the repo is the published site.
  assert.throws(() => identifyImage(big), /published site/);
});

test('names are content-addressed, so the same picture never lands twice', () => {
  const a = identifyImage(PNG);
  const b = identifyImage(Buffer.from(PNG));
  assert.equal(a.hash, b.hash);
  assert.equal(assetPath('io.lakner.hello', a), assetPath('io.lakner.hello', b));
  // ...and a different picture gets a different name.
  const other = identifyImage(Buffer.concat([PNG, Buffer.from('x')]));
  assert.notEqual(a.hash, other.hash);
});

test('asset paths are namespaced per app', () => {
  const info = identifyImage(PNG);
  assert.match(assetPath('io.lakner.hello', info), /^assets\/io\.lakner\.hello\/[0-9a-f]{12}\.png$/);
});

test('the public URL comes from the index origin, not a hardcoded host', () => {
  const info = identifyImage(PNG);
  assert.equal(
    assetUrl(INDEX, 'io.lakner.hello', info),
    `https://nexus.aura.lakner.io/${assetPath('io.lakner.hello', info)}`,
  );
  // A self-hosted store works with no extra configuration.
  assert.match(assetUrl('https://store.example.org/index.yaml', 'a.b', info), /^https:\/\/store\.example\.org\/assets\/a\.b\//);
});

test('a store whose index is not https cannot host images, and says so', () => {
  const info = identifyImage(PNG);
  // e.g. an index consumed by cloning a git repo — there is no public origin.
  assert.throws(() => assetUrl('git@github.com:me/store.git', 'a.b', info), /not served over https/);
  assert.throws(() => assetUrl('http://insecure/index.yaml', 'a.b', info), /not served over https/);
});

test('only our own assets are considered ours to delete', () => {
  const mine = 'https://nexus.aura.lakner.io/assets/io.lakner.hello/abc.png';
  assert.equal(isOwnAsset(mine, INDEX, 'io.lakner.hello'), true);
  // Another app's directory is not ours.
  assert.equal(isOwnAsset(mine, INDEX, 'io.lakner.other'), false);
  // Someone else's host is definitely not ours.
  assert.equal(isOwnAsset('https://example.com/shot.png', INDEX, 'io.lakner.hello'), false);
  // Nor is a lookalike path on our origin outside assets/.
  assert.equal(isOwnAsset('https://nexus.aura.lakner.io/index.yaml', INDEX, 'io.lakner.hello'), false);
});

test('the screenshot cap matches the store schema', () => {
  assert.equal(MAX_SCREENSHOTS, 8);
});
