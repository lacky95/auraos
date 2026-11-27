// Owner decision 5-main, "run-as reversible": the run-as migration
// (identity/runAsOwnership.ts) through the reviewed ownership apply, on a real
// tree: root -> app -> root restores every entry exactly (owner, group,
// mode, contents); only the previous identity's entries change (a sidecar's
// uid, a chosen group, another app's bound files under `.mnt`, a symlink's
// target, a hard-linked file and Private Homes are never touched); what the
// app created since goes to root; a failed or interrupted apply is restored
// from its journal; a journal line outside the rows or through a link is
// never followed.
//
// Runs as root (the shell's identity): chown is real.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, chmodSync, chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { installationAppHomes } from '../dist/homes/appHomeAdmin.js';
import {
  applyOwnershipRequest, ownershipJournalPath, restoreJournalEntries, runOwnershipApply, newOwnershipJournal,
} from '../dist/identity/ownershipApply.js';
import { runAsMigrationBlock, runAsOwnershipPaths, runAsOwnershipPlan } from '../dist/identity/runAsOwnership.js';

const ROOT = { uid: 0, gid: 0 };
const APP = { uid: 200017, gid: 200017 };
const SIDECAR = 999;

/** A data dir with one installed app (`org.t.app`, installation `inst-1`) and the things that must never change. */
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'runas-'));
  const appDataRoot = join(d, 'scopes', 'global', 'apps', 'org.t.app');
  const data = join(appDataRoot, 'org.t.app');
  mkdirSync(join(data, 'sub'), { recursive: true, mode: 0o750 });
  writeFileSync(join(data, 'a.txt'), 'alpha', { mode: 0o640 });
  writeFileSync(join(data, 'sub', 'b.db'), 'bravo', { mode: 0o600 });
  writeFileSync(join(data, 'grouped'), 'charlie', { mode: 0o664 });
  chownSync(join(data, 'grouped'), 0, 5);                         // a group chosen on purpose
  mkdirSync(join(data, 'pg'), { mode: 0o700 });
  writeFileSync(join(data, 'pg', 'PG_VERSION'), '16', { mode: 0o600 });
  chownSync(join(data, 'pg'), SIDECAR, SIDECAR);                 // a sidecar's own data
  chownSync(join(data, 'pg', 'PG_VERSION'), SIDECAR, SIDECAR);
  mkdirSync(join(data, '.mnt', 'org.other.app'), { recursive: true });
  writeFileSync(join(data, '.mnt', 'org.other.app', 'theirs'), 'other app');   // another app's files (a bind target)
  writeFileSync(join(d, 'outside'), 'outside', { mode: 0o600 });
  symlinkSync(join(d, 'outside'), join(data, 'link'));           // a link out: its target never changes
  linkSync(join(d, 'outside'), join(data, 'hard'));              // a hard link: left as it is
  const home = join(d, 'aura', 'apphomes', 'inst-1', 'global');
  mkdirSync(join(home, '.config'), { recursive: true, mode: 0o755 });
  writeFileSync(join(home, '.config', 'tool.json'), '{"x":1}', { mode: 0o600 });
  mkdirSync(join(d, 'aura', 'apphomes', 'inst-1', 'users', 'default'), { recursive: true });
  const priv = join(d, 'aura', 'home', 'default');
  mkdirSync(priv, { recursive: true });
  writeFileSync(join(priv, '.secret'), 'mine', { mode: 0o600 });
  const appDir = join(d, 'src', 'org.t.app');
  mkdirSync(join(appDir, 'node_modules'), { recursive: true });
  return { d, appDataRoot, data, home, priv, appDir };
}

/** Owner, group, mode (and contents of files) of every entry under `dir`, never following a link. */
function snapshot(dir, base = dir, out = {}) {
  const st = lstatSync(dir);
  out[relative(base, dir) || '.'] = `${st.uid}:${st.gid}:${(st.mode & 0o7777).toString(8)}`;
  if (st.isDirectory()) {
    for (const n of readdirSync(dir).sort()) snapshot(join(dir, n), base, out);
  } else if (st.isFile()) {
    out[relative(base, dir)] += `:${readFileSync(dir, 'utf-8')}`;
  }
  return out;
}

const owner = (p) => { const st = lstatSync(p); return `${st.uid}:${st.gid}`; };
const mode = (p) => (lstatSync(p).mode & 0o7777).toString(8);

function input(f, runAs, previousJournal = null) {
  return {
    appId: 'org.t.app', installationId: 'inst-1', runAs, appDataRoot: f.appDataRoot, appDir: f.appDir, devServed: true,
    appHomes: installationAppHomes(f.d, 'inst-1'),
    from: runAs === 'app' ? ROOT : APP, to: runAs === 'app' ? APP : ROOT, previousJournal,
  };
}
const refuseRoots = (f) => ['/', f.d, join(f.d, 'aura'), join(f.d, 'scopes')];

async function migrate(f, runAs, previousJournal = null) {
  const { plan, apply } = await runAsOwnershipPlan(input(f, runAs, previousJournal), { refuseRoots: refuseRoots(f) });
  const r = await runOwnershipApply(f.d, plan.digest, apply.rows, { ...(apply.restore ? { restore: apply.restore } : {}) });
  return { plan, apply, ...r };
}

test('root -> app -> root: every entry back exactly; only the previous identity\'s entries ever change', { skip: process.getuid?.() !== 0 && 'needs root' }, async () => {
  const f = fixture();
  try {
    const before = { data: snapshot(f.data), homes: snapshot(join(f.d, 'aura', 'apphomes')), priv: snapshot(f.priv), outside: snapshot(join(f.d, 'outside')) };
    // The dry run: rows of the managed storage only, a digest, nothing changed.
    const dry = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    assert.deepEqual(dry.plan.rows.map((r) => [r.kind, relative(f.d, r.path), r.exists]).filter((r) => r[2]).sort((x, y) => x[1].localeCompare(y[1])), [
      ['app-home', 'aura/apphomes/inst-1/global', true],
      ['app-home', 'aura/apphomes/inst-1/users/default', true],
      ['app-data', 'scopes/global/apps/org.t.app/org.t.app', true],
    ]);
    assert.ok(dry.plan.rows.every((r) => !r.path.startsWith(f.priv)), 'never a Private Home');
    assert.deepEqual([dry.plan.from, dry.plan.to, dry.plan.restore], ['0:0', '200017:200017', null]);
    assert.match(dry.plan.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(snapshot(f.data), before.data, 'a dry run changes nothing');
    assert.equal(dry.apply.rows.some((r) => r.kind === 'dev-cache'), false, 'a missing dev cache is not created by the migration');

    const up = await migrate(f, 'app');
    assert.equal(up.plan.digest, dry.plan.digest, 'the same tree, the same digest');
    for (const p of ['a.txt', 'sub', 'sub/b.db', '.']) assert.equal(owner(join(f.data, p)), '200017:200017', p);
    assert.equal(owner(join(f.data, 'grouped')), '200017:5', 'a group chosen on purpose is kept');
    assert.equal(owner(join(f.data, 'pg', 'PG_VERSION')), `${SIDECAR}:${SIDECAR}`, 'a sidecar\'s entries keep their owner');
    assert.equal(owner(join(f.data, '.mnt', 'org.other.app', 'theirs')), '0:0', 'another app\'s bound files are never walked');
    assert.equal(owner(join(f.data, 'link')), '200017:200017', 'a link itself changes');
    assert.deepEqual(snapshot(join(f.d, 'outside')), before.outside, 'its target and a hard-linked file never');
    assert.deepEqual([owner(f.home), mode(f.home)], ['200017:200017', '700']);
    assert.equal(owner(join(f.home, '.config', 'tool.json')), '200017:200017');
    assert.deepEqual(snapshot(f.priv), before.priv, 'the Private Home is untouched');
    assert.equal(mode(join(f.data, 'sub', 'b.db')), '600', 'modes of data entries stay');

    // The app runs as its uid and writes: a new file is its own; a sidecar writes its own.
    writeFileSync(join(f.data, 'new.txt'), 'new', { mode: 0o600 });
    chownSync(join(f.data, 'new.txt'), APP.uid, APP.gid);
    writeFileSync(join(f.home, 'later'), 'later', { mode: 0o600 });
    chownSync(join(f.home, 'later'), APP.uid, APP.gid);

    // The flip back: the earlier journal restored exactly first, then the rest to root.
    const journal = ownershipJournalPath(f.d, up.journal.split('/').pop());
    const back = await migrate(f, 'root', journal);
    assert.equal(back.plan.restore.journal, up.journal.split('/').pop());
    assert.ok(back.plan.restore.entries > 0);
    assert.ok(back.restored.restored > 0);
    assert.equal(back.restored.skipped, 0);
    const after = snapshot(f.data);
    assert.deepEqual([after['new.txt'], snapshot(f.home).later], ['0:0:600:new', '0:0:600:later'], 'what the app created since goes to root');
    delete after['new.txt'];
    assert.deepEqual(after, before.data, 'every entry exactly as before: owner, group, mode, contents');
    const homes = snapshot(join(f.d, 'aura', 'apphomes'));
    delete homes['inst-1/global/later'];
    assert.deepEqual(homes, before.homes, 'the App Homes too (their mode 0755 back)');
    assert.deepEqual(snapshot(join(f.d, 'outside')), before.outside);
    assert.deepEqual(snapshot(f.priv), before.priv);
  } finally { rmSync(f.d, { recursive: true, force: true }); }
});

test('the flip back keeps what someone else chose since; without a journal it hands only the app\'s entries to root', { skip: process.getuid?.() !== 0 && 'needs root' }, async () => {
  const f = fixture();
  try {
    const up = await migrate(f, 'app');
    chownSync(join(f.data, 'a.txt'), 1000, 1000);                 // the owner took it on purpose
    const back = await migrate(f, 'root', ownershipJournalPath(f.d, up.journal.split('/').pop()));
    assert.equal(owner(join(f.data, 'a.txt')), '1000:1000', 'an owner changed since keeps it');
    assert.ok(back.restored.skipped >= 1);
    assert.equal(owner(join(f.data, 'sub', 'b.db')), '0:0');
    // A flip to app recorded before migrations had journals: the flip back still works (no exact restore).
    const up2 = await migrate(f, 'app');
    assert.equal(up2.plan.restore, null);
    const back2 = await migrate(f, 'root', null);
    assert.equal(back2.plan.restore, null);
    assert.equal(owner(join(f.data, 'sub', 'b.db')), '0:0');
    assert.equal(owner(join(f.data, 'pg')), `${SIDECAR}:${SIDECAR}`);
  } finally { rmSync(f.d, { recursive: true, force: true }); }
});

test('an interrupted apply is restored exactly from its journal (the recovery); lines outside the rows or through a link are skipped', { skip: process.getuid?.() !== 0 && 'needs root' }, async () => {
  const f = fixture();
  try {
    const before = snapshot(f.data);
    const beforeHomes = snapshot(join(f.d, 'aura', 'apphomes'));
    const { plan, apply } = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    // Interrupted: only the first row was applied before the process died.
    const journal = newOwnershipJournal(f.d, plan.digest);
    applyOwnershipRequest({ rows: apply.rows.filter((r) => r.kind === 'app-data') }, journal);
    assert.equal(owner(join(f.data, 'a.txt')), '200017:200017');
    // A tampered journal: a line outside the rows, one through a link.
    appendFileSync(journal, `${JSON.stringify({ path: join(f.d, 'outside'), uid: 4242, gid: 4242, mode: 0o777 })}\n`);
    mkdirSync(join(f.d, 'elsewhere'));
    writeFileSync(join(f.d, 'elsewhere', 'x'), 'x', { mode: 0o600 });
    symlinkSync(join(f.d, 'elsewhere'), join(f.data, 'sneaky'));
    appendFileSync(journal, `${JSON.stringify({ path: join(f.data, 'sneaky', 'x'), uid: 4242, gid: 4242, mode: 0o777 })}\n`);
    const within = runAsOwnershipPaths(input(f, 'app'));
    const r = restoreJournalEntries({ journal, within, owner: null });
    assert.ok(r.skipped.some((s) => s.includes('outside the rows')));
    assert.ok(r.skipped.some((s) => s.includes('goes through a link')));
    assert.equal(owner(join(f.d, 'outside')), '0:0');
    assert.equal(owner(join(f.d, 'elsewhere', 'x')), '0:0');
    rmSync(join(f.data, 'sneaky'));
    assert.deepEqual(snapshot(f.data), before, 'everything the interrupted apply changed is back');
    assert.deepEqual(snapshot(join(f.d, 'aura', 'apphomes')), beforeHomes);
  } finally { rmSync(f.d, { recursive: true, force: true }); }
});

test('the plan (D5): written data keeps the digest, a row root\'s mode or identity changes it; same identity both ways is refused; a pending migration blocks the start', async () => {
  const f = fixture();
  try {
    const a = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    writeFileSync(join(f.data, 'more'), 'more');
    appendFileSync(join(f.data, 'a.txt'), 'more bytes');
    const b = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    assert.equal(b.plan.digest, a.plan.digest, 'ordinary data the app wrote keeps the digest');
    assert.notDeepEqual(b.plan.rows.map((r) => r.files), a.plan.rows.map((r) => r.files), 'the counts stay in the plan');
    chmodSync(f.data, 0o777);
    const c = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    assert.notEqual(c.plan.digest, a.plan.digest, 'a row root\'s mode changes it');
    chmodSync(f.data, 0o750);
    assert.equal((await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) })).plan.digest, a.plan.digest);
    renameSync(f.home, `${f.home}.old`);
    mkdirSync(f.home, { mode: 0o755 });
    chmodSync(f.home, 0o755);
    assert.notEqual((await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) })).plan.digest, a.plan.digest, 'a replaced row root (another inode) changes it');
    await assert.rejects(runAsOwnershipPlan({ ...input(f, 'app'), from: APP }, { refuseRoots: refuseRoots(f) }), /from root to an app identity or back/);
    assert.equal(runAsMigrationBlock('org.t.app', {}), null);
    assert.match(runAsMigrationBlock('org.t.app', { runAsMigration: { to: 'app', digest: 'a'.repeat(64), journal: 'j.ndjson', startedAt: 0 } }),
      /did not finish.*not started.*aura admin apps run-as org\.t\.app --recover/);
  } finally { rmSync(f.d, { recursive: true, force: true }); }
});

test('the apply (D5): data written after the dry run applies with its digest; a row root chmodded, chowned or replaced by a link refuses before any change', { skip: process.getuid?.() !== 0 && 'needs root' }, async () => {
  const f = fixture();
  try {
    const before = snapshot(f.data);
    let { plan, apply } = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    // A chmod of a row root after the review: refused with its reason, nothing changed, no journal.
    chmodSync(f.data, 0o777);
    await assert.rejects(runOwnershipApply(f.d, plan.digest, apply.rows), (err) => err.code === 'changed' && /its mode changed \(0750 → 0777\)/.test(err.message));
    chmodSync(f.data, 0o750);
    assert.deepEqual(snapshot(f.data), before, 'nothing changed');
    // A chown of a row root: refused.
    chownSync(f.data, SIDECAR, SIDECAR);
    await assert.rejects(runOwnershipApply(f.d, plan.digest, apply.rows), (err) => err.code === 'changed' && /its owner changed \(0:0 → 999:999\)/.test(err.message));
    chownSync(f.data, 0, 0);
    // A row root replaced by a link to elsewhere: refused.
    renameSync(f.home, `${f.home}.real`);
    symlinkSync(`${f.home}.real`, f.home);
    await assert.rejects(runOwnershipApply(f.d, plan.digest, apply.rows), (err) => err.code === 'changed' && /became a symbolic link/.test(err.message));
    rmSync(f.home);
    renameSync(`${f.home}.real`, f.home);
    // Ordinary data written meanwhile: the same digest, and the apply proceeds (the new file too).
    writeFileSync(join(f.data, 'written-later'), 'later', { mode: 0o600 });
    const again = await runAsOwnershipPlan(input(f, 'app'), { refuseRoots: refuseRoots(f) });
    assert.equal(again.plan.digest, plan.digest);
    ({ plan, apply } = again);
    const r = await runOwnershipApply(f.d, plan.digest, apply.rows);
    assert.ok(r.rows.some((x) => x.changed > 0));
    assert.equal(owner(join(f.data, 'written-later')), '200017:200017');
  } finally { rmSync(f.d, { recursive: true, force: true }); }
});
