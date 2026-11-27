// D105 Pass B (error-messages review rows 15, 19–33): the shared failure
// builder, the redaction for readers who are not the owner, and the coded
// answers of approvals, security options and Nexus. Ends with the hint-leak
// matrix: every body these produce for an app reader is checked against the
// review's §4.4 rules.
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuraError, SECURITY_OPTIONS } from '@aura/core';
import type { AuraErrorBody } from '@aura/core';
import {
  errorResponse, errorText, failureBody, legacyErrorBody, redactInternal, type ErrorAudience,
} from '../src/lib/appResponse.ts';
import { refusal } from '../src/lib/approvals/service.ts';
import { nexusFailureBody } from '../src/lib/nexusErrors.ts';
import { putSecurityOption, type SecurityOptionsDeps } from '../src/lib/securityOptions.ts';

/** What an app-visible body must never carry (review §4.4 rules 2, 5, 6). */
const LEAKS: Array<[string, RegExp]> = [
  ['host path', /(?<![\w.:/~-])\/(?:data|workspace|mnt\/aura|home|var\/lib|run|tmp|os|aura|proc|etc|root)\b/],
  ['container name', /\baura-(?!dev\b|cap\b)[a-z0-9]+-[a-z0-9-]+\b|\baura-shell\b/],
  ['bearer token', /Bearer\s+(?!<redacted>|\$AURA_INSTANCE_TOKEN)[A-Za-z0-9]/],
  ['credential in a URL', /:\/\/(?!<redacted>@)[^\s/@]+:[^\s/@]+@/],
  ['env assignment', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*=(?!<redacted>)\S/],
  ['owner tooling', /System Terminal|owner agent|docker exec/i],
];

function assertNoLeak(body: unknown, where: string): void {
  const text = JSON.stringify(body);
  for (const [what, re] of LEAKS) assert.doesNotMatch(text, re, `${where}: ${what} in ${text}`);
}

const RAW = [
  "EACCES: permission denied, open '/data/scopes/users/default/apps/com.example.notes/app.manifest.json'",
  'Error: [ProotRunner] docker: Error response from daemon: Conflict. The container name "/aura-com-example-notes-7f3a" is already in use',
  'git clone https://deploy:glpat-secret123@gitlab.example.com/acme/notes.git failed: fatal: repository not found',
  'request failed: Authorization: Bearer aura1.abcdef0123456789 was refused',
  'mount failed: AURA_DESKTOP_HOSTS=desk.example.com is set; see /workspace/os/boot.sh and /mnt/aura/com.example.notes/src',
  'exec /aura/my-tools/.bin/git: no such file or directory',
];

test('errorText drops the Error: prefix and the [Origin] tag', () => {
  assert.equal(errorText(new Error('[ProotRunner] did not become healthy')), 'did not become healthy');
  assert.equal(errorText('Error: TypeError: boom'), 'boom');
  assert.equal(errorText(new Error('')), 'unknown error');
});

test('redactInternal keeps what a message says, not where', () => {
  const out = RAW.map(redactInternal);
  assert.match(out[0]!, /^EACCES: permission denied, open '<path>'$/);
  assert.match(out[1]!, /container name "\/?<container>"|container name "<path>"/);
  assert.match(out[2]!, /https:\/\/<redacted>@gitlab\.example\.com/);
  assert.match(out[3]!, /Bearer <redacted>/);
  assert.match(out[4]!, /<redacted> is set; see <path> and <path>/);
  // Public routes stay readable.
  assert.equal(redactInternal('POST /api/approvals then /_aura/os/x'), 'POST /api/approvals then /_aura/os/x');
  for (const [i, o] of out.entries()) assertNoLeak(o, `RAW[${i}]`);
  assert.ok(redactInternal('x'.repeat(1000)).length <= 300);
});

test('failureBody: whole to the owner, redacted to anyone else; a carried code as is', () => {
  const err = new Error(RAW[0]);
  const owner = failureBody(err, 'owner');
  assert.equal(owner.status, 500);
  assert.equal(owner.body.message, RAW[0]);
  const app = failureBody(err, 'app', { what: 'KV error', status: 502 });
  assert.equal(app.status, 502);
  assert.equal(app.body.error, 'internal-error');
  assert.match(app.body.message, /^KV error: EACCES: permission denied, open '<path>'$/);
  // An AuraError (here 409 app-disabled) keeps its status and body for every reader.
  const coded = new AuraError(409, { error: 'app-disabled', message: 'App com.x.y is disabled.', hint: 'aura enable app com.x.y' });
  assert.deepEqual(failureBody(coded, 'app'), { status: 409, body: coded.body });
  // EROFS under the app the caller named: source-closed with the way out.
  const erofs = Object.assign(new Error("EROFS: read-only file system, open '/data/scopes/global/apps/com.x.y/a'"), { code: 'EROFS' });
  const closed = failureBody(erofs, 'app', { appId: 'com.x.y' });
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'source-closed');
  assert.match(closed.body.hint!, /aura dev patch start com\.x\.y/);
  assert.equal(failureBody(erofs, 'owner').body.error, 'read-only');
});

test('the old errorResponse form says the sentence in message too, with no-store and nosniff', async () => {
  const res = errorResponse('App not found: com.x.y', 404);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'App not found: com.x.y', message: 'App not found: com.x.y' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(legacyErrorBody({ error: 'x', message: 'm', hint: 'h' }), { error: 'm', message: 'm', hint: 'h' });
});

const APPROVAL_REASONS = ['not-found', 'expired', 'wrong-state', 'mismatch', 'needs-fresh-auth', 'not-a-decider', 'not-a-requester',
  'too-many-pending', 'rate-limited', 'blocked', 'not-deferrable', 'stale'] as const;

test('row 26: approval refusals keep their code and status and gain a sentence', async () => {
  const expect: Record<string, [number, string]> = {
    'not-found': [404, 'not-found'], expired: [410, 'expired'], 'rate-limited': [429, 'rate-limited'], blocked: [403, 'blocked'],
    'not-a-decider': [403, 'decider-required'], 'not-a-requester': [403, 'requester-required'], mismatch: [409, 'mismatch'], 'wrong-state': [409, 'wrong-state'],
  };
  for (const r of APPROVAL_REASONS) {
    const res = refusal(r);
    const body = await res.json() as AuraErrorBody;
    assert.ok(body.message, r);
    if (expect[r]) assert.deepEqual([res.status, body.error], expect[r], r);
  }
});

function secDeps(): SecurityOptionsDeps {
  return {
    ownerAction: async () => ({ kind: 'operator' }) as never,
    store: { get: async () => ({}), set: async () => ({ ok: true, changed: false, previous: false, value: false }) } as never,
    audit: async () => undefined,
    env: {},
  };
}
const put = (body: unknown) => putSecurityOption({ request: new Request('http://x/api/admin/security-options', { method: 'PUT', body: JSON.stringify(body) }) } as never, secDeps());

test('row 28: security option refusals say why and where, never the record key or the /data path', async () => {
  const unknown = await put({ id: 'no-such-option', value: true });
  assert.equal(unknown.status, 404);
  const u = await unknown.json() as AuraErrorBody;
  assert.equal(u.error, 'unknown-option');
  assert.match(u.hint!, /aura admin security/);
  for (const o of SECURITY_OPTIONS.filter((x) => x.source === 'record' || x.source === 'file')) {
    const res = await put({ id: o.id, value: 'x' });
    const b = await res.json() as AuraErrorBody;
    assert.equal(b.error, 'own-setting', o.id);
    assert.ok(b.message.includes(o.title), o.id);
    assertNoLeak(b, `own-setting ${o.id}`);
    if (o.file) assert.ok(!JSON.stringify(b).includes(o.file), o.id);
  }
  const mode = await (await put({ id: 'system-mode', value: 'x' })).json() as AuraErrorBody;
  assert.match(mode.hint!, /aura mode developer\|normal/);
  const enumOpt = SECURITY_OPTIONS.find((o) => o.source === 'policy' && o.type === 'enum' && !o.env);
  if (enumOpt) {
    const b = await (await put({ id: enumOpt.id, value: 'not-a-value' })).json() as AuraErrorBody & { values?: string[] };
    assert.equal(b.error, 'invalid-value');
    assert.match(b.message, /takes one of/);
  }
});

test('row 29: Nexus failures get their status and code instead of a 500', () => {
  const invalid = Object.assign(new Error('manifest validation failed'), {
    name: 'NexusValidationError', issues: ['services.0.tools: Expected array, received string', '<root>: unknown key'],
  });
  const v = nexusFailureBody(invalid, 'app');
  assert.equal(v.status, 422);
  assert.equal(v.body.error, 'manifest-invalid');
  assert.equal(v.body.manifestField, 'services.0.tools');
  assert.match(v.body.hint!, /aura dev validate/);
  const auth = Object.assign(new Error('login to ghcr.io failed — check the username and password of that source (401 /data/aura/oras/config.json)'), {
    name: 'OrasAuthError', host: 'ghcr.io', reason: 'rejected',
  });
  const a = nexusFailureBody(auth, 'app');
  assert.deepEqual([a.status, a.body.error], [403, 'registry-login']);
  assert.match(a.body.hint!, /aura nexus registry login/);
  assert.ok(!a.body.message.includes('/data'), 'no oras detail to an app');
  assert.match(nexusFailureBody(auth, 'owner').body.message, /401/);
  const sys = Object.assign(new Error('x'), { code: 'system-app', appId: 'com.aura.settings' });
  const s = nexusFailureBody(sys, 'app');
  assert.deepEqual([s.status, s.body.error], [409, 'system-app']);
  assert.match(s.body.hint!, /aura disable app com\.aura\.settings/);
  const scope = new AuraError(409, { error: 'scope-immutable', message: "Scope 'system' is immutable: apps are not installed into it." });
  assert.equal(nexusFailureBody(scope, 'app').status, 409);
});

test('hint-leak matrix (review §4.4): no app-visible body leaks a path, a credential, an env value or owner tooling', async () => {
  const bodies: Array<[string, unknown]> = [];
  const audiences: ErrorAudience[] = ['app'];
  for (const a of audiences) {
    for (const [i, raw] of RAW.entries()) {
      bodies.push([`failure ${i}`, failureBody(new Error(raw), a).body]);
      bodies.push([`failure ${i} legacy`, legacyErrorBody(failureBody(new Error(raw), a, { what: 'KV error' }).body)]);
      bodies.push([`nexus ${i}`, nexusFailureBody(new Error(raw), a).body]);
      bodies.push([`oras ${i}`, nexusFailureBody(Object.assign(new Error(raw), { name: 'OrasAuthError', host: 'r.example.com', reason: 'missing' }), a).body]);
    }
  }
  for (const r of APPROVAL_REASONS) bodies.push([`approval ${r}`, await refusal(r).json()]);
  for (const [where, body] of bodies) assertNoLeak(body, where);
});
