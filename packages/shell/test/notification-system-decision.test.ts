// DEV hook POST /api/admin/dev/system-decision (phase 6): scope system is
// forced, the payload goes through the normal create (schema), and the hook
// is refused outside the dev server. Who may call is the route access manifest's
// (test/access-enforce.test.ts); the owner's approval is lib/approvals/admin.ts.
//
//   cd packages/shell && npx tsx --test test/notification-system-decision.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemDecisionInput, handleSystemDecision, DEFAULT_DECISION_COMPONENTS, type SystemDecisionDeps } from '../src/lib/notifications/systemDecision.ts';

function deps(over: Partial<SystemDecisionDeps> = {}) {
  const audits: Array<[unknown, string, Record<string, unknown>]> = [];
  const created: Array<Record<string, unknown>> = [];
  const d: SystemDecisionDeps = {
    dev: true,
    actor: async () => ({ by: { kind: 'operator' }, detail: {} }),
    audit: async (a, action, e) => { audits.push([a, action, e]); },
    create: async (input) => { created.push(input); return { notification: { id: 'ntf_000000000sys00001' }, warnings: [] }; },
    readJson: async (r) => JSON.parse(await r.text() || '{}'),
    errorResponse: (err) => new Response(JSON.stringify({ error: (err as Error).message }), { status: (err as { status?: number }).status ?? 500 }),
    ...over,
  };
  return { d, audits, created };
}
const req = (body: unknown) => new Request('http://shell/api/admin/dev/system-decision', { method: 'POST', body: JSON.stringify(body) });

test('input: type dialogue + scope system are forced over any payload; defaults; legacy flat fields', () => {
  const forced = buildSystemDecisionInput({ payload: { type: 'simple', scope: 'auto', title: 'T', components: [{ kind: 'button', role: 'submit' }] } });
  assert.equal(forced['type'], 'dialogue');
  assert.equal(forced['scope'], 'system');
  assert.equal(forced['title'], 'T');
  assert.deepEqual(forced['components'], [{ kind: 'button', role: 'submit' }]);
  const defaults = buildSystemDecisionInput({});
  assert.equal(defaults['priority'], 'high');
  assert.deepEqual(defaults['components'], DEFAULT_DECISION_COMPONENTS);
  const legacy = buildSystemDecisionInput({ title: 'Old', text: 'x', priority: 'urgent', scope: 'auto' });
  assert.deepEqual([legacy['title'], legacy['text'], legacy['priority'], legacy['scope']], ['Old', 'x', 'urgent', 'system']);
});

test('route: 404 outside DEV (no owner check, nothing created)', async () => {
  const { d, created, audits } = deps({ dev: false });
  const r = await handleSystemDecision(req({}), d);
  assert.equal(r.status, 404);
  assert.equal(created.length + audits.length, 0);
});

test('route: the owner + DEV → 201, created with scope system, audited ok; schema errors pass through (400) and are audited', async () => {
  const { d, created, audits } = deps();
  const r = await handleSystemDecision(req({ payload: { title: 'Allow?', scope: 'auto' } }), d);
  assert.equal(r.status, 201);
  assert.equal(created[0]!['scope'], 'system');
  assert.equal(audits.at(-1)![2]['outcome'], 'ok');
  const bad = deps({ create: async () => { throw Object.assign(new Error('invalid notification'), { status: 400 }); } });
  const r2 = await handleSystemDecision(req({ payload: { title: '' } }), bad.d);
  assert.equal(r2.status, 400);
  assert.equal(bad.audits.at(-1)![2]['outcome'], 'failed');
});

test('route: an app gets the owner\'s approval answer, and nothing is created (D50)', async () => {
  const asked = new Response(JSON.stringify({ needsApproval: true, approvalId: 'apr_x' }), { status: 202 });
  const { d, created, audits } = deps({ actor: async () => asked });
  const r = await handleSystemDecision(req({ payload: { title: 'Allow?' } }), d);
  assert.equal(r.status, 202);
  assert.equal(created.length + audits.length, 0);
});
