// SF-1 (D94 G8): `POST /api/admin/base-install` (lib/baseInstall.ts) runs apt
// as root in the master. The body may only name Debian packages, passed as
// argv (no shell, no option, no source); apt verifies signatures with no
// insecure fallback; the owner approves (the server's built-in list one
// click, any other list the password), bound to the operation and the
// normalized list, with the real `ownerAction`; every run is audited
// (requester, approver, list, result).
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import {
  APT_VERIFY_ARGS, BASE_ESSENTIALS, BASE_INSTALL_AUDIT_ACTION, baseInstallLevel, liveBaseInstallDeps, parsePackages, postBaseInstall,
  type BaseInstallDeps,
} from '../src/lib/baseInstall.ts';

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
const SETTINGS: CallerPrincipal = { ...OWNER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as CallerPrincipal;
const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'default', verification: 'verified' };
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const FRESH_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };
const CLICK_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };

let approvals: MemoryApprovals;
let caller: CallerPrincipal;
let runs: Array<{ file: string; args: readonly string[] }>;
let audits: Array<{ action: string; opts: any; actor: any }>;
const audit = (i = 0) => audits[i] as { action: string; opts: any; actor: any };
const argsOf = (i: number) => (runs[i] as { args: readonly string[] }).args;
let failWith: string | null;
let devices: string[];
let devicesFail: string | null;

function deps(): BaseInstallDeps {
  const owner: OwnerActionDeps = {
    approvals: {
      store: approvals as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : id === 'com.aura.settings' ? 'Settings' : null),
      audit: async () => { /* approvals' own audit */ },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, owner),
    audit: async (actor, action, opts) => { audits.push({ action, opts, actor }); },
    run: (file, args) => {
      runs.push({ file, args });
      if (failWith) throw new Error(failWith);
      return `ran ${args[2]}`;
    },
    stageResolvConf: () => true,
    ensureDevices: (root) => {
      devices.push(root);
      if (devicesFail) throw new Error(devicesFail);
      return [];
    },
    exists: () => true,
    baseRootfs: '/os/base-rootfs',
  };
}

beforeEach(() => {
  approvals = new MemoryApprovals();
  caller = OWNER;
  runs = [];
  audits = [];
  failWith = null;
  devices = [];
  devicesFail = null;
});

const post = (body?: unknown, headers: Record<string, string> = {}) => ({
  request: new Request('http://shell.test/api/admin/base-install', {
    method: 'POST',
    headers: { authorization: 'Bearer aura-sess1.x', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }),
  cookies: {} as never,
});
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });

const SORTED = [...BASE_ESSENTIALS].sort();
const UPDATE = ['/os/base-rootfs', 'apt-get', ...APT_VERIFY_ARGS, 'update', '-qq'];
const INSTALL = (pkgs: readonly string[]) => ['/os/base-rootfs', 'apt-get', ...APT_VERIFY_ARGS, 'install', '-y', '-q', '--no-install-recommends', '--', ...pkgs];
const INSECURE = /allow-unauthenticated|AllowInsecureRepositories=true|AllowDowngradeToInsecureRepositories=true|AllowUnauthenticated=true|AllowUnauthenticated "true"|trusted=yes|--force-yes|allow-insecure/i;

const refused = async (body: unknown) => {
  const r = await read(await postBaseInstall(post(body), deps()));
  return r.status === 400 && r.body.error === 'invalid-request';
};
const nothingHappened = () => {
  assert.equal(runs.length, 0, 'nothing ran');
  assert.equal(audits.length, 0, 'nothing to audit');
  assert.equal(approvals.records.size, 0, 'nobody was asked');
};

test('the owner in the desktop: the built-in list, as argv to chroot apt-get, signatures enforced, audited', async () => {
  const r = await read(await postBaseInstall(post(), deps()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.packages, SORTED);
  assert.deepEqual(runs, [{ file: 'chroot', args: UPDATE }, { file: 'chroot', args: INSTALL(SORTED) }]);
  assert.deepEqual(devices, ['/os/base-rootfs'], 'the chroot\'s /dev nodes are ensured once, before apt');
  for (const { args } of runs) assert.ok(!args.some((a) => INSECURE.test(a)), `no insecure apt flag in ${args.join(' ')}`);
  assert.equal(audits.length, 1);
  assert.equal(audit().action, BASE_INSTALL_AUDIT_ACTION);
  assert.equal(audit().opts.outcome, 'ok');
  assert.deepEqual(audit().opts.detail.packages, SORTED);
  assert.equal(approvals.records.size, 0, 'the owner in the desktop acts directly');

  // An empty list and an empty JSON object mean the built-in list too (as before).
  runs = [];
  assert.equal((await postBaseInstall(post({ packages: [] }), deps())).status, 200);
  assert.deepEqual(argsOf(1), INSTALL(SORTED));
});

test('command injection is refused before anyone is asked and before anything runs', async () => {
  for (const p of ['curl; id', 'nano && touch /pwned', '$(id)', '`id`', 'a|b', 'nano\nid', 'nano id', 'nano>out', "nano'", 'nano"', 'nano\\', 'nano\u0000id']) {
    assert.ok(await refused({ packages: ['less', p] }), `refused: ${JSON.stringify(p)}`);
  }
  for (const body of [{ packages: 'nano; id' }, { packages: [1] }, { packages: [null] }, { packages: [['nano']] }, { packages: { 0: 'nano' } }, ['nano'], 'nano', 'not json{']) {
    assert.ok(await refused(body), `refused body ${JSON.stringify(body)}`);
  }
  assert.ok(await refused({ packages: Array.from({ length: 65 }, (_, i) => `pkg${i}`) }), 'at most 64');
  nothingHappened();
});

test('argument injection is refused: options, versions, releases, architectures, remove modifiers', async () => {
  for (const p of ['-x', '-y', '--allow-unauthenticated', '--option=x', '-oAcquire::AllowInsecureRepositories=true', '-o', '--',
    'nano=1.0', 'nano=', '=nano', 'nano:amd64', 'nano/bookworm-backports', 'nano-', 'nano^', '?installed', '~nnano', 'nano*', 'Nano', 'x', '', 'a'.repeat(65)]) {
    assert.ok(await refused({ packages: [p] }), `refused: ${JSON.stringify(p)}`);
  }
  nothingHappened();
});

test('unauthorized package sources are refused: no paths, URLs, .deb files, sources or apt options', async () => {
  for (const p of ['/tmp/evil.deb', './evil.deb', 'evil.deb', 'evil.udeb', 'evil.dsc', '../etc/passwd', 'http://evil.example/x.deb', 'https://evil.example/',
    'deb http://evil.example/ bookworm main', 'file:/tmp/x', 'ppa:evil/x']) {
    assert.ok(await refused({ packages: [p] }), `refused: ${JSON.stringify(p)}`);
  }
  for (const extra of [{ sources: ['deb http://evil.example/ bookworm main'] }, { options: ['-oAPT::Get::AllowUnauthenticated=true'] },
    { repo: 'http://evil.example' }, { aptArgs: ['--allow-unauthenticated'] }]) {
    assert.ok(await refused({ packages: ['curl'], ...extra }), `refused ${Object.keys(extra)[0]}`);
  }
  nothingHappened();
});

test('the default list cannot be redefined or imitated to skip the password', async () => {
  // The request cannot say what "default" is.
  for (const tampered of [{ default: true, packages: ['curl'] }, { essentials: ['curl'] }, { packages: ['curl'], builtIn: true }, { level: 'session', packages: ['curl'] }]) {
    assert.ok(await refused(tampered), `refused ${JSON.stringify(tampered)}`);
  }
  nothingHappened();
  // A superset, a subset or a lookalike is another list: the password.
  assert.equal(baseInstallLevel([...BASE_ESSENTIALS, 'curl']), 'fresh');
  assert.equal(baseInstallLevel(BASE_ESSENTIALS.slice(1)), 'fresh');
  assert.equal(baseInstallLevel([...BASE_ESSENTIALS.slice(1), 'openssh-client.']), 'fresh');
  assert.ok('error' in parsePackages({ packages: [...BASE_ESSENTIALS.slice(1), 'openssh-client​'] }), 'a zero-width lookalike is no name');
  assert.ok('error' in parsePackages({ packages: [...BASE_ESSENTIALS.slice(1), 'Openssh-client'] }));
  // The same list in any order, or with a repeat, is the built-in list.
  assert.equal(baseInstallLevel([...BASE_ESSENTIALS].reverse()), 'session');
  assert.equal(baseInstallLevel([...BASE_ESSENTIALS, 'nano']), 'session');

  caller = SETTINGS;
  const superset = await read(await postBaseInstall(post({ packages: [...BASE_ESSENTIALS, 'curl'] }), deps()));
  assert.equal(superset.status, 202);
  assert.equal(superset.body.level, 'fresh');
  const reordered = await read(await postBaseInstall(post({ packages: [...BASE_ESSENTIALS].reverse() }), deps()));
  assert.equal(reordered.body.level, 'session');
  assert.equal(runs.length, 0);
});

test('valid Debian package names pass, normalized (deduplicated, sorted)', () => {
  for (const p of ['g++', 'libc6', 'python3.11', 'lib32stdc++6', 'xz-utils', 'ca-certificates', '0ad', 'libsigc++-2.0-0v5']) {
    assert.deepEqual(parsePackages({ packages: [p] }), { packages: [p] }, p);
  }
  assert.deepEqual(parsePackages({ packages: ['nano', 'curl', 'nano'] }), { packages: ['curl', 'nano'] });
});

test('through Settings (D45) or from the System Terminal: 202 needs-approval, nothing runs', async () => {
  for (const who of [SETTINGS, TERMINAL]) {
    caller = who;
    const r = await read(await postBaseInstall(post({ packages: ['curl'] }), deps()));
    assert.equal(r.status, 202);
    assert.equal(r.body.error, 'needs-approval');
    assert.equal(r.body.action, 'admin.change');
    assert.equal(r.body.level, 'fresh');
    assert.match(r.body.display.details.join('\n'), /Packages: curl/);
  }
  caller = SETTINGS;
  assert.equal((await read(await postBaseInstall(post(), deps()))).body.level, 'session', 'the built-in list: one click');
  assert.equal(runs.length, 0);
  assert.equal(audits.length, 0);
});

test('an authorized custom install: the password, then it runs once, audited with requester, approver, list and result', async () => {
  caller = TERMINAL;
  const first = await read(await postBaseInstall(post({ packages: ['wget', 'curl'] }), deps()));
  const id = first.body.approvalId as string;
  const record = approvals.records.get(id) as ApprovalRecord;
  assert.equal(record.level, 'fresh');
  assert.equal((await approvals.approve(id, CLICK_OWNER)).ok, false, 'one click is not enough (D9)');
  assert.equal((await approvals.approve(id, FRESH_OWNER)).ok, true);

  // The same list in another order is the same normalized list: the approval covers it.
  const done = await read(await postBaseInstall(post({ packages: ['curl', 'wget'] }, { 'x-aura-approval': id }), deps()));
  assert.equal(done.status, 200);
  assert.deepEqual(argsOf(1), INSTALL(['curl', 'wget']));
  assert.equal(audit().opts.outcome, 'ok');
  assert.deepEqual(audit().opts.detail.packages, ['curl', 'wget']);
  assert.equal(audit().opts.detail.level, 'fresh');
  // auditOwner records actor.by (the approver) with actor.detail (the requester, the approval) merged in.
  assert.deepEqual(audit().actor.by, { kind: 'user', userId: 'default', session: 'sess-des' }, 'the approver');
  assert.match(String(audit().actor.detail.requestedBy), /com\.aura\.terminal-1/, 'the requester');
  assert.equal(audit().actor.detail.approval, id);
  // The approval binds the operation and the normalized list.
  assert.equal(record.payloadHash, core.payloadHash({ operation: BASE_INSTALL_AUDIT_ACTION, packages: ['curl', 'wget'] }));
});

test('a mismatched or replayed approval is refused: another list, a subset, a superset, a second use', async () => {
  caller = TERMINAL;
  const first = await read(await postBaseInstall(post({ packages: ['curl', 'wget'] }), deps()));
  const id = first.body.approvalId as string;
  assert.equal((await approvals.approve(id, FRESH_OWNER)).ok, true);
  for (const other of [['wget'], ['curl'], ['curl', 'wget', 'nano'], ['curl', 'wget2']]) {
    const r = await postBaseInstall(post({ packages: other }, { 'x-aura-approval': id }), deps());
    assert.notEqual(r.status, 200, `not covered: ${other.join(',')}`);
  }
  assert.equal(runs.length, 0);
  assert.equal((await postBaseInstall(post({ packages: ['curl', 'wget'] }, { 'x-aura-approval': id }), deps())).status, 200);
  runs = [];
  const again = await postBaseInstall(post({ packages: ['curl', 'wget'] }, { 'x-aura-approval': id }), deps());
  assert.notEqual(again.status, 200, 'used up');
  assert.equal(runs.length, 0);
  // An approval for the built-in list does not cover a custom one either.
  const builtIn = await read(await postBaseInstall(post(), deps()));
  assert.equal((await approvals.approve(builtIn.body.approvalId as string, CLICK_OWNER)).ok, true);
  assert.notEqual((await postBaseInstall(post({ packages: ['curl'] }, { 'x-aura-approval': builtIn.body.approvalId }), deps())).status, 200);
  assert.equal(runs.length, 0);
});

test('the host operator acts directly', async () => {
  caller = OPERATOR;
  assert.equal((await postBaseInstall(post({ packages: ['curl'] }), deps())).status, 200);
  assert.equal(approvals.records.size, 0);
  assert.deepEqual(audit().opts.detail.packages, ['curl']);
});

test('a failed signature check fails the request with a diagnostic and an audit entry; there is no insecure retry', async () => {
  failWith = 'chroot /os/base-rootfs apt-get update -qq exited 100\nW: GPG error: http://deb.debian.org bookworm InRelease: NO_PUBKEY 0E98404D386FA1D9';
  const r = await read(await postBaseInstall(post(), deps()));
  assert.equal(r.status, 500);
  assert.match(r.body.hint, /never installs unverified packages/);
  assert.equal(runs.length, 1, 'stopped at the failed update, nothing retried');
  assert.equal(audit().opts.outcome, 'failed');
  assert.deepEqual(audit().opts.detail.packages, SORTED);
});

test('the chroot /dev nodes are ensured after the approval and before apt; a refusal fails closed, audited, nothing runs', async () => {
  caller = TERMINAL;
  const r = await read(await postBaseInstall(post({ packages: ['curl'] }), deps()));
  assert.equal(r.status, 202);
  assert.deepEqual(devices, [], 'nothing is touched before the owner decides');
  devicesFail = 'chroot devices: refusing /os/base-rootfs/dev/null: a symlink, not a device';
  caller = OWNER;
  const f = await read(await postBaseInstall(post(), deps()));
  assert.equal(f.status, 500);
  assert.match(f.body.error, /refusing .*a symlink/);
  assert.equal(runs.length, 0, 'apt never runs without the devices');
  assert.equal(audit().opts.outcome, 'failed');
});

test('no shell: the live runner passes argv to the program as is', () => {
  const out = liveBaseInstallDeps().run('echo', ['a;b', '$(id)', '`id`', '&&', 'x|y'], { timeoutMs: 5_000 });
  assert.equal(out, 'a;b $(id) `id` && x|y');
});

test('source: no shell string, no insecure apt flag, the route delegates to the gated handler', () => {
  const lib = readFileSync(new URL('../src/lib/baseInstall.ts', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/pages/api/admin/base-install.ts', import.meta.url), 'utf8');
  for (const src of [lib, route]) {
    assert.doesNotMatch(src, /\bexecSync\b|\bexec\(|\bexecFile\(|shell:\s*true|\/bin\/sh|bash -c/);
    assert.doesNotMatch(src, INSECURE);
  }
  assert.match(lib, /spawnSync\(file, \[\.\.\.args\], \{/);
  assert.match(route, /postBaseInstall\(ctx\)/);
  assert.doesNotMatch(route, /child_process/);
});
