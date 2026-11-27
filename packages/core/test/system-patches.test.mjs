// Phase 7b stream S/U/V: the system patch engine (core/src/release/systemPatches.ts)
// with real git: workspaces from the release mirror with the active series,
// save as store revisions (validated; the trust anchor refused), disable and
// enable as revisions, the approval binding recomputed from the store, the
// D35 session warning, and the D71 update plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'aura-sysp-'));
process.env.AURA_DATA_DIR = data;
const core = await import('../dist/index.js');
const S = core.systemPatches;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
const write = (dir, rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); writeFileSync(join(dir, rel), text); };
function commit(dir, msg) { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', 'commit', '-qm', msg); return git(dir, 'rev-parse', 'HEAD'); }

/** An upstream repo, its bare mirror under <data>/aura/release/mirror.git. */
function upstream() {
  const src = mkdtempSync(join(tmpdir(), 'aura-sysp-src-'));
  git(src, 'init', '-q', '-b', 'main');
  write(src, 'packages/core/src/probe/probe.ts', 'export const PROBE = "upstream";\n');
  write(src, 'apps/com.aura.terminal/app.manifest.json', '{"id":"com.aura.terminal"}\n');
  write(src, 'os/release-keys/k.pub', 'key\n');
  const c = commit(src, 'release 0.1.0');
  const mirror = join(data, 'aura/release/mirror.git');
  if (!existsSync(mirror)) execFileSync('git', ['clone', '-q', '--bare', src, mirror]);
  return { src, commit: c, mirror };
}
const up = upstream();
const base = { commit: up.commit, release: '0.1.0-abc', version: '0.1.0' };
const edit = (ws, rel, text, msg) => { write(ws, rel, text); commit(ws, msg); };

test('start: a workspace from the mirror at the release commit; reused; save makes a validated store revision', () => {
  const w = S.startWorkspace({ dataDir: data, userId: 'owner', root: join(data, 'aura/workspaces/owner/system'), mirror: up.mirror, base });
  assert.equal(w.created, true);
  assert.equal(w.path, join(data, 'aura/workspaces/owner/system/1'));
  assert.equal(`aura/workspaces/owner/system/1`, core.workspaceSubpath('owner', S.SYSTEM_INSTALLATION, 1), 'the app workspaces\' layout');
  assert.equal(git(w.path, 'rev-parse', 'HEAD'), up.commit);
  assert.equal(w.apply, null, 'no active series yet');
  const again = S.startWorkspace({ dataDir: data, userId: 'owner', root: join(data, 'aura/workspaces/owner/system'), mirror: up.mirror, base });
  assert.equal(again.created, false);
  assert.equal(again.n, 1);
  assert.throws(() => S.saveWorkspace({ dataDir: data, workspace: mkdtempSync(join(tmpdir(), 'x-')), message: 'm' }), (e) => e.code === 'not-a-workspace');
  edit(w.path, 'packages/core/src/probe/probe.ts', 'export const PROBE = "patched";\n', 'probe: patched');
  const saved = S.saveWorkspace({ dataDir: data, workspace: w.path, message: 'first (owner)' });
  assert.equal(saved.changed, true);
  assert.equal(saved.patches, 1);
  const view = S.seriesView(data, saved.rev);
  assert.equal(view.base.commit, up.commit);
  assert.equal(view.base.release, '0.1.0-abc');
  assert.equal(view.patches[0].subject, 'probe: patched');
  assert.match(S.seriesDiff(data, saved.rev), /\+export const PROBE = "patched";/);
  assert.equal(S.seriesLog(data)[0].subject, 'first (owner)');
  // The store's file is the saved form (JSON), readable without a YAML parser.
  JSON.parse(readFileSync(join(S.storeDir(data), 'aura-patches.yaml'), 'utf8'));
});

test('save refuses the trust anchor (D71), and nothing is recorded', () => {
  const w = S.startWorkspace({ dataDir: data, userId: 'agent1', root: join(data, 'aura/workspaces/agent1/system'), mirror: up.mirror, base });
  edit(w.path, 'os/release-keys/k.pub', 'evil\n', 'swap the key');
  const before = S.seriesLog(data).length;
  assert.throws(() => S.saveWorkspace({ dataDir: data, workspace: w.path, message: 'x' }), (e) => e.code === 'refused' && /trust anchor/.test(e.message));
  assert.equal(S.seriesLog(data).length, before);
});

test('activation marks refs; a new workspace carries the active series; disable/enable are revisions kept by later saves', () => {
  const head = S.resolveRev(data);
  assert.equal(S.markApproved(data, head), 1);
  S.markActive(data, head);
  assert.equal(S.storeRef(data, S.ACTIVE_REF), head);
  const w = S.startWorkspace({ dataDir: data, userId: 'owner', root: join(data, 'aura/workspaces/owner/system'), mirror: up.mirror, base, fresh: true });
  assert.equal(w.apply.ok, true);
  assert.match(readFileSync(join(w.path, 'packages/core/src/probe/probe.ts'), 'utf8'), /patched/);
  edit(w.path, 'apps/com.aura.terminal/new.txt', 'x\n', 'terminal: add a file');
  const two = S.saveWorkspace({ dataDir: data, workspace: w.path, message: 'two' });
  assert.equal(two.patches, 2);
  const off = S.setPatchEnabled({ dataDir: data, patch: '1', enabled: false, message: 'disable 1' });
  assert.notEqual(off.digest, two.digest);
  assert.equal(S.seriesView(data, off.rev).patches[0].enabled, false);
  assert.throws(() => S.setPatchEnabled({ dataDir: data, patch: '1', enabled: false, message: 'm' }), (e) => e.code === 'unchanged');
  assert.throws(() => S.setPatchEnabled({ dataDir: data, patch: '9', enabled: true, message: 'm' }), (e) => e.code === 'no-patch');
  // A later save from a workspace that never applied the disabled patch keeps it, disabled.
  const w2 = S.startWorkspace({ dataDir: data, userId: 'owner2', root: join(data, 'aura/workspaces/owner2/system'), mirror: up.mirror, base });
  edit(w2.path, 'README.md', 'r\n', 'readme');
  const kept = S.saveWorkspace({ dataDir: data, workspace: w2.path, message: 'three' });
  // A save is what the workspace holds (base..HEAD), like app patches; disabled patches it never applied are appended.
  assert.deepEqual(S.seriesView(data, kept.rev).patches.map((p) => [p.subject, p.enabled]), [['probe: patched', true], ['readme', true]]);
  const off2 = S.setPatchEnabled({ dataDir: data, patch: '2', enabled: false, message: 'disable readme' });
  const w3 = S.startWorkspace({ dataDir: data, userId: 'owner3', root: join(data, 'aura/workspaces/owner3/system'), mirror: up.mirror, base });
  edit(w3.path, 'NOTES.md', 'n\n', 'notes');
  const four = S.saveWorkspace({ dataDir: data, workspace: w3.path, message: 'four' });
  assert.deepEqual(S.seriesView(data, four.rev).patches.map((p) => [p.subject, p.enabled]), [['probe: patched', true], ['notes', true], ['readme', false]]);
  assert.ok(off2.rev);
  const on = S.setPatchEnabled({ dataDir: data, patch: '3', enabled: true, message: 'enable readme' });
  assert.equal(S.seriesView(data, on.rev).patches[2].enabled, true);
});

test('binding: recomputed from the store; a validated build of another revision is refused; D35 and the dialog lines', () => {
  const rev = S.resolveRev(data);
  const view = S.seriesView(data, rev);
  const loadedDigest = core.seriesDigest({ target: { kind: 'system' }, base: { commit: up.commit }, patches: view.patches });
  const validated = {
    id: '0.1.0-abcdef123456-00000000', commit: up.commit, version: '0.1.0', provenance: 'locally-modified', composition: 'desktop',
    series: { digest: `sha256:${loadedDigest}`, rev, base: { commit: up.commit, version: '0.1.0' }, order: [],
      touched: [{ component: 'core', kind: 'package', modules: ['probe'], built: true, deployed: true }, { component: 'com.aura.terminal', kind: 'app', built: true, deployed: true }], rebuildsImage: false },
  };
  const b = S.systemPatchBinding({ dataDir: data, rev, validated });
  assert.equal(b.series.seriesRev, rev);
  assert.equal(b.series.composition, 'desktop');
  assert.equal(b.series.baseCommit, up.commit);
  assert.deepEqual(S.endsSessions(b), ['com.aura.terminal']);
  assert.deepEqual(S.endsSessions({ ...b, components: [], rebuildsImage: true }), ['the AuraOS images']);
  const lines = S.approvalDetails(b, view);
  assert.ok(lines.some((l) => /^Base release: 0\.1\.0/.test(l)));
  assert.ok(lines.some((l) => /core \(probe\)/.test(l)));
  assert.ok(lines.some((l) => /locally modified .* based on signed 0\.1\.0/.test(l)));
  assert.ok(!lines.some((l) => /AuraOS 0\.1\.0, signed/.test(l)), 'never presented as signed');
  const older = S.seriesLog(data)[1].rev;
  assert.throws(() => S.systemPatchBinding({ dataDir: data, rev: older, validated }), (e) => e.code === 'binding-mismatch');
  const other = S.systemPatchBinding({ dataDir: data, rev, validated: { ...validated, composition: 'server' } });
  assert.notDeepEqual(other.series, b.series, 'the composition is part of the binding (D73)');
});

test('U/D71: the update plan for every case', () => {
  const ok = S.planUpdate({ failed: false, securityUpdate: true, signed: true, policy: 'follow-signed' });
  assert.equal(ok.action, 'update-with-series');
  const plain = S.planUpdate({ failed: true, securityUpdate: false, signed: true, policy: 'follow-signed' });
  assert.deepEqual(plain.choices, ['update-without-patch', 'hold-update'], 'update without is the default');
  const sec = S.planUpdate({ failed: true, securityUpdate: true, signed: true, policy: 'follow-signed' });
  assert.equal(sec.action, 'update-without-failing');
  assert.deepEqual(sec.choices, ['update-without-patch'], 'no hold for a signed security update');
  const held = S.planUpdate({ failed: true, securityUpdate: true, signed: true, policy: 'hold' });
  assert.deepEqual(held.choices, ['update-without-patch', 'hold-update']);
  assert.equal(held.holdIsOverride, true);
  const unsigned = S.planUpdate({ failed: true, securityUpdate: true, signed: false, policy: 'follow-signed' });
  assert.equal(unsigned.action, 'choose', 'an unsigned securityUpdate flag is not honoured');
});

test('U: update without the patch disables it as a new revision and records needs repair; the notice names the repair', () => {
  const rev = S.resolveRev(data);
  const view = S.seriesView(data, rev);
  const p = view.patches.find((x) => x.enabled);
  const repair = { release: '0.2.0-x', commit: 'b'.repeat(40), rev, patch: { file: p.file, subject: p.subject, sha256: p.sha256 }, index: p.index,
    reason: 'conflict', conflicts: ['packages/core/src/probe/probe.ts'], message: 'conflict', at: new Date().toISOString(), securityUpdate: true };
  const r = S.disableForUpdate(data, repair, 'owner');
  assert.equal(S.seriesView(data, r.rev).patches[p.index].enabled, false);
  const rec = S.readNeedsRepair(data);
  assert.equal(rec.disabledIn, r.rev);
  const n = S.needsRepairNotice(rec);
  assert.match(n.body, /aura system patch start --base 0\.2\.0-x/);
  assert.match(n.body, /The update ran without it/);
  S.writeNeedsRepair(data, null);
  assert.equal(S.readNeedsRepair(data), null);
});

test('builderArgs: the trusted builder of the running release, the store revision, approval flags', () => {
  const a = S.builderArgs({ auraRoot: '/workspace', dataDir: '/data', dataVolume: 'v', fetchFrom: '/data/aura/release/mirror.git', channel: 'signed', ref: 'v0.1.0',
    commit: up.commit, composition: 'desktop', rev: 'r1', jobId: 'j', validateOnly: true });
  assert.equal(a[0], '/workspace/os/release/builder.mjs');
  assert.ok(a.includes('--validate-only') && !a.includes('--image-change-approved'));
  assert.deepEqual(a.slice(a.indexOf('--series-store'), a.indexOf('--series-store') + 4), ['--series-store', '/data/patches/system', '--series-rev', 'r1']);
  assert.ok(a.includes('--keys'));
});

test('U hook: a signed security update under follow-signed disables the failing patch at once; otherwise the owner chooses', () => {
  const rev = S.resolveRev(data);
  const view = S.seriesView(data, rev);
  const p = view.patches.find((x) => x.enabled);
  const repair = { release: '0.3.0-x', commit: 'c'.repeat(40), rev, patch: { file: p.file, subject: p.subject, sha256: p.sha256 }, index: p.index, conflicts: [], message: 'm' };
  const ask = S.onUpdateConflict({ dataDir: data, repair, securityUpdate: false, signed: true, policy: 'follow-signed', by: 'updater' });
  assert.equal(ask.rev, null);
  assert.deepEqual(ask.plan.choices, ['update-without-patch', 'hold-update']);
  assert.equal(S.resolveRev(data), rev, 'nothing changed before the owner chose');
  const sec = S.onUpdateConflict({ dataDir: data, repair, securityUpdate: true, signed: true, policy: 'follow-signed', by: 'updater' });
  assert.ok(sec.rev);
  assert.equal(S.seriesView(data, sec.rev).patches[p.index].enabled, false);
  assert.equal(sec.record.securityUpdate, true);
  assert.match(sec.notice.body, /ran without it/);
});
