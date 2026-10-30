// Pre-registered Nexus sources: seed parsing + merge rules (lib/nexusSeeds.ts).
//
//   cd packages/shell && npx tsx --test test/nexus-seeds.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { SourcesConfig } from '@aura/core';
import { dedupeSeeds, managedMarker, mergeSeeds, parseSeedDoc, type SeedEnv } from '../src/lib/nexusSeeds.ts';

const io: SeedEnv = {
  env: { ACME_PW: 'env-secret' },
  readFile: (p) => { if (p === '/run/secrets/acme') return 'file-secret\n'; throw new Error('ENOENT'); },
  hash: (s) => createHash('sha256').update(s).digest('hex'),
};
const base = (): SourcesConfig => ({
  schema: 1,
  sources: [
    { kind: 'oci', name: 'local', url: 'http://aura-com.aura.registry:4090', priority: 0, mirror: false },
    { kind: 'git-index', name: 'official', url: 'https://nexus.example/index.yaml', priority: 10 },
  ],
});
const seeds = (doc: unknown, origin = '/etc/aura/nexus/sources.d/acme.json') =>
  parseSeedDoc(JSON.stringify(doc), origin, io);
const find = (cfg: SourcesConfig, name: string) => cfg.sources.find((s) => s.name === name) as Record<string, unknown> | undefined;

test('parseSeedDoc: array or {sources}, defaults, and per-entry problems', () => {
  const a = seeds([{ name: 'acme', url: 'https://registry.acme.com' }]);
  assert.equal(a.problems.length, 0);
  assert.deepEqual(a.seeds[0]!.entry, { kind: 'oci', name: 'acme', url: 'https://registry.acme.com', priority: 10 });
  assert.equal(a.seeds[0]!.policy, 'seed');
  const b = seeds({ sources: [{ name: 'x', url: 'u', kind: 'git-index', repo: 'o/r', mirror: true }] });
  assert.deepEqual(b.seeds[0]!.entry, { kind: 'git-index', name: 'x', url: 'u', priority: 10, repo: 'o/r' }, 'oci-only fields dropped');
  const bad = seeds([{ url: 'u' }, { name: 'n' }, { name: 'k', url: 'u', kind: 'ftp' }, { name: 'p', url: 'u', policy: 'locked' }, 5]);
  assert.equal(bad.seeds.length, 0);
  assert.equal(bad.problems.length, 5);
  assert.match(parseSeedDoc('{oops', 'f', io).problems[0]!.detail, /invalid JSON/);
});

test('parseSeedDoc: logins inline, from env, from file; oci only', () => {
  const r = seeds([
    { name: 'a', url: 'u', username: 'ci', password: 'inline' },
    { name: 'b', url: 'u', username: 'ci', passwordEnv: 'ACME_PW' },
    { name: 'c', url: 'u', username: 'ci', passwordFile: '/run/secrets/acme' },
    { name: 'd', url: 'u', username: 'ci', passwordEnv: 'MISSING' },
    { name: 'e', url: 'u', kind: 'git-index', username: 'ci', password: 'x' },
    { name: 'f', url: 'u', username: 'ci', passwordFile: '/nope' },
  ]);
  assert.deepEqual(r.seeds.map((s) => [s.entry.name, s.login?.password]), [['a', 'inline'], ['b', 'env-secret'], ['c', 'file-secret']]);
  assert.equal(r.problems.length, 3);
  assert.ok(!JSON.stringify(r.seeds.map((s) => s.entry)).includes('inline'), 'password never in the entry');
});

test('dedupeSeeds: later (higher precedence) wins per alias', () => {
  const etc = seeds([{ name: 'acme', url: 'https://old' }], '/etc/x.json').seeds;
  const env = seeds([{ name: 'acme', url: 'https://new' }], 'env:AURA_NEXUS_SOURCES').seeds;
  const d = dedupeSeeds([...etc, ...env]);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.entry.url, 'https://new');
});

test('seed policy: added once, user removal and edits stick, a changed seed re-applies', () => {
  const s1 = seeds([{ name: 'acme', url: 'https://registry.acme.com', priority: 5 }]).seeds;
  const r1 = mergeSeeds(base(), s1, {});
  assert.equal(find(r1.config, 'acme')?.['priority'], 5);
  assert.deepEqual(find(r1.config, 'acme')?.['seed'], { policy: 'seed', origin: '/etc/aura/nexus/sources.d/acme.json' });
  assert.equal(r1.changes.length, 1);

  // User removes it → next boot leaves it removed.
  const removed = { ...r1.config, sources: r1.config.sources.filter((s) => s.name !== 'acme') };
  const r2 = mergeSeeds(removed, s1, r1.state);
  assert.equal(find(r2.config, 'acme'), undefined);
  assert.equal(r2.changes.length, 0);

  // User edits it → kept.
  const edited = structuredClone(r1.config);
  (find(edited, 'acme') as { priority: number }).priority = 99;
  assert.equal(find(mergeSeeds(edited, s1, r1.state).config, 'acme')?.['priority'], 99);

  // The seed file changes that entry → re-applied (even after removal).
  const s2 = seeds([{ name: 'acme', url: 'https://registry.acme.com', priority: 7 }]).seeds;
  assert.equal(find(mergeSeeds(removed, s2, r1.state).config, 'acme')?.['priority'], 7);
});

test('managed policy: enforced every time, removed with its seed', () => {
  const s = seeds([{ name: 'corp', url: 'https://corp', policy: 'managed', priority: 1 }]).seeds;
  const r1 = mergeSeeds(base(), s, {});
  assert.ok(managedMarker(find(r1.config, 'corp')));
  // Someone changed it behind the API's back → put back.
  const tampered = structuredClone(r1.config);
  (find(tampered, 'corp') as { priority: number }).priority = 50;
  assert.equal(find(mergeSeeds(tampered, s, r1.state).config, 'corp')?.['priority'], 1);
  // Gone from the seeds → removed.
  const r3 = mergeSeeds(r1.config, [], r1.state);
  assert.equal(find(r3.config, 'corp'), undefined);
  assert.deepEqual(r3.state, {});
});

test('a vanished seed-policy source stays, as an ordinary user source', () => {
  const s = seeds([{ name: 'acme', url: 'u' }]).seeds;
  const r1 = mergeSeeds(base(), s, {});
  const r2 = mergeSeeds(r1.config, [], r1.state);
  assert.ok(find(r2.config, 'acme'));
  assert.equal(find(r2.config, 'acme')?.['seed'], undefined);
});

test('logins: sealed when new or changed, existing auth kept otherwise', () => {
  const s = seeds([{ name: 'p', url: 'https://p', username: 'ci', password: 'one', policy: 'managed' }]).seeds;
  const r1 = mergeSeeds(base(), s, {});
  assert.deepEqual(r1.logins.map((l) => [l.name, l.login.password]), [['p', 'one']]);
  const sealed = structuredClone(r1.config);
  (find(sealed, 'p') as Record<string, unknown>)['auth'] = { type: 'basic', username: 'ci', secret: 'NEXUS_SRC_P_PASSWORD' };
  const r2 = mergeSeeds(sealed, s, r1.state);
  assert.equal(r2.logins.length, 0, 'unchanged seed + sealed login → nothing to seal');
  assert.ok(find(r2.config, 'p')?.['auth'], 'auth kept');
  const changed = seeds([{ name: 'p', url: 'https://p', username: 'ci', password: 'two', policy: 'managed' }]).seeds;
  assert.equal(mergeSeeds(sealed, changed, r1.state).logins[0]?.login.password, 'two');
});

test('git-app seeds ask for a manifest probe only when the repo changed', () => {
  const s = seeds([{ name: 'g', kind: 'git-app', url: 'https://git/x', policy: 'managed' }]).seeds;
  const r1 = mergeSeeds(base(), s, {});
  assert.deepEqual(r1.probe, ['g']);
  const probed = structuredClone(r1.config);
  (find(probed, 'g') as Record<string, unknown>)['appMeta'] = { id: 'com.x', name: 'X', version: '1' };
  const r2 = mergeSeeds(probed, s, r1.state);
  assert.deepEqual(r2.probe, []);
  assert.ok(find(r2.config, 'g')?.['appMeta']);
});

test('removing a managed seed never removes the last OCI registry', () => {
  const only: SourcesConfig = { schema: 1, sources: [] };
  const s = seeds([{ name: 'corp', url: 'https://corp', policy: 'managed' }]).seeds;
  const r1 = mergeSeeds(only, s, {});
  const r2 = mergeSeeds(r1.config, [], r1.state);
  assert.ok(find(r2.config, 'corp'), 'kept');
  assert.equal(managedMarker(find(r2.config, 'corp')), null, 'but unlocked');
});
