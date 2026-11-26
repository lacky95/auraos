// D64: the security options registry (core security/options.ts) and its
// route `/api/admin/security-options` (lib/securityOptions.ts), with the
// real `ownerAction`: Settings and the CLI need the owner's `fresh` approval
// (the password), the host operator acts directly, `env` options are set on
// the host. And the sealed store: a tampered record means the defaults.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult, AuditInput } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';
import { getSecurityOptions, putSecurityOption, type SecurityOptionsDeps } from '../src/lib/securityOptions.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { accessMode } from '../server/access-mode.mjs';
import { hostPolicy, desktopHosts } from '../server/host-policy.mjs';

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

/** A Valkey with just what the store uses: get, set NX, compare-and-set. */
function memoryRedis() {
  const data = new Map<string, string>();
  return {
    data,
    redis: {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string, nx?: string) => {
        if (nx === 'NX' && data.has(k)) return null;
        data.set(k, v);
        return 'OK';
      },
      eval: async (_script: string, _n: number, k: string, expected: string, next: string) => {
        if (data.get(k) !== expected) return 0;
        data.set(k, next);
        return 1;
      },
    },
  };
}

const SETTINGS: CallerPrincipal = {
  kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified',
  through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' },
} as CallerPrincipal;
const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'default', verification: 'verified' };
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const FRESH_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };
const CLICK_OWNER: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: false };

let approvals: MemoryApprovals;
let kv: ReturnType<typeof memoryRedis>;
let store: core.SecurityPolicyStore;
let tampered: number;
let caller: CallerPrincipal;
let audits: Array<{ action: string; opts: unknown }>;
let env: Record<string, string | undefined>;
const keyFile = join(mkdtempSync(join(tmpdir(), 'sec-opt-')), 'identity.key');

function ownerDeps(): OwnerActionDeps {
  return {
    approvals: {
      store: approvals as never,
      appName: (id) => (id === 'com.aura.terminal' ? 'Terminal' : id === 'com.aura.settings' ? 'Settings' : null),
      audit: async (_e: AuditInput) => { /* approvals' own audit */ },
      tickets: { peek: async () => null, claim: async () => null },
    },
    authenticate: async () => caller,
    shellOwner: async () => ({ identity: {} }),
  };
}

function deps(): SecurityOptionsDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req, ownerDeps()),
    store,
    audit: async (_actor, action, opts) => { audits.push({ action, opts }); },
    env,
  };
}

beforeEach(() => {
  approvals = new MemoryApprovals();
  kv = memoryRedis();
  tampered = 0;
  store = new core.SecurityPolicyStore({ identityKeyFile: keyFile, redis: () => kv.redis as never, onTampered: () => { tampered += 1; } });
  caller = SETTINGS;
  audits = [];
  env = {};
});

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
  request: new Request('http://shell.test/api/admin/security-options', {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }),
  cookies: {} as never,
});
const read = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> });
const option = (list: any[], id: string) => list.find((o) => o.id === id);

// ── the registry ────────────────────────────────────────────────────────────

test('registry: every option has a title, a description, a source and the fresh change level', () => {
  const ids = new Set<string>();
  for (const o of core.SECURITY_OPTIONS) {
    assert.ok(!ids.has(o.id), `unique id ${o.id}`);
    ids.add(o.id);
    assert.ok(o.title.length > 3 && o.description.length > 20, `${o.id} explains itself`);
    assert.ok(['policy', 'env', 'record', 'file', 'reserved'].includes(o.source), o.id);
    // Every security option needs the password; the shell mode's switch is one click (D57).
    assert.equal(o.change, o.id === 'shell-mode' ? 'session' : 'fresh', `${o.id}: the change level`);
    // The one file option without a host variable: the 5-main deploy window, which an env value would
    // keep open past its 6 hours (stream T); it is read from its root-owned switch file only.
    if (o.source === 'env' || (o.source === 'file' && o.id !== 'terminal-root-transition')) assert.match(o.env ?? '', /^AURA_[A-Z_]+$/);
    if (o.id === 'terminal-root-transition') assert.equal(o.env, undefined, 'no host variable opens the deploy window');
    if (o.source === 'file') assert.match(o.file ?? '', /^aura\/[a-z-]+$/);
    if (o.type === 'enum') assert.ok(o.values?.includes(o.default as string), `${o.id}: default is a value`);
  }
  assert.equal(core.securityOption(core.FRESH_AUTH_REQUIRE_HTTPS)?.default, false, 'D63: off by default');
  assert.deepEqual([...core.POLICY_OPTION_IDS], [core.FRESH_AUTH_REQUIRE_HTTPS, core.APP_ROOT_EXECUTION_OPTION, core.AURA_ROOT_OPTION],
    'J.6: aura-root became a policy option; 5-main item 3: app-root-execution');
  assert.equal(core.securityOption('access-profile')?.source, 'reserved');
  assert.equal(core.securityOption('password-policy')?.record, core.PASSWORD_POLICY_KEY);
});

test('registry: env values parse as their read points do', () => {
  for (const raw of [undefined, '', 'off', 'report', 'enforce', ' ENFORCE ', 'bogus']) {
    const e = { AURA_ACCESS_ENFORCE: raw };
    const saved = process.env['AURA_ACCESS_ENFORCE'];
    if (raw === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = raw;
    try {
      assert.equal(core.securityEnvValue('access-enforce', e), accessMode(), `access-enforce ${raw}`);
    } finally {
      if (saved === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = saved;
    }
  }
  for (const raw of [undefined, 'enforce', 'report', 'bogus']) {
    assert.equal(core.securityEnvValue('host-policy', { AURA_HOST_POLICY: raw }), hostPolicy({ AURA_HOST_POLICY: raw }), `host-policy ${raw}`);
  }
  const hosts = 'Box.Example.com, other.example.org';
  assert.deepEqual(core.securityEnvValue('desktop-hosts', { AURA_DESKTOP_HOSTS: hosts }), [...desktopHosts({ AURA_DESKTOP_HOSTS: hosts })]);
  for (const raw of [undefined, 'warn', 'strict', 'STRICT', 'bogus']) {
    assert.equal(core.securityEnvValue('lifecycle-strict', { AURA_LIFECYCLE_STRICT: raw }), raw?.toLowerCase() === 'strict' ? 'strict' : 'warn');
  }
});

test('registry: env wins, then the policy record, then the default; sources say which', () => {
  const list = core.resolveSecurityOptions({ [core.FRESH_AUTH_REQUIRE_HTTPS]: true }, { AURA_ACCESS_ENFORCE: 'enforce', AURA_HOST_POLICY: 'bogus' });
  assert.deepEqual([option(list, 'fresh-auth-require-https').value, option(list, 'fresh-auth-require-https').effectiveSource], [true, 'policy']);
  assert.deepEqual([option(list, 'access-enforce').value, option(list, 'access-enforce').effectiveSource], ['enforce', 'env AURA_ACCESS_ENFORCE']);
  assert.deepEqual([option(list, 'host-policy').value, option(list, 'host-policy').invalidEnv], ['enforce', true]);
  assert.equal(option(list, 'lifecycle-strict').effectiveSource, 'default');
  assert.equal(option(list, 'password-policy').effectiveSource, 'record user:policy:password');
  assert.equal(option(list, 'access-profile').effectiveSource, 'reserved');
  assert.deepEqual(list.filter((o) => o.writable).map((o) => o.id), ['fresh-auth-require-https', 'app-root-execution', 'aura-root']);
  assert.deepEqual([option(list, 'aura-root').value, option(list, 'aura-root').effectiveSource], ['enabled', 'default']);
  assert.equal(option(core.resolveSecurityOptions({}, {}), 'fresh-auth-require-https').value, false);
});

test('registry: a file option reads its switch file; the host variable wins; garbage is the default', () => {
  const files: Record<string, string> = { 'aura/system-mode': 'normal\n', 'aura/shell-mode': 'bogus' };
  const read = (f: string) => files[f] ?? null;
  const list = core.resolveSecurityOptions({}, {}, read);
  assert.deepEqual([option(list, 'system-mode').value, option(list, 'system-mode').effectiveSource], ['normal', 'file /data/aura/system-mode']);
  assert.deepEqual([option(list, 'shell-mode').value, option(list, 'shell-mode').effectiveSource], ['dev', 'default']);
  const env = core.resolveSecurityOptions({}, { AURA_SYSTEM_MODE: 'developer', AURA_SHELL_MODE: 'prod' }, read);
  assert.deepEqual([option(env, 'system-mode').value, option(env, 'system-mode').effectiveSource], ['developer', 'env AURA_SYSTEM_MODE']);
  assert.deepEqual([option(env, 'shell-mode').value, option(env, 'shell-mode').effectiveSource], ['prod', 'env AURA_SHELL_MODE']);
  assert.deepEqual([option(core.resolveSecurityOptions({}, {}, () => null), 'system-mode').value], ['developer']);
  assert.equal(option(list, 'system-mode').writable, false);
});

// ── the sealed store ────────────────────────────────────────────────────────

test('store: sealed in the private user: namespace; a tampered record means the defaults, reported once', async () => {
  assert.deepEqual(await store.get(), {});
  assert.deepEqual(await store.set(core.FRESH_AUTH_REQUIRE_HTTPS, true), { ok: true, changed: true, previous: false, value: true });
  assert.match(core.SECURITY_POLICY_KEY, /^user:/);
  assert.deepEqual(await store.get(), { [core.FRESH_AUTH_REQUIRE_HTTPS]: true });
  assert.deepEqual(await store.set(core.FRESH_AUTH_REQUIRE_HTTPS, 'on'), { ok: true, changed: false, previous: true, value: true });

  // A Valkey writer flips the value but cannot re-seal it.
  const raw = JSON.parse(kv.data.get(core.SECURITY_POLICY_KEY)!);
  raw.values[core.FRESH_AUTH_REQUIRE_HTTPS] = false;
  kv.data.set(core.SECURITY_POLICY_KEY, JSON.stringify(raw));
  assert.deepEqual(await store.get(), {}, 'the defaults');
  assert.deepEqual(await store.get(), {});
  assert.equal(tampered, 1, 'reported once');
  kv.data.set(core.SECURITY_POLICY_KEY, JSON.stringify({ v: 1, values: { 'access-enforce': 'off' }, mac: raw.mac }));
  assert.deepEqual(await store.get(), {}, 'an env option is never stored');
  assert.equal(tampered, 2);

  await assert.rejects(store.set('access-enforce', 'off'), /not stored by AuraOS/);
  await assert.rejects(store.set('nope', true), /unknown security option/);
  await assert.rejects(store.set(core.FRESH_AUTH_REQUIRE_HTTPS, 'maybe'), /invalid value/);
  // The owner's write re-seals over the tampered record.
  assert.equal((await store.set(core.FRESH_AUTH_REQUIRE_HTTPS, true)).ok, true);
  assert.deepEqual(await store.get(), { [core.FRESH_AUTH_REQUIRE_HTTPS]: true });
});

test('store: a concurrent change is never overwritten', async () => {
  await store.set(core.FRESH_AUTH_REQUIRE_HTTPS, true);
  const get = kv.redis.get;
  kv.redis.get = async (k: string) => { const v = await get(k); kv.data.set(k, `${v} `); return v; };
  assert.deepEqual(await store.set(core.FRESH_AUTH_REQUIRE_HTTPS, false), { ok: false, reason: 'conflict' });
});

// ── the route ───────────────────────────────────────────────────────────────

test('route: GET lists every option with its effective value, for Settings directly', async () => {
  env = { AURA_ACCESS_ENFORCE: 'enforce', AURA_LIFECYCLE_STRICT: 'strict' };
  const r = await read(await getSecurityOptions(req('GET'), deps()));
  assert.equal(r.status, 200);
  assert.equal(r.body.options.length, core.SECURITY_OPTIONS.length);
  assert.equal(option(r.body.options, 'access-enforce').value, 'enforce');
  assert.equal(option(r.body.options, 'lifecycle-strict').value, 'strict');
  assert.equal(option(r.body.options, 'fresh-auth-require-https').value, false);
  assert.equal(approvals.records.size, 0, 'a read asks nobody');
});

test('route: a change from Settings needs the owner\'s fresh approval (the password), in either direction', async () => {
  for (const value of [true, false]) {
    const first = await read(await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value }), deps()));
    assert.equal(first.status, 202);
    assert.equal(first.body.level, 'fresh');
    assert.match(first.body.display.title, /Require HTTPS for password confirmations: (off → on|on → off)/);
    const id = first.body.approvalId as string;
    // A one-click approval does not satisfy a fresh request.
    assert.equal((await approvals.approve(id, CLICK_OWNER)).ok, false);
    assert.equal((await approvals.approve(id, FRESH_OWNER)).ok, true);
    const done = await read(await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value }, { 'x-aura-approval': id }), deps()));
    assert.equal(done.status, 200);
    assert.equal(done.body.option.value, value);
    assert.equal(done.body.option.effectiveSource, 'policy');
    assert.deepEqual(audits.at(-1), { action: 'security.option-changed', opts: { target: 'security:fresh-auth-require-https', detail: { from: !value, to: value } } });
  }
  // The approval binds the value: approving "on" never sets "off".
  const ask = await read(await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: true }), deps()));
  await approvals.approve(ask.body.approvalId, FRESH_OWNER);
  const other = await read(await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: 'off' }, { 'x-aura-approval': ask.body.approvalId }), deps()));
  assert.notEqual(other.status, 200);
});

test('route: the System Terminal asks too; the host operator acts directly', async () => {
  caller = TERMINAL;
  assert.equal((await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: true }), deps())).status, 202);
  caller = OPERATOR;
  const op = await read(await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: true }), deps()));
  assert.deepEqual([op.status, op.body.option.value], [200, true]);
});

test('route: env, record and reserved options are not written here; bad input is refused before asking', async () => {
  caller = OPERATOR;
  const env409 = await read(await putSecurityOption(req('PUT', { id: 'access-enforce', value: 'enforce' }), deps()));
  assert.deepEqual([env409.status, env409.body.error], [409, 'set-on-host']);
  assert.match(env409.body.message, /AURA_ACCESS_ENFORCE in compose\/\.env, then restart/);
  assert.equal((await putSecurityOption(req('PUT', { id: 'password-policy', value: true }), deps())).status, 409);
  assert.equal((await putSecurityOption(req('PUT', { id: 'access-profile', value: 'zero-trust' }), deps())).status, 409);
  assert.equal((await putSecurityOption(req('PUT', { id: 'nope', value: true }), deps())).status, 404);
  assert.equal((await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: 'maybe' }), deps())).status, 400);
  caller = SETTINGS;
  await putSecurityOption(req('PUT', { id: core.FRESH_AUTH_REQUIRE_HTTPS, value: 'maybe' }), deps());
  assert.equal(approvals.records.size, 0, 'no approval for an invalid change');
});

test('route: an owner route in the access manifest, the System Terminal its only app', () => {
  const methods = ROUTE_ACCESS_MANIFEST.routes['/api/admin/security-options']?.methods;
  for (const m of ['GET', 'PUT'] as const) {
    assert.deepEqual(methods?.[m]?.allow, ['own-instance', 'owner']);
    assert.equal(methods?.[m]?.systemApp, 'com.aura.terminal');
  }
});

test('docs: the Security options page lists every option with its default and source', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../../apps/com.aura.docs/fumadocs-site/content/docs/security-options.mdx', import.meta.url), 'utf8');
  const rows = new Map(page.split('\n').filter((l) => l.startsWith('| `')).map((l) => {
    const cells = l.split('|').map((c) => c.trim());
    return [cells[1]!.replace(/`/g, ''), { def: cells[2]!, source: cells[3]! }];
  }));
  assert.deepEqual([...rows.keys()], core.SECURITY_OPTIONS.map((o) => o.id), 'the same options, in the same order');
  const shown = (v: unknown) => (v === false ? 'off' : v === true ? 'on' : Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v));
  for (const o of core.SECURITY_OPTIONS) {
    const row = rows.get(o.id)!;
    assert.ok(row.source.startsWith(o.source), `${o.id}: source ${o.source}`);
    if (o.env) assert.ok(row.source.includes(o.env), `${o.id}: names ${o.env}`);
    if (o.source !== 'record') assert.equal(row.def, shown(o.default), `${o.id}: default`);
  }
});
