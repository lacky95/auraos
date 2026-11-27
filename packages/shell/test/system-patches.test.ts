// Phase 7b (D68): `/api/admin/system-patches` (lib/systemPatches.ts) with the real
// engine and git, fake auth, mounts and builder: Developer Mode answers with
// the workflow; an install without a release refuses; drafting binds the
// workspace into the caller's Terminal (members refused); save audits; the
// activation needs a finished validation of the running release, binds the
// exact revision, builds with the approved digest and, without Phase 6 U's
// activator, audits that the release is built but not activated. The running
// release is never described as signed when locally modified (D71).
//
//   node tools/run-tests.mjs --only=shell
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import {
  DEVELOPER_MODE_ANSWER, getSystemPatches, postSystemPatches, provenanceLine, type SystemPatchDeps,
} from '../src/lib/systemPatches.ts';

const data = mkdtempSync(join(tmpdir(), 'aura-sp-route-'));
process.env['AURA_DATA_DIR'] = data;
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', ...a], { encoding: 'utf8' }).trim();
let commit = '';
const RID = '0.1.0-abcdef123456-0000aaaa';
const INPUTS = { lockfileHash: 'sha256:aa', packageManager: 'pnpm@12.18.0', node: { base: 'v22.23.5', shell: 'v22.23.5' }, images: { base: 'sha256:b', shell: 'sha256:s' }, rebuildsImage: false, from: {} };

before(() => {
  const src = mkdtempSync(join(tmpdir(), 'aura-sp-src-'));
  git(src, 'init', '-q', '-b', 'main');
  mkdirSync(join(src, 'packages/core/src/probe'), { recursive: true });
  writeFileSync(join(src, 'packages/core/src/probe/probe.ts'), 'export const PROBE = "upstream";\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'release');
  commit = git(src, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--bare', src, join(data, 'aura/release/mirror.git')]);
  mkdirSync(join(data, 'releases', RID), { recursive: true });
  writeFileSync(join(data, 'releases', RID, '.complete'), 'x\n');
  writeFileSync(join(data, 'releases', RID, 'release.json'), JSON.stringify({
    id: RID, version: '0.1.0', commit, channel: 'signed', composition: 'desktop', provenance: 'upstream-signed', series: { digest: 'sha256:e', order: [] },
  }));
  writeFileSync(join(data, 'aura/release/pointer.json'), JSON.stringify({ v: 1, current: RID, previous: null }));
});

type P = Awaited<ReturnType<SystemPatchDeps['authenticate']>>;
const TERMINAL = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', verification: 'verified', userId: core.DEFAULT_OWNER_ID } as unknown as P;
const MEMBER = { kind: 'user', userId: 'm1', role: 'member', sessionId: 's', verification: 'verified' } as unknown as P;
const OPERATOR = { kind: 'operator', verification: 'verified' } as unknown as P;

function deps(o: { mode?: 'developer' | 'normal'; who?: P } = {}) {
  const audits: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const builds: core.systemPatches.BuilderInput[] = [];
  const mounts = new Map<string, core.AuraMount[]>();
  const who = () => o.who ?? TERMINAL;
  const d: SystemPatchDeps = {
    dataDir: data, auraRoot: '/workspace', mode: () => o.mode ?? 'normal',
    authenticate: async () => who(),
    owner: { approvals: {} as never, authenticate: async () => who(), shellOwner: async () => ({ identity: {} }) },
    engine: core.systemPatches,
    dataVolume: () => 'test_aura-app-data',
    mounts: {
      list: (i) => mounts.get(i) ?? [],
      add: async (i, s) => {
        const m = { id: `${s.targetAppId}:work`, instanceId: i, targetAppId: s.targetAppId, kind: 'work', mode: 'rw', containerPath: '/mnt/aura/work/system', workspace: s.workspace } as unknown as core.AuraMount;
        mounts.set(i, [...(mounts.get(i) ?? []), m]);
        return m;
      },
      remove: async (i, id) => { mounts.set(i, (mounts.get(i) ?? []).filter((m) => m.id !== id)); },
    },
    runBuilder: async (i) => { builds.push(i); return { code: 0, result: { ok: true, id: RID } }; },
    activator: null,
    audit: async (_a, action, opts) => { audits.push({ action, ...(opts.detail ? { detail: opts.detail } : {}) }); },
    notify: async () => {},
  };
  return { d, audits, builds, mounts };
}

const req = (body?: unknown, q = '') => ({
  request: new Request(`http://x/api/admin/system-patches${q}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  cookies: {} as never,
});

test('Developer Mode: every action answers 409 with the workflow; status still answers', async () => {
  const { d } = deps({ mode: 'developer' });
  const r = await postSystemPatches(req({ action: 'start' }), d);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'developer-mode', message: DEVELOPER_MODE_ANSWER });
  const s = await (await getSystemPatches(req(), d)).json();
  assert.equal(s.available, false);
  assert.equal(s.mode, 'developer');
});

test('start binds a workspace into the calling Terminal; a member is refused; save records a revision and audits', async () => {
  const member = await postSystemPatches(req({ action: 'start' }), deps({ who: MEMBER }).d);
  assert.equal(member.status, 403);
  const { d, audits, mounts } = deps();
  const r = await postSystemPatches(req({ action: 'start' }), d);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.path, '/mnt/aura/work/system');
  assert.equal(body.base.commit, commit);
  const m = mounts.get('com.aura.terminal-1')![0]!;
  assert.equal(m.targetAppId, core.SYSTEM_WORK_TARGET);
  assert.equal(m.workspace, `aura/workspaces/${core.DEFAULT_OWNER_ID}/system/1`);
  const ws = join(data, m.workspace!);
  writeFileSync(join(ws, 'packages/core/src/probe/probe.ts'), 'export const PROBE = "patched";\n');
  git(ws, 'commit', '-qam', 'probe: patched');
  const saved = await (await postSystemPatches(req({ action: 'save', message: 'first' }), d)).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.changed, true);
  assert.equal(audits[0]!.action, 'patch.saved');
  const diff = await (await getSystemPatches(req(undefined, '?diff=HEAD'), d)).json();
  assert.match(diff.diff, /\+export const PROBE = "patched";/);
});

test('activate: only a finished validation of the running release; the approved build is bound; no activator yet (Phase 6 U)', async () => {
  const { d, audits, builds } = deps({ who: OPERATOR });
  assert.equal((await postSystemPatches(req({ action: 'activate', job: '2026-01-01T00-00-00-000Z' }), d)).status, 404);
  const v = await (await postSystemPatches(req({ action: 'validate' }), d)).json();
  assert.equal(builds[0]!.validateOnly, true);
  const rev = v.rev as string;
  const view = core.systemPatches.seriesView(data, rev);
  const digest = core.seriesDigest({ target: { kind: 'system' }, base: { commit }, patches: view.patches });
  const job = (phase: string, extra = {}) => {
    mkdirSync(join(data, 'aura/release/jobs'), { recursive: true });
    writeFileSync(join(data, 'aura/release/jobs', `${v.job}.json`), JSON.stringify({
      phase, validated: { id: RID, commit, version: '0.1.0', provenance: 'locally-modified', composition: 'desktop',
        series: { digest: `sha256:${digest}`, rev, base: { commit, version: '0.1.0' }, order: [], touched: [{ component: 'core', kind: 'package', modules: ['probe'], built: true, deployed: true }], rebuildsImage: false, imageFiles: [] },
        inputs: INPUTS, ...extra },
    }));
  };
  job('running');
  assert.equal((await postSystemPatches(req({ action: 'activate', job: v.job }), d)).status, 409);
  job('validated', { composition: 'server' });
  assert.equal((await (await postSystemPatches(req({ action: 'activate', job: v.job }), d)).json()).error, 'stale-validation');
  job('validated');
  const a = await postSystemPatches(req({ action: 'activate', job: v.job }), d);
  assert.equal(a.status, 202);
  const ab = await a.json();
  assert.equal(ab.approved, 1);
  await new Promise((r) => setTimeout(r, 20));
  const full = builds[1]!;
  assert.equal(full.validateOnly, undefined);
  assert.equal(full.expectSeriesDigest, `sha256:${digest}`);
  assert.equal(full.rev, rev);
  // The approved build gets the APPROVED inputs to resolve again (owner 2026-11-27).
  assert.deepEqual(JSON.parse(readFileSync(full.expectInputsFile!, 'utf8')), INPUTS);
  const failed = audits.find((x) => x.action === 'patch.activation-failed');
  assert.match(String(failed?.detail?.['reason']), /Phase 6 U/);
  assert.equal(core.systemPatches.storeRef(data, core.systemPatches.ACTIVE_REF), null, 'refs/aura/active moves only after an activation');
});

test('D71: a locally modified release is never described as signed', () => {
  const line = provenanceLine({ id: RID, version: '0.1.0', commit, channel: 'signed', composition: 'desktop', provenance: 'locally-modified',
    series: { digest: 'sha256:abcdef0123', order: [{}, {}] }, basedOn: { version: '0.1.0', signed: true } });
  assert.equal(line, 'AuraOS 0.1.0, locally modified (2 system patches, series abcdef0), based on signed 0.1.0');
  assert.equal(provenanceLine({ id: RID, version: '0.1.0', commit, channel: 'signed', composition: 'desktop', provenance: 'upstream-signed' }), 'AuraOS 0.1.0 (signed release)');
});
