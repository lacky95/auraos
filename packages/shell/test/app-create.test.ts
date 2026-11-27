// D109 AF2: creating an app is the owner's decision (`app.create`, forced).
// The facts come from the manifest the server writes, privileged declarations
// need the password, and the approval binds the files, summary and plan
// digests, the target and the requester, once (lib/approvals/appCreate.ts).
// AF4: input refusals carry the missing-input / invalid-input categories.
//
//   node tools/run-tests.mjs --only=shell
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { ApprovalClaim, ApprovalDecider, ApprovalRecord, ApprovalRequest, ApprovalResult } from '@aura/core';
import { ownerAction, type OwnerActionDeps } from '../src/lib/approvals/admin.ts';
import {
  checkCreateInputs, createLevel, createPayload, createRequest, duplicateFile, filesDigest, manifestFromDir, manifestFromFiles,
  treeDigest, type CreateFile, type CreateTarget,
} from '../src/lib/approvals/appCreate.ts';
import { EXPLANATION_MAX_BYTES } from '../src/lib/approvals/display.ts';
import type { CallerPrincipal } from '../src/lib/access/identify.ts';

const APP = 'com.example.notes';
const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({ id: APP, name: 'Notes', version: '0.1.0', ...over });
const files = (over: Record<string, unknown> = {}, extra: CreateFile[] = []): CreateFile[] => [
  { relPath: 'app.manifest.json', content: manifest(over) },
  { relPath: 'entrypoint.sh', content: '#!/bin/sh\nexec node server.mjs\n', mode: 0o755 },
  ...extra,
];
const parse = (f: CreateFile[]) => {
  const r = manifestFromFiles(f, APP);
  assert.ok(!('status' in r), JSON.stringify(r));
  return r.manifest;
};
const target = (f: CreateFile[], over: Partial<CreateTarget> = {}): CreateTarget => ({
  via: 'scaffold', appId: APP, scope: 'user', dest: `/data/scopes/users/default/apps/${APP}`, replaces: false,
  files: { digest: filesDigest(f), count: f.length, bytes: f.reduce((n, x) => n + x.content.length, 0) }, ...over,
});

// ── facts from the manifest that is written ─────────────────────────────────

test('the manifest is read from the files payload; missing, broken, invalid or another id is refused (AF4 categories)', () => {
  const missing = manifestFromFiles([{ relPath: 'README.md', content: 'x' }], APP);
  assert.ok('status' in missing);
  assert.deepEqual([missing.status, missing.body['error'], missing.body['category']], [422, 'missing-manifest', 'missing-input']);
  assert.deepEqual((missing.body['missing'] as unknown[])[0], { input: 'app.manifest.json', kind: 'file', expects: 'the app manifest at the app root' });
  for (const [content, why] of [['{not json', /not valid JSON/], [manifest({ version: 'one' }), /manifest schema/], [manifest({ id: 'com.other.app' }), /names the id com\.other\.app/]] as const) {
    const r = manifestFromFiles([{ relPath: 'app.manifest.json', content }], APP);
    assert.ok('status' in r);
    assert.equal(r.status, 422);
    assert.equal(r.body['error'], 'invalid-manifest');
    assert.equal(r.body['category'], 'invalid-input');
    assert.match(String(r.body['message']), why);
  }
  assert.equal(parse([{ relPath: './app.manifest.json', content: manifest() }]).id, APP, 'the landing path counts');
});

test('a second entry for the same file is caught: the server could otherwise read one manifest and write another', () => {
  assert.equal(duplicateFile(files()), null);
  const twice = files({}, [{ relPath: 'x/../app.manifest.json', content: manifest({ tools: ['docker'] }) }]);
  assert.equal(duplicateFile(twice), 'x/../app.manifest.json');
  assert.equal(duplicateFile([{ relPath: 'a', content: '' }, { relPath: './a', content: '' }]), './a');
});

test('the dialog shows the server\'s facts; a plain app is one click, app.create, forced', () => {
  const f = files({ tools: ['git'], permissions: ['system.notifications'], componentType: 'service', backgroundService: true });
  const req = createRequest(parse(f), target(f));
  assert.equal(req.action, 'app.create');
  assert.equal(req.level, 'session');
  assert.equal(core.approvalClassOf(req.action, req.payload), 'forced');
  assert.match(req.title, /^Create the app Notes \(com\.example\.notes\)$/);
  const d = req.details!.join('\n');
  for (const want of [/App: com\.example\.notes, "Notes" 0\.1\.0/, /Scope: user, written to \/data\/scopes\/users\/default\/apps\/com\.example\.notes/,
    /Shape: a service \(no window\), keeps running in the background/, /Tools it declares: git/, /Permissions it declares: system\.notifications/,
    /Files: 2 \(/, /installs its dependencies/, /Approving grants it what it declares above and nothing else/]) {
    assert.match(d, want);
  }
  assert.equal(req.highRisk, undefined);
});

test('privileged declarations need the password (fresh) and are named: docker, every tool, a sidecar\'s docker, privileged sidecars', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ tools: ['docker'] }, /Tool: docker/],
    [{ tools: ['*'] }, /Tool: \* \(every tool\)/],
    [{ services: [{ name: 'db', image: 'postgres:16', tools: ['docker'] }] }, /Tool: docker/],
    [{ permissions: ['sidecars.privileged'] }, /Permission: sidecars\.privileged/],
    [{ services: [{ name: 'vm', image: 'qemu:1', privileged: true }] }, /Sidecar vm \(qemu:1\)/],
    [{ services: [{ name: 'dind', image: 'docker:27', inheritDockerSocket: true }] }, /Sidecar dind/],
  ];
  for (const [over, risk] of cases) {
    const f = files(over);
    const m = parse(f);
    assert.equal(createLevel(m), 'fresh', JSON.stringify(over));
    const req = createRequest(m, target(f));
    assert.equal(req.level, 'fresh');
    assert.ok(req.highRisk?.some((r) => risk.test(r.item)), `${JSON.stringify(over)}: ${JSON.stringify(req.highRisk)}`);
  }
  // Context keys and a root request are listed, never granted by creating the app.
  const f = files({ context: ['API_TOKEN'], execution: { runAs: 'root', reason: 'it binds port 80' } });
  const req = createRequest(parse(f), target(f));
  assert.match(req.details!.join('\n'), /Context keys it declares \(not granted by this approval\): API_TOKEN/);
  assert.match(req.details!.join('\n'), /requests root execution \(runAs: root\): not granted/);
});

test('an overwrite stays admin.change (its *.overwrite operation, forced) with the same facts', () => {
  const f = files({ tools: ['docker'] });
  const req = createRequest(parse(f), target(f, { replaces: true }));
  assert.equal(req.action, 'admin.change');
  assert.equal((req.payload as Record<string, unknown>)['op'], 'scaffold.overwrite');
  assert.equal(core.approvalClassOf('admin.change', req.payload), 'forced');
  assert.equal(req.level, 'fresh');
  assert.match(req.details!.join('\n'), /The code that runs under that app id is replaced/);
  const clone = createRequest(parse(f), target(f, { via: 'clone', replaces: true, source: { appId: 'com.aura.notepad', scope: 'system' } }));
  assert.equal((clone.payload as Record<string, unknown>)['op'], 'clone-app.overwrite');
  assert.match(clone.title, /Overwrite com\.example\.notes with a copy of com\.aura\.notepad/);
});

test('the requester\'s summary goes to explanation, cleaned; it is bound by digest, never shown as a fact', () => {
  const f = files();
  const summary = '# Notes\nA small app.\u202e\u200b\u0007';
  const req = createRequest(parse(f), target(f, { summary }));
  assert.deepEqual(req.explanation, { format: 'markdown', text: '# Notes\nA small app.' });
  assert.ok(!req.details!.join('\n').includes('small app'));
  assert.match(String((req.payload as Record<string, unknown>)['summaryDigest']), /^[0-9a-f]{64}$/);
});

test('summary and plan inputs: at most 8 KiB of text, a plan is an object (AF4 invalid-input)', () => {
  assert.equal(checkCreateInputs(undefined, undefined), null);
  assert.equal(checkCreateInputs('x'.repeat(EXPLANATION_MAX_BYTES), { steps: [] }), null);
  const big = checkCreateInputs('é'.repeat(EXPLANATION_MAX_BYTES / 2 + 1), undefined)!;
  assert.deepEqual([big.status, big.body['error'], big.body['category']], [413, 'summary-too-large', 'invalid-input']);
  assert.equal(checkCreateInputs(42, undefined)!.body['category'], 'invalid-input');
  assert.equal(checkCreateInputs(undefined, [1])!.body['error'], 'invalid-plan');
});

// ── binding ────────────────────────────────────────────────────────────────

test('the files digest covers every path, mode and content, in no particular order', () => {
  const f = files();
  assert.equal(filesDigest(f), filesDigest([...f].reverse()));
  assert.notEqual(filesDigest(f), filesDigest(files({ name: 'Notez' })));
  assert.notEqual(filesDigest(f), filesDigest([f[0]!, { ...f[1]!, mode: 0o644 }]));
  assert.notEqual(filesDigest(f), filesDigest(files({}, [{ relPath: '.npmrc', content: '' }])));
  const base = createPayload(target(f));
  assert.deepEqual(Object.keys(base).sort(), ['appId', 'filesDigest', 'op', 'scope', 'target', 'via']);
  assert.notDeepEqual(createPayload(target(f, { plan: { a: 1 } })), base);
  assert.notDeepEqual(createPayload(target(f, { scope: 'global' })), base);
});

test('a staged clone is hashed without its fresh originId, and with everything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-create-'));
  try {
    const write = (originId: string, extra = 'x') => {
      writeFileSync(join(dir, 'app.manifest.json'), manifest({ originId }));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.txt'), extra);
    };
    write('11111111-1111-4111-8111-111111111111');
    const a = treeDigest(dir);
    write('22222222-2222-4222-8222-222222222222');
    assert.equal(treeDigest(dir).digest, a.digest, 'a new originId per staging hashes the same');
    write('22222222-2222-4222-8222-222222222222', 'y');
    assert.notEqual(treeDigest(dir).digest, a.digest);
    assert.equal(a.fileCount, 2);
    const m = manifestFromDir(dir, APP);
    assert.ok(!('status' in m));
    const bad = manifestFromDir(dir, 'com.other.app');
    assert.ok('status' in bad && bad.status === 422);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── through ownerAction, as the routes call it ─────────────────────────────

class MemoryStore {
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

const TERMINAL: CallerPrincipal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', userId: 'default', verification: 'verified' };
const OTHER_TERMINAL: CallerPrincipal = { ...TERMINAL, instanceId: 'com.aura.terminal-2' } as CallerPrincipal;
const OWNER: CallerPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 'sess-desk-0001', verification: 'verified' };
const SETTINGS: CallerPrincipal = { ...OWNER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as CallerPrincipal;
const OPERATOR: CallerPrincipal = { kind: 'operator', verification: 'verified' };
const FRESH: ApprovalDecider = { kind: 'user', userId: 'default', sessionId: 'sess-desk-0001', fresh: true };

let store: MemoryStore;
let caller: CallerPrincipal;
beforeEach(() => { store = new MemoryStore(); caller = TERMINAL; });

const deps = (): OwnerActionDeps => ({
  approvals: {
    store: store as never, appName: () => 'Terminal', audit: async () => {}, tickets: { peek: async () => null, claim: async () => null },
  },
  authenticate: async () => caller,
  shellOwner: async () => ({ identity: {} }),
});
const ctx = (approval?: string) => ({
  request: new Request('http://shell.test/api/admin/scaffold', {
    method: 'POST', headers: { authorization: 'Bearer aura-inst.x', ...(approval ? { 'x-aura-approval': approval } : {}) },
  }),
  cookies: {} as never,
});
const ask = async (f: CreateFile[], over: Partial<CreateTarget> = {}, approval?: string) =>
  ownerAction(ctx(approval), createRequest(parse(f), target(f, over)), deps());

test('the System Terminal (a human or an agent alike) is asked for every new app; the desktop owner and the operator act directly', async () => {
  const r = await ask(files());
  assert.ok(r instanceof Response);
  assert.equal(r.status, 202);
  const body = await r.json() as Record<string, any>;
  assert.equal(body.action, 'app.create');
  assert.equal(body.class, 'forced');
  assert.equal(body.display.requestedBy, 'Terminal (com.aura.terminal-1)');
  caller = SETTINGS;
  assert.equal(((await ask(files())) as Response).status, 202, 'Settings asks the owner too');
  for (const direct of [OWNER, OPERATOR]) {
    caller = direct;
    assert.ok(!((await ask(files())) instanceof Response), direct.kind);
  }
});

test('the approval binds the files, the summary, the plan, the target and the requester, and is used once', async () => {
  const f = files({ tools: ['docker'] });
  const first = await ((await ask(f, { summary: 'v1' })) as Response).json() as Record<string, any>;
  assert.equal(first.level, 'fresh');
  const id = first.approvalId as string;
  assert.equal((await store.approve(id, { ...FRESH, fresh: false })).ok, false, 'a privileged create needs the password');
  assert.equal((await store.approve(id, FRESH)).ok, true);

  // Any other file, summary, plan or target: refused, the approval stays unused.
  const changed: Array<[CreateFile[], Partial<CreateTarget>]> = [
    [files({ tools: ['docker', 'git'] }), { summary: 'v1' }],
    [f, { summary: 'v2' }],
    [f, { summary: 'v1', plan: { x: 1 } }],
    [f, { summary: 'v1', scope: 'global' }],
    [f, {}],
  ];
  for (const [g, over] of changed) {
    const r = await ask(g, over, id);
    assert.ok(r instanceof Response);
    const b = await r.json() as Record<string, any>;
    assert.equal(b.refused, 'mismatch', JSON.stringify(over));
  }
  caller = OTHER_TERMINAL;
  assert.equal((await (await ask(f, { summary: 'v1' }, id) as Response).json() as Record<string, any>).refused, 'mismatch', 'another instance');
  caller = TERMINAL;
  const ok = await ask(f, { summary: 'v1' }, id);
  assert.ok(!(ok instanceof Response), 'the exact request goes ahead');
  assert.equal((ok as { detail: Record<string, unknown> }).detail['approval'], id);
  const again = await ask(f, { summary: 'v1' }, id);
  assert.ok(again instanceof Response, 'used up');
  assert.equal(((await again.json()) as Record<string, any>).refused, 'wrong-state');
});

// ── the routes ─────────────────────────────────────────────────────────────

test('scaffold and clone-app ask for every create (not only an overwrite), after their input checks', () => {
  const read = (f: string) => readFileSync(new URL(`../src/pages/api/admin/${f}`, import.meta.url), 'utf8');
  const scaffold = read('scaffold.ts');
  assert.match(scaffold, /const admin = await ownerAction\(ctx, createRequest\(parsed\.manifest, target\)\);\n  if \(admin instanceof Response\) return admin;/);
  assert.doesNotMatch(scaffold, /if \(replacing\) \{\n\s*const admin = await ownerAction/, 'no create path without the owner');
  assert.ok(scaffold.indexOf('manifestFromFiles(') < scaffold.indexOf('ownerAction('), 'the facts are parsed before the owner is asked');
  assert.ok(scaffold.indexOf('ownerAction(') < scaffold.indexOf('writeFileSync(target'), 'nothing is written before the decision');
  const clone = read('clone-app.ts');
  assert.match(clone, /const admin = await ownerAction\(ctx, createRequest\(parsed\.manifest, \{/);
  assert.ok(clone.indexOf('if (body.dryRun)') < clone.indexOf('ownerAction('), 'a dry run asks nobody');
  assert.ok(clone.indexOf('ownerAction(') < clone.indexOf('renameSync(staging, dest)'), 'nothing lands before the decision');
});
