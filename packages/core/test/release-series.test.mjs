// Phase 7b (S, U, V): the release builder's series step, driven with the fake
// `docker` and real git. The series is read, validated and applied with core's
// patch library (run from source by type stripping); the whole series applies
// to the full tree; a patch that does not apply is needs-repair; provenance is
// locally-modified and never signed; an image-changing series is built only
// after approval; validate-only finalizes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, commitAll, git, release, throwawayKey, tmp, trustOf, write } from './release-fixtures.mjs';
import { auraSource, fakeDocker } from './release-builder-fixtures.mjs';

const B = await import(join(ROOT, 'os/release/builder.mjs'));
const LAYOUT = await import(join(ROOT, 'os/release/layout.mjs'));
const SLOT = await import(join(ROOT, 'os/release/series-slot.mjs'));
const core = await import('../dist/index.js');

async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const err = async (p) => { try { await p; } catch (e) { return e; } assert.fail('expected a refusal'); };

function setup() {
  const key = throwawayKey();
  const src = auraSource(key, { extra: (d) => write(d, 'packages/core/src/probe/probe.ts', 'export const PROBE = "upstream";\nexport const OTHER = 1;\n') });
  const data = tmp('aura-data-');
  const fake = fakeDocker(data);
  const base = { dataRoot: data, dataVolume: 'test_aura-app-data', fetchFrom: src.dir, trust: trustOf(key), log: () => {} };
  const go = (o = {}, env = {}) => withEnv({ ...fake.env, ...env }, () => B.build({ ...base, ...o }));
  return { key, src, data, fake, go, L: LAYOUT.layout(data) };
}

/** Patches made with git format-patch on `commit` of `srcDir`; each edit is one commit. */
function makePatches(srcDir, commit, edits) {
  const work = tmp('aura-series-work-');
  git(work, 'clone', '-q', srcDir, '.');
  git(work, 'config', 'user.email', 't@example.invalid');
  git(work, 'config', 'user.name', 't');
  git(work, 'checkout', '-q', commit);
  for (const [subject, fn] of edits) { fn(work); commitAll(work, subject); }
  const out = tmp('aura-series-out-');
  git(work, 'format-patch', '-q', '--zero-commit', '--no-signature', '--no-numbered', '-o', out, `${commit}..HEAD`);
  return readdirSync(out).sort().map((f) => ({ file: `patches/${f}`, content: readFileSync(join(out, f), 'utf8') }));
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** A series directory in the saved form (JSON). */
function seriesDir(commit, patches, { disabled = [] } = {}) {
  const dir = tmp('aura-series-dir-');
  mkdirSync(join(dir, 'patches'));
  for (const p of patches) writeFileSync(join(dir, p.file), p.content);
  const doc = {
    v: 2, target: { kind: 'system' }, base: { commit },
    patches: patches.map((p, i) => ({ file: p.file, subject: `p${i}`, sha256: sha(p.content), enabled: !disabled.includes(i) })),
  };
  writeFileSync(join(dir, 'aura-patches.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return dir;
}

/** The store: the series dir committed into <data>/patches/system, refs/aura/active on it. */
function storeFrom(data, dir) {
  const store = join(data, 'patches/system');
  mkdirSync(store, { recursive: true });
  spawnSync('cp', ['-a', `${dir}/.`, store]);
  git(store, 'init', '-q', '-b', 'main');
  git(store, 'config', 'user.email', 't@example.invalid');
  git(store, 'config', 'user.name', 't');
  commitAll(store, 'series');
  const rev = git(store, 'rev-parse', 'HEAD');
  git(store, 'update-ref', 'refs/aura/active', rev);
  return { store, rev };
}

const probeEdit = (value) => ['probe', (d) => write(d, 'packages/core/src/probe/probe.ts', `export const PROBE = "${value}";\nexport const OTHER = 1;\n`)];

test('a series directory is applied whole: locally-modified, never signed, the digest of core, touched components', async () => {
  const s = setup();
  const plain = await s.go();
  const patches = makePatches(s.src.dir, s.src.commit, [probeEdit('patched'), ['readme', (d) => write(d, 'README.md', 'patched\n')]]);
  const dir = seriesDir(s.src.commit, patches);
  const r = await s.go({ series: { dir } });
  assert.notEqual(r.id, plain.id, 'a series is part of the release identity');
  const rel = s.L.release(r.id);
  assert.match(readFileSync(join(rel, 'packages/core/src/probe/probe.ts'), 'utf8'), /"patched"/);
  assert.equal(existsSync(join(rel, '.git')), false);
  const rec = r.release;
  assert.equal(rec.provenance, 'locally-modified');
  assert.deepEqual(rec.basedOn, { version: '0.1.0', commit: s.src.commit, metaDigest: rec.meta.metaDigest, signed: true });
  assert.equal(rec.series.order.length, 2);
  assert.equal(rec.series.rebased, false);
  // The one digest function (core patches/digest.ts), on the commit it was built on.
  const want = core.seriesDigest({ target: { kind: 'system' }, base: { commit: s.src.commit }, patches: patches.map((p) => ({ sha256: sha(p.content), enabled: true })) });
  assert.equal(rec.series.digest, `sha256:${want}`);
  assert.equal(rec.series.binding.seriesDigest, want);
  assert.equal(rec.series.binding.composition, 'desktop');
  assert.deepEqual(rec.series.touched.map((t) => [t.component, t.modules, t.built, t.deployed]),
    [['_root', [], null, true], ['core', ['probe'], true, true]]);
  assert.equal(rec.series.rebuildsImage, false);
  // gitTree stays the verified upstream tree; treeDigest is the patched tree's.
  assert.equal(rec.gitTree, git(s.src.dir, 'rev-parse', `${s.src.commit}^{tree}`));
});

test('the store\'s active revision is the default series (an update keeps it); a saved but never activated store builds plain', async () => {
  const s = setup();
  const patches = makePatches(s.src.dir, s.src.commit, [probeEdit('stored')]);
  const { store, rev } = storeFrom(s.data, seriesDir(s.src.commit, patches));
  git(store, 'update-ref', '-d', 'refs/aura/active');
  const plain = await s.go();
  assert.equal(plain.release.provenance, 'upstream-signed');
  git(store, 'update-ref', 'refs/aura/active', rev);
  const r = await s.go();
  assert.equal(r.release.provenance, 'locally-modified');
  assert.equal(r.release.series.rev, rev);
  assert.match(readFileSync(join(s.L.release(r.id), 'packages/core/src/probe/probe.ts'), 'utf8'), /"stored"/);
});

test('U: the series is re-based onto a new release; a patch that no longer applies is needs-repair and nothing changes', async () => {
  const s = setup();
  const okPatch = makePatches(s.src.dir, s.src.commit, [['readme', (d) => write(d, 'README.md', 'patched\n')]]);
  const bad = makePatches(s.src.dir, s.src.commit, [probeEdit('mine')]);
  const first = await s.go({ series: { dir: seriesDir(s.src.commit, okPatch) }, firstInstall: true });
  // Upstream release 0.2.0 changes the probe line the second patch edits.
  write(s.src.dir, 'packages/core/src/probe/probe.ts', 'export const PROBE = "upstream-0.2";\nexport const OTHER = 1;\n');
  commitAll(s.src.dir, 'upstream change');
  const v2 = release(s.src.dir, '0.2.0', s.key);
  const r = await s.go({ series: { dir: seriesDir(s.src.commit, okPatch) }, ref: 'v0.2.0' });
  assert.equal(r.release.commit, v2.commit);
  assert.equal(r.release.series.rebased, true);
  assert.equal(r.release.series.base.commit, v2.commit);
  assert.notEqual(r.release.series.digest, first.release.series.digest, 'a re-based series is a new identity');
  const callsBefore = s.fake.calls().length;
  const e = await err(s.go({ series: { dir: seriesDir(s.src.commit, bad) }, ref: 'v0.2.0' }));
  assert.equal(e.code, 'needs-repair');
  assert.equal(e.repair.patch.file, bad[0].file);
  assert.deepEqual(e.repair.conflicts, ['packages/core/src/probe/probe.ts']);
  assert.equal(e.repair.commit, v2.commit);
  assert.equal(B.readPointer(s.data).current, first.id, 'the current release is untouched');
  assert.deepEqual(readdirSync(s.L.releases).filter((n) => n.startsWith('.staging-')), []);
  const job = JSON.parse(readFileSync(s.L.job(readdirSync(s.L.jobs).filter((n) => n.endsWith('.json')).sort().pop().replace(/\.json$/, '')), 'utf8'));
  assert.equal(job.code, 'needs-repair');
  assert.equal(job.repair.index, 0);
  assert.equal(s.fake.calls().slice(callsBefore), '', 'nothing ran after the conflict');
});

test('refused content never reaches a tree: the trust anchor, a changed byte, an app target', async () => {
  const s = setup();
  const anchor = makePatches(s.src.dir, s.src.commit, [['key', (d) => write(d, 'os/release-keys/evil.pub', 'x\n')]]);
  const e1 = await err(s.go({ series: { dir: seriesDir(s.src.commit, anchor) } }));
  assert.equal(e1.code, 'series-refused');
  assert.match(e1.message, /trust anchor/);
  const p = makePatches(s.src.dir, s.src.commit, [probeEdit('x')]);
  const dir = seriesDir(s.src.commit, p);
  writeFileSync(join(dir, p[0].file), `${p[0].content}\n`);
  assert.equal((await err(s.go({ series: { dir } }))).code, 'series-invalid');
  const app = seriesDir(s.src.commit, p);
  const doc = JSON.parse(readFileSync(join(app, 'aura-patches.json'), 'utf8'));
  doc.target = { kind: 'app', appId: 'io.x.y' };
  writeFileSync(join(app, 'aura-patches.json'), JSON.stringify(doc));
  assert.equal((await err(s.go({ series: { dir: app } }))).code, 'series-invalid');
  // YAML that AuraOS never wrote (flow mappings with content) is refused with how to produce the saved form.
  const yml = seriesDir(s.src.commit, p);
  rmSync(join(yml, 'aura-patches.json'));
  writeFileSync(join(yml, 'aura-patches.yaml'), 'v: 2\ntarget: { kind: system }\n');
  const ey = await err(s.go({ series: { dir: yml } }));
  assert.match(ey.message, /not in the form AuraOS saves[\s\S]*aura system patch save[\s\S]*aura-patches\.json/);
});

test('a disabled patch is not applied and changes the identity; all disabled builds the upstream tree (upstream-signed)', async () => {
  const s = setup();
  const p = makePatches(s.src.dir, s.src.commit, [probeEdit('off')]);
  const on = await s.go({ series: { dir: seriesDir(s.src.commit, p) } });
  const off = await s.go({ series: { dir: seriesDir(s.src.commit, p, { disabled: [0] }) } });
  assert.notEqual(off.release.series.digest, on.release.series.digest);
  assert.equal(off.release.provenance, 'upstream-signed');
  assert.equal(off.release.series.disabled.length, 1);
  assert.match(readFileSync(join(s.L.release(off.id), 'packages/core/src/probe/probe.ts'), 'utf8'), /"upstream"/);
});

test('build isolation: validate-only finalizes nothing; an image-changing series validates in the upstream images and builds its image only when approved', async () => {
  const s = setup();
  await s.go({ firstInstall: true });
  const img = makePatches(s.src.dir, s.src.commit, [['image', (d) => write(d, 'os/base/x', 'patched base\n')]]);
  const dir = seriesDir(s.src.commit, img);
  const before = s.fake.calls();
  const v = await s.go({ series: { dir }, validateOnly: true });
  assert.equal(v.validated.series.rebuildsImage, true);
  assert.equal(existsSync(s.L.release(v.id)), false, 'nothing finalized');
  const runs = s.fake.calls().slice(before.length);
  assert.doesNotMatch(runs, /buildx build|^docker build /m, 'no image build for an unapproved series');
  assert.match(runs, /build\.sh build/);
  const job = JSON.parse(readFileSync(s.L.job(v.job), 'utf8'));
  assert.equal(job.phase, 'validated');
  assert.equal((await err(s.go({ series: { dir } }))).code, 'image-change-unapproved');
  assert.equal((await err(s.go({ series: { dir }, imageChangeApproved: true, expectSeriesDigest: 'sha256:00' }))).code, 'series-moved');
  // Owner 2026-11-27: the base images of the changed Dockerfile are pinned by digest in the validation...
  assert.deepEqual(Object.keys(v.validated.inputs.from).sort(), ['node:22.23.5-bookworm', 'node:22.23.5-bookworm-slim']);
  assert.ok(Object.values(v.validated.inputs.from).every((d) => /^sha256:[0-9a-f]{64}$/.test(d)));
  assert.deepEqual(v.validated.series.imageFiles, ['os/base/x']);
  // ...and an approved build that resolves another base image is refused.
  const moved = await err(s.go({ series: { dir }, imageChangeApproved: true, expectSeriesDigest: v.validated.series.digest, expectInputs: v.validated.inputs }, { FAKE_BASE_V: '2' }));
  assert.equal(moved.code, 'build-inputs-moved');
  assert.match(moved.message, /base image node:22\.23\.5-bookworm/);
  const r = await s.go({ series: { dir }, imageChangeApproved: true, expectSeriesDigest: v.validated.series.digest, expectInputs: v.validated.inputs });
  assert.equal(r.id, v.id);
  assert.notEqual(r.release.images.base, v.validated.images.base, 'the approved build has its own image');
  assert.deepEqual(r.release.inputs.from, v.validated.inputs.from);
});

test('binding: an approved build that resolves another Node, package manager or reused image is refused', async () => {
  const s = setup();
  await s.go({ firstInstall: true });
  const dir = seriesDir(s.src.commit, makePatches(s.src.dir, s.src.commit, [probeEdit('inputs')]));
  const v = await s.go({ series: { dir }, validateOnly: true });
  const want = v.validated.inputs;
  assert.equal(want.rebuildsImage, false);
  assert.match(want.images.shell, /^sha256:/);
  assert.deepEqual(want.from, {}, 'unchanged images: the reused image ids are the pin');
  const e = await err(s.go({ series: { dir }, expectInputs: want }, { FAKE_NODE: 'v22.24.0' }));
  assert.equal(e.code, 'build-inputs-moved');
  assert.match(e.message, /node\(base\) v22\.23\.5 → v22\.24\.0/);
  assert.equal((await err(s.go({ series: { dir }, expectInputs: { ...want, images: { ...want.images, shell: 'sha256:00' } } }))).code, 'build-inputs-moved');
  assert.equal((await s.go({ series: { dir }, expectInputs: want })).ok, true);
});

test('isolation: an unapproved series is installed without its scripts while networked, gets credentials only when it changes no dependency input, and never touches the approved store', async () => {
  const s = setup();
  await s.go({ firstInstall: true });
  const npmrc = join(tmp('aura-npmrc-'), 'npmrc');
  writeFileSync(npmrc, '//registry.example/:_authToken=CANARY-TOKEN\n', { mode: 0o600 });
  const infra = { digest: null, secrets: { infra_npmrc: npmrc } };
  const runs = async (series) => {
    const before = s.fake.calls().length;
    const v = await s.go({ series: { dir: series }, validateOnly: true, infra }, { FAKE_OFFLINE_RC: '1' });
    assert.equal(v.validated.id.length > 0, true);
    return s.fake.calls().slice(before).split('\n').filter((l) => l.startsWith('docker run --rm --name aura-release-'));
  };
  const src = await runs(seriesDir(s.src.commit, makePatches(s.src.dir, s.src.commit, [probeEdit('iso')])));
  for (const l of src) {
    assert.doesNotMatch(l, /docker\.sock|\s-v\s/, 'no socket, no host bind');
    assert.match(l, /volume-subpath=aura\/pnpm-store-unapproved/, 'the unapproved store only');
    if (!/--network none/.test(l)) assert.match(l, /AURA_BUILD_IGNORE_SCRIPTS=1/, `no script runs while networked: ${l}`);
    if (/target=\/run\/aura-build/.test(l)) assert.match(l, /build\.sh deps$/, 'credentials only for the script-less fetch');
  }
  const scripts = src.find((l) => /build\.sh scripts$/.test(l));
  assert.match(scripts, /--network none/);
  assert.doesNotMatch(scripts, /target=\/run\/aura-build/);
  assert.ok(src.some((l) => /target=\/run\/aura-build/.test(l)), 'a source-only series may fetch with the registry credentials (scripts off)');
  // A series that changes package.json: the fetch gets no credentials at all.
  const dep = await runs(seriesDir(s.src.commit, makePatches(s.src.dir, s.src.commit, [['deps', (d) => write(d, 'packages/core/package.json', '{"name":"@aura/core","x":1}\n')]])));
  assert.ok(dep.every((l) => !/target=\/run\/aura-build/.test(l)), 'no credentials for a dependency-changing unapproved series');
  assert.ok(!existsSync(join(s.L.pnpmStore, 'x')) && existsSync(s.L.pnpmStoreUnapproved));
});

test('the old saved YAML form (Track P v1, 7a v2) reads like the yaml library reads it; the builder accepts it', async () => {
  const subjects = ['plain subject', 'Drop removed getAppBasePath import: apps are served from /, so deep links start at /#/',
    "it's \"quoted\" and # hashed", '123', 'true', '- dash', 'ünïcödé ✓', 'x'.repeat(150), 'a: b', '  lead', 'tab\there', 'trail '];
  const v1 = { app: 'io.x.app', base: { repository: 'https://gitlab.example/x.git', commit: '0d207495b02abe11e3b6a10ab09a832b17e8b5e3' },
    patches: subjects.map((subject, i) => ({ file: `patches/000${i}-x.patch`, subject })) };
  const v2 = { v: 2, target: { kind: 'app', appId: 'io.x.app', scope: 'user' }, base: { commit: '1'.repeat(40), path: 'apps/x' },
    patches: subjects.map((subject, i) => ({ file: `patches/000${i}-y.patch`, subject, sha256: 'a'.repeat(64), enabled: i % 2 === 0 })) };
  const LIB = await SLOT.patchLib();
  for (const doc of [v1, v2, { app: 'io.x.app', base: { commit: 'abcdef1' }, patches: [] }]) {
    const text = yamlStringify(doc);
    assert.deepEqual(LIB.parseSavedYaml(text), yamlParse(text), text);
  }
  assert.throws(() => LIB.parseSavedYaml('a: &x 1\n'), /unsupported/);
  // The builder reads a store revision that still has the old file name.
  const s = setup();
  const p = makePatches(s.src.dir, s.src.commit, [probeEdit('legacy')]);
  const dir = seriesDir(s.src.commit, p);
  const doc = JSON.parse(readFileSync(join(dir, 'aura-patches.json'), 'utf8'));
  rmSync(join(dir, 'aura-patches.json'));
  writeFileSync(join(dir, 'aura-patches.yaml'), yamlStringify(doc));
  const r = await s.go({ series: { dir } });
  assert.match(readFileSync(join(s.L.release(r.id), 'packages/core/src/probe/probe.ts'), 'utf8'), /"legacy"/);
});

test('V: a build or check failure with a series names the touched components', async () => {
  const s = setup();
  const p = makePatches(s.src.dir, s.src.commit, [probeEdit('broken')]);
  const e = await err(s.go({ series: { dir: seriesDir(s.src.commit, p) } }, { FAKE_FAIL_BUILD: '1' }));
  assert.equal(e.code, 'build');
  assert.match(e.message, /system patches touch core/);
});

test('series-plan: what the operator authorizes, with the digest the build will have', async () => {
  const s = setup();
  const p = makePatches(s.src.dir, s.src.commit, [probeEdit('plan')]);
  const dir = seriesDir(s.src.commit, p);
  const out = spawnSync(process.execPath, [join(ROOT, 'os/release/builder.mjs'), 'series-plan', '--series-dir', dir, '--commit', s.src.commit], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const plan = JSON.parse(out.stdout);
  const r = await s.go({ series: { dir } });
  assert.equal(plan.digest, r.release.series.digest);
  assert.deepEqual(plan.patches[0].files.map((f) => f.path), ['packages/core/src/probe/probe.ts']);
  assert.deepEqual([plan.changesImages, plan.imageFiles], [false, []]);
  const bad = spawnSync(process.execPath, [join(ROOT, 'os/release/builder.mjs'), 'series-plan', '--series-dir', tmp('aura-empty-')], { encoding: 'utf8' });
  assert.equal(bad.status, 3);
  assert.equal(JSON.parse(bad.stdout).code, 'series-missing');
  assert.match(JSON.parse(bad.stdout).error, /aura system patch save/);
});

test('componentOf maps paths to the components of release.json', () => {
  const comps = [{ name: 'core', kind: 'package', path: 'packages/core' }, { name: 'com.x.app', kind: 'app', path: 'apps/com.x.app' }];
  assert.deepEqual(SLOT.componentOf('packages/core/src/release/a.ts', comps), { component: 'core', kind: 'package', module: 'release' });
  assert.deepEqual(SLOT.componentOf('apps/com.x.app/src/x.ts', comps), { component: 'com.x.app', kind: 'app' });
  assert.deepEqual(SLOT.componentOf('os/boot.sh', comps), { component: 'os', kind: 'os' });
  assert.deepEqual(SLOT.componentOf('Dockerfile', comps), { component: '_root', kind: 'root' });
});

test('the portable patch modules import only node builtins and types (the builder runs them by type stripping)', async () => {
  for (const f of ['seriesFile.ts', 'digest.ts', 'validate.ts', 'apply.ts']) {
    const src = readFileSync(join(ROOT, 'packages/core/src/patches', f), 'utf8');
    for (const m of src.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm)) {
      assert.ok(m[1] || m[2].startsWith('node:'), `${f}: ${m[0]} (only node: builtins and import type)`);
    }
    assert.doesNotMatch(src, /^\s*(export\s+)?(const\s+)?enum\s|^\s*namespace\s/m, `${f}: no non-erasable syntax`);
  }
  const lib = await SLOT.patchLib();
  assert.equal(typeof lib.amApply, 'function');
});
