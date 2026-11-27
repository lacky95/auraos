// D105 Pass B (error-messages review rows 15, 19–33): the kernel side of the
// structured errors. Codes and facts travel with the error (`AuraError`,
// matched by shape), every text names the fix, and nothing leaks a host path
// or a credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The composition root (Phase 6 K) wires the service accessors when the barrel loads.
import '../dist/index.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_REFUSAL_TEXT, AuraError, auraErrorOf, closestName, closestPermission, contractFindings, isKnownPermission,
  sourceClosedBody, writeMissingIndex, MISSING_INDEX, HEALTH_IDENTITY_HINT, LIFECYCLE_GUARD_HINT,
  healthIdentityRefusal, lifecycleStatusRefusal,
} from '../dist/index.js';
import { SidecarIdentityError, SpecError, sidecarPermissionError } from '../dist/app-manager/sidecar-spec.js';
import { NexusValidationError, validateStagedDir } from '../dist/nexus/Validator.js';

const LEAK = /\/data\/|\/workspace|\/mnt\/aura|\/tmp\/|aura-shell|Bearer [A-Za-z0-9]/;

test('AuraError carries its status and body; auraErrorOf matches by shape, not instanceof', () => {
  const e = new AuraError(409, { error: 'app-disabled', message: 'App x is disabled.', hint: 'aura enable app x' });
  assert.equal(e.code, 'app-disabled');
  assert.equal(e.message, 'App x is disabled.');
  assert.deepEqual(auraErrorOf(e), { status: 409, body: e.body });
  // Another copy of core (the Astro bundle) or an older domain error with the same shape matches too.
  const foreign = Object.assign(new Error('m'), { status: 403, body: { error: 'x', message: 'm' } });
  assert.equal(auraErrorOf(foreign)?.status, 403);
  assert.ok(auraErrorOf(new SidecarIdentityError('com.a.b', 'web', 'root', null)));
  // Not an error answer: no status, a 2xx status, a body without a message.
  assert.equal(auraErrorOf(new Error('plain')), null);
  assert.equal(auraErrorOf({ status: 200, body: { error: 'x', message: 'm' } }), null);
  assert.equal(auraErrorOf({ status: 409, body: { error: 'x' } }), null);
  assert.equal(auraErrorOf(null), null);
});

test('source-closed: one text with the way out (patch or the owner opens it)', () => {
  const b = sourceClosedBody('com.example.notes');
  assert.equal(b.error, 'source-closed');
  assert.equal(b.target, 'com.example.notes');
  assert.match(b.message, /closed install/);
  assert.match(b.hint, /aura dev patch start com\.example\.notes/);
  assert.match(b.hint, /aura dev open com\.example\.notes/);
});

test('row 15: sidecar permission refusals name the permission and the owner\'s command', () => {
  for (const p of ['sidecars.anyImage', 'sidecars.privileged', 'sidecars.manageAll', 'sidecars.tools']) {
    const e = sidecarPermissionError('com.example.app', p, `needs ${p}`);
    assert.ok(e instanceof SpecError);
    assert.equal(e.status, 403);
    assert.equal(e.body.error, 'access-denied');
    assert.equal(e.body.reason, 'missing-permission');
    assert.equal(e.body.permission, p);
    assert.equal(e.body.holder, 'caller');
    assert.equal(e.body.manifestField, 'permissions[]');
    assert.equal(e.body.message, `needs ${p}`);
    assert.match(e.body.hint, new RegExp(`aura grant perms com\\.example\\.app ${p.replace('.', '\\.')}`));
  }
  // A plain SpecError keeps having no body.
  assert.equal(new SpecError(400, 'bad').body, undefined);
});

test('row 22: the permission catalogue: built-ins and families known, a typo gets a suggestion', () => {
  for (const p of ['apps.mount', 'user.confirm', 'data:com.example.notes:read', 'context.read:OPENAI_KEY',
    'credential.read:GITHUB_TOKEN', 'system.kv.os.theme.write']) assert.ok(isKnownPermission(p), p);
  for (const p of ['apps.mounts', 'storage', 'data:bad', 'context.read:lower']) assert.ok(!isKnownPermission(p), p);
  assert.equal(closestPermission('apps.mounts'), 'apps.mount');
  assert.equal(closestPermission('user.confrim'), 'user.confirm');
  assert.equal(closestPermission('something.else.entirely'), null);
  assert.equal(closestName('gti', ['git', 'node', 'claude']), 'git');
  assert.equal(closestName('zzzzzz', ['git']), null);
});

test('rows 19 and 22: contract findings for unknown permissions and ignored ports{}', () => {
  const findings = contractFindings({
    id: 'com.example.app', auraContract: 1, permissions: ['apps.mounts', 'storage.read'], tools: [], services: [], consumes: [],
    ports: { hostPublish: [{ port: 8080 }] },
  });
  const unknown = findings.find((f) => f.code === 'permission-unknown');
  assert.equal(unknown?.path, 'permissions.0');
  assert.match(unknown.message, /'apps\.mounts' is not a known permission.*did you mean 'apps\.mount'/);
  const ports = findings.find((f) => f.code === 'ports-undeclared');
  assert.equal(ports?.severity, 'warn');
  assert.match(ports.message, /ports\{\} is ignored.*apps\.port.*aura grant perms com\.example\.app apps\.port/);
  // Declared: no finding.
  const ok = contractFindings({ auraContract: 1, permissions: ['apps.port'], tools: [], services: [], consumes: [], ports: { hostPublish: [{ port: 8080 }] } });
  assert.ok(!ok.some((f) => f.code === 'ports-undeclared' || f.code === 'permission-unknown'));
});

test('row 26: every approval refusal has a sentence; none names a factor or another requester', () => {
  const reasons = ['not-found', 'expired', 'wrong-state', 'mismatch', 'needs-fresh-auth', 'not-a-decider', 'not-a-requester',
    'too-many-pending', 'rate-limited', 'blocked', 'not-deferrable', 'stale'];
  for (const r of reasons) {
    const t = APPROVAL_REFUSAL_TEXT[r];
    assert.ok(t?.message, r);
    assert.doesNotMatch(`${t.message} ${t.hint ?? ''}`, LEAK, r);
  }
  assert.match(APPROVAL_REFUSAL_TEXT.blocked.hint, /aura approve --unblock/);
  assert.match(APPROVAL_REFUSAL_TEXT['rate-limited'].hint, /minute/);
});

test('row 20: the allowlist dir indexes what is not on PATH, and why', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-missing-'));
  writeMissingIndex(dir, {
    tools: ['git', 'gh', 'cc'], linked: ['git', 'claude'], aliases: { claude: ['cc'] }, missing: [], store: ['git', 'claude', 'node', 'codex', 'codex-code-mode-host'],
    helpers: new Set(['codex-code-mode-host']), needsLibs: ['git'],
  });
  const lines = readFileSync(join(dir, MISSING_INDEX), 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['codex\tnot-granted', 'gh\tnot-installed', 'git\tneeds-libraries', 'node\tnot-granted']);
  // '#' marks the named tools as withheld: they are not-granted, never not-installed.
  writeMissingIndex(dir, { tools: ['docker', '#'], linked: ['git'], missing: [], store: ['git', 'docker'], helpers: new Set(), needsLibs: [] });
  assert.equal(readFileSync(join(dir, MISSING_INDEX), 'utf8'), 'docker\tnot-granted\n');
});

test('row 31: the start refusals name the SDK fix', () => {
  assert.match(healthIdentityRefusal({ kind: 'legacy' }, 'com.x.y', 'com.x.y-1', 'strict'), new RegExp(HEALTH_IDENTITY_HINT.slice(0, 30).replace(/[()]/g, '\\$&')));
  assert.match(HEALTH_IDENTITY_HINT, /healthResponse\(\) from @aura\/app-sdk/);
  assert.match(lifecycleStatusRefusal('com.x.y-1', { identity: 'match', guard: 'accepted-wrong-token' }, 'strict'), /lifecycle-guard|lifecycle token/);
  assert.match(LIFECYCLE_GUARD_HINT, /@aura\/app-sdk/);
});

test('row 33: a staged manifest that is missing does not name the staging path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-stage-'));
  assert.throws(() => validateStagedDir(dir), (e) => e instanceof NexusValidationError && !e.message.includes(dir) && !LEAK.test(e.message));
});
