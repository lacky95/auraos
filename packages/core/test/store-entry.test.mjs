/**
 * StoreEntry — the manifest → store-index mapping.
 *
 * Every case here is a real disagreement between the two schemas, found by
 * reading them side by side. The manifest is the looser of the two, so each
 * test pins a value that is a VALID manifest and an INVALID store entry — the
 * combinations that would otherwise reach CI, or worse, reach the index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import {
  buildStoreEntry, renderEntryYaml, mergeEntry, slugifyTag,
  normaliseGitRefForStore, STORE_CATEGORIES,
} from '../dist/nexus/StoreEntry.js';

/** A manifest that maps cleanly, so each test can vary exactly one thing. */
const base = {
  id: 'io.lakner.hello',
  name: 'Hello',
  version: '0.1.0',
  description: 'A minimal AuraOS example app.',
  icon: 'HEL',
  category: 'utility',
  store: { publisher: 'Lukas Lakner', homepage: 'https://example.com', tags: ['demo'] },
};

const gitCtx = {
  source: { kind: 'git', ref: 'https://github.com/lacky95/aura-hello', defaultBranch: 'main' },
  channel: 'stable',
  tag: 'v0.1.0',
};

const errs  = (p) => p.filter((x) => x.severity === 'error');
const warns = (p) => p.filter((x) => x.severity === 'warn');
const fields = (p) => p.map((x) => x.field);

test('a clean manifest maps with no problems', () => {
  const { entry, problems } = buildStoreEntry(base, gitCtx);
  assert.deepEqual(errs(problems), []);
  assert.equal(entry.id, 'io.lakner.hello');
  assert.equal(entry.icon, 'HEL');
  assert.deepEqual(entry.categories, ['utility']);
  assert.deepEqual(entry.sources, { git: { ref: 'github.com/lacky95/aura-hello', 'default-branch': 'main' } });
  assert.deepEqual(entry.channels, { stable: { 'git-tag': 'v0.1.0' } });
});

test('description over the store limit is an error, not a truncation', () => {
  // 210 chars: a valid manifest (max 256), an invalid entry (max 200).
  const { entry, problems } = buildStoreEntry({ ...base, description: 'x'.repeat(210) }, gitCtx);
  const e = errs(problems);
  assert.equal(e.length, 1);
  assert.equal(e[0].field, 'description');
  assert.match(e[0].message, /210 characters/);
  assert.match(e[0].message, /maximum is 200/);
  // Never ship a half-sentence.
  assert.equal(entry.description, undefined);
});

test('categories: the two manifest values with no store equivalent', () => {
  for (const c of ['communication', 'game']) {
    const { problems } = buildStoreEntry({ ...base, category: c }, gitCtx);
    const e = errs(problems);
    assert.equal(e.length, 1, `${c} should produce exactly one error`);
    assert.equal(e[0].field, 'category');
    assert.match(e[0].message, /no store equivalent/);
    // The message must name the way out, not just the problem.
    assert.match(e[0].message, /--category/);
    for (const slug of STORE_CATEGORIES) assert.match(e[0].message, new RegExp(slug));
  }
});

test('--category override rescues an unmappable manifest category', () => {
  const { entry, problems } = buildStoreEntry(
    { ...base, category: 'game' },
    { ...gitCtx, categoryOverride: 'utility' },
  );
  assert.deepEqual(errs(problems), []);
  assert.deepEqual(entry.categories, ['utility']);
});

test('icon: whitespace passes the manifest schema, and falls back with a warning', () => {
  // manifest icon is min(1).max(3) with no non-whitespace assertion, so "  "
  // is a valid manifest the store would reject. Falling back beats failing a
  // publish over a cosmetic field — but it must not be silent.
  const { entry, problems } = buildStoreEntry({ ...base, icon: '  ' }, gitCtx);
  assert.deepEqual(errs(problems), []);
  assert.deepEqual(fields(warns(problems)), ['icon']);
  assert.equal(entry.icon, 'H');
});

test('icon errors only when the name cannot supply a fallback either', () => {
  const { problems } = buildStoreEntry({ ...base, icon: '  ', name: '' }, gitCtx);
  assert.deepEqual(fields(errs(problems)), ['icon']);
});

test('icon falls back to the first letter of the name when omitted', () => {
  const { entry, problems } = buildStoreEntry({ ...base, icon: undefined }, gitCtx);
  assert.deepEqual(errs(problems), []);
  assert.equal(entry.icon, 'H');
});

test('tags are slugged, deduped and capped, with a warning that says what changed', () => {
  const { entry, problems } = buildStoreEntry({
    ...base,
    store: { ...base.store, tags: ['My Tag', 'my_tag', 'Hello World', '***', 'ok'] },
  }, gitCtx);
  assert.deepEqual(errs(problems), []);
  // 'My Tag' and 'my_tag' both slug to 'my-tag' → deduped.
  assert.deepEqual(entry.tags, ['my-tag', 'hello-world', 'ok']);
  const w = warns(problems).map((x) => x.message).join(' ');
  assert.match(w, /my-tag/);
  assert.match(w, /dropped/);
});

test('tags cap at 10', () => {
  const many = Array.from({ length: 14 }, (_, i) => `tag${i}`);
  const { entry, problems } = buildStoreEntry({ ...base, store: { ...base.store, tags: many } }, gitCtx);
  assert.equal(entry.tags.length, 10);
  assert.match(warns(problems).map((x) => x.message).join(' '), /maximum is 10/);
});

test('http URLs are errors — z.string().url() accepts them, the store does not', () => {
  const { problems } = buildStoreEntry({
    ...base,
    store: { ...base.store, homepage: 'http://example.com', screenshots: ['http://example.com/a.png'] },
  }, gitCtx);
  const e = errs(problems);
  assert.deepEqual(fields(e).sort(), ['store.homepage', 'store.screenshots']);
});

test('licence and long description warn, because the index cannot carry them', () => {
  const { problems } = buildStoreEntry({
    ...base,
    store: { ...base.store, license: 'MIT', longDescription: 'much longer text' },
  }, gitCtx);
  assert.deepEqual(errs(problems), []);
  assert.deepEqual(fields(warns(problems)).sort(), ['store.license', 'store.longDescription']);
});

test('a local OCI ref is refused — the store can only list public sources', () => {
  for (const ref of [
    'aura-com.aura.registry:4090/aura-apps/io.lakner.hello:0.1.0',
    'localhost:5000/aura-apps/x:1.0.0',
    '127.0.0.1:5000/aura-apps/x:1.0.0',
  ]) {
    const { problems } = buildStoreEntry(base, { source: { kind: 'oci', ref }, channel: 'stable', tag: '0.1.0' });
    assert.deepEqual(fields(errs(problems)), ['sources.oci.ref'], ref);
  }
});

test('an OCI entry names the repository, the channel names the tag', () => {
  const { entry, problems } = buildStoreEntry(base, {
    source: { kind: 'oci', ref: 'ghcr.io/lacky95/aura-apps/io.lakner.hello:0.1.0' },
    channel: 'stable', tag: '0.1.0',
  });
  assert.deepEqual(errs(problems), []);
  assert.deepEqual(entry.sources, { oci: { ref: 'ghcr.io/lacky95/aura-apps/io.lakner.hello' } });
  assert.deepEqual(entry.channels, { stable: { 'oci-tag': '0.1.0' } });
});

test('a non-stable channel warns, because bare-id installs resolve stable', () => {
  const { problems } = buildStoreEntry(base, { ...gitCtx, channel: 'beta' });
  assert.deepEqual(errs(problems), []);
  assert.match(warns(problems).map((x) => x.message).join(' '), /stable/);
});

test('every problem is collected, not just the first', () => {
  const { problems } = buildStoreEntry({
    ...base,
    description: 'x'.repeat(300),          // > manifest max too, but we do not care
    icon: '   ',
    category: 'game',
    store: { ...base.store, homepage: 'http://nope' },
  }, gitCtx);
  // Three errors and one warning, all reported together — an author fixing
  // these one publish at a time is the failure mode this guards.
  assert.deepEqual(fields(errs(problems)).sort(), ['category', 'description', 'store.homepage']);
  assert.ok(fields(warns(problems)).includes('icon'));
});

test('git refs normalise to the store shape from every form Publisher emits', () => {
  for (const [input, want] of [
    ['https://github.com/lacky95/aura-hello',     'github.com/lacky95/aura-hello'],
    ['https://github.com/lacky95/aura-hello.git', 'github.com/lacky95/aura-hello'],
    ['git@github.com:lacky95/aura-hello.git',     'github.com/lacky95/aura-hello'],
    ['github.com/lacky95/aura-hello/',            'github.com/lacky95/aura-hello'],
  ]) {
    assert.equal(normaliseGitRefForStore(input), want, input);
  }
});

test('slugifyTag returns null when nothing usable survives', () => {
  assert.equal(slugifyTag('***'), null);
  assert.equal(slugifyTag('   '), null);
  assert.equal(slugifyTag('-'), null);
  assert.equal(slugifyTag('Hello World'), 'hello-world');
});

test('rendered YAML round-trips and uses the index key order', () => {
  const { entry } = buildStoreEntry(base, gitCtx);
  const yaml = renderEntryYaml(entry);
  assert.deepEqual(parse(yaml), entry);
  // Exactly the store's build-index KEY_ORDER, for the fields this entry has.
  assert.deepEqual(Object.keys(parse(yaml)), [
    'id', 'name', 'description', 'publisher', 'homepage', 'icon',
    'categories', 'tags', 'sources', 'channels',
  ]);
});

test('a version bump preserves a maintainer\'s hand-edits', () => {
  const existing = {
    id: 'io.lakner.hello', name: 'Hello',
    description: 'A description a reviewer rewrote during review.',
    tags: ['curated'],
    sources: { git: { ref: 'github.com/lacky95/aura-hello', 'default-branch': 'main' } },
    channels: { stable: { 'git-tag': 'v0.1.0' } },
  };
  const { entry: next } = buildStoreEntry(
    { ...base, version: '0.2.0', description: 'The author changed this.' },
    { ...gitCtx, tag: 'v0.2.0' },
  );

  const bumped = mergeEntry(existing, next);
  assert.equal(bumped.channels.stable['git-tag'], 'v0.2.0');
  assert.equal(bumped.description, 'A description a reviewer rewrote during review.');
  assert.deepEqual(bumped.tags, ['curated']);

  // ...unless the author explicitly asks to refresh the metadata.
  const full = mergeEntry(existing, next, 'full');
  assert.equal(full.description, 'The author changed this.');
  assert.equal(full.channels.stable['git-tag'], 'v0.2.0');
});

test('merge keeps unknown keys a hand-edit may have added', () => {
  const existing = {
    id: 'io.lakner.hello', name: 'Hello',
    somethingFuture: 'keep me',
    sources: { git: { ref: 'github.com/lacky95/aura-hello' } },
    channels: { stable: { 'git-tag': 'v0.1.0' } },
  };
  const { entry: next } = buildStoreEntry(base, { ...gitCtx, tag: 'v0.2.0' });
  assert.equal(mergeEntry(existing, next).somethingFuture, 'keep me');
  assert.equal(mergeEntry(existing, next, 'full').somethingFuture, 'keep me');
});
