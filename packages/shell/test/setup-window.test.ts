// D108 P6: the setup window (lib/setupWindow.ts, components/setup/Wizard.ts)
// and the setup branch of resolveAppFrame (lib/appFrame.ts). DOM tests with
// happy-dom and a fake fetch: the setup engine (P3) is not built, so every
// API answer here is the contract's plain data (core setup/contracts.ts).
//
// Covered: a setup refusal opens the window in setup state instead of the app
// frame; a simple app's launch is the same one call and the same frame
// resolution as before; the steps come from the plan (skipped steps are not
// walked); resume at the recorded step; 503 is a notice, never progress;
// on-hold shows the pending approval and never an approve control; `ready`
// hands the same window to the app; no secret value in the DOM.
//
//   node tools/run-tests.mjs --only=shell
import { dom, resetDom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FieldView, SetupApplyPayload, SetupOutcome, SetupPlan, SetupPlanStep, SetupStateView } from '@aura/core';

const { mountSetupWindow, setupLaunchOf, startWithSetup, SECRET_ASK_UNAVAILABLE } = await import('../src/lib/setupWindow.ts');
const { resolveAppFrame, APP_FRAME_ALLOW, APP_FRAME_SANDBOX } = await import('../src/lib/appFrame.ts');
// Every import before the first test: the DOM closes when the file's top level is done.

const doc = dom.document as unknown as Document;
const APP = 'com.e2e.setuponly';
const SHELL = 'http://10-201-1-2.nip.io:3000';
const HOST = 'http://notes1a2b3c4d--10-201-1-2.nip.io:3000';
const LEAK_MARK = 'value-that-must-not-leak';

const tick = async (n = 6): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Call { method: string; url: string; body: unknown }
/** A fake fetch: `routes['GET /path']` answers in order (the last one repeats). */
function fakeFetch(routes: Record<string, Array<() => Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const f = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url}`;
    const list = routes[key];
    if (!list) return json({ error: 'not-found', message: key }, 404);
    const i = used.get(key) ?? 0;
    used.set(key, i + 1);
    return list[Math.min(i, list.length - 1)]!();
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const state = (s: Partial<SetupStateView> = {}): SetupStateView => ({
  appId: APP, installationId: 'inst-1', declares: true, state: 'setup-required', profile: null, step: null,
  configDigest: null, degraded: [], ...s,
});
const steps = (over: Partial<Record<SetupPlanStep['step'], SetupPlanStep['status']>> = {}): SetupPlanStep[] =>
  (['profile', 'values', 'requirements', 'review', 'approval', 'init', 'readiness', 'done'] as const)
    .map((step) => ({ step, title: step[0]!.toUpperCase() + step.slice(1), status: over[step] ?? 'todo' }));
const FIELDS: FieldView[] = [
  { name: 'smtpHost', field: { type: 'string', title: 'SMTP host', required: true }, value: 'mail.example' },
  // A view that wrongly carries a value for a secret: it must never reach the DOM.
  { name: 'password', field: { type: 'secret', title: 'SMTP password', required: true, secret: { source: 'ask' } }, hasSecret: true, value: LEAK_MARK },
];
const APPROVAL: SetupApplyPayload = {
  appId: APP, installationId: 'inst-1', profile: null, configDigest: 'c1', grantDigest: 'g1',
  adds: { permissions: ['apps.mount'], tools: [], context: [], homePrivate: false, homePrivateSidecars: [] },
};
const plan = (p: Partial<SetupPlan> = {}): SetupPlan => ({
  appId: APP, state: state(), steps: steps({ profile: 'skipped' }), profiles: [], fields: FIELDS, requirements: [],
  approval: APPROVAL, blocking: [], degraded: [], configDigest: 'c1', grantDigest: 'g1', ...p,
});
const BASE = `/api/apps/${APP}/setup`;
const UNAVAILABLE = { error: 'unavailable', category: 'unavailable', message: 'the app setup engine is not available on this AuraOS', hint: 'update AuraOS' };

function windowBody(): HTMLElement {
  resetDom('<div class="app-slot"><div class="slot-body"><div data-aura-skeleton="1"></div></div></div>');
  return doc.querySelector('.slot-body') as HTMLElement;
}
const buttons = (root: ParentNode): HTMLButtonElement[] => [...root.querySelectorAll('button')] as HTMLButtonElement[];
const click = (root: ParentNode, action: string): void => {
  const b = root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  assert.ok(b, `a ${action} button`);
  b.click();
};

// ── launch ──────────────────────────────────────────────────────────────────

test('a simple app launches exactly as before: one start call, its answer unchanged, no setup', async () => {
  const answer = json({ instanceId: 'com.x.simple', appId: 'com.x.simple' });
  const calls: Array<[string, RequestInit]> = [];
  let shown = 0;
  const res = await startWithSetup('com.x.simple', { showSetup: async () => { shown++; return true; } }, {
    fetch: (async (u: string, init: RequestInit) => { calls.push([u, init]); return answer; }) as unknown as typeof fetch,
  });
  assert.equal(res, answer, 'the same response object');
  assert.deepEqual(calls, [['/api/apps/com.x.simple/start', { method: 'POST' }]]);
  assert.equal(shown, 0);
  // Other refusals stay what they were (the launch drops the placeholder as before).
  for (const r of [
    json({ error: 'contract-unsupported', category: 'unsupported-operation', state: 'blocked', message: 'newer contract' }, 409),
    json({ error: 'boom' }, 500),
    json({ error: 'conflict', message: 'busy' }, 409),
  ]) {
    assert.equal(await startWithSetup('com.x.simple', { showSetup: async () => { shown++; return true; } }, { fetch: (async () => r) as unknown as typeof fetch }), r);
  }
  assert.equal(shown, 0);
});

test('a setup refusal opens the window in setup state, then starts the app again once it is ready', async () => {
  const refusal = { error: 'setup-required', category: 'needs-setup', state: 'setup-required', message: 'set it up first', target: APP };
  let starts = 0;
  const seen: unknown[] = [];
  const res = await startWithSetup(APP, { showSetup: async (l) => { seen.push(l); return true; } }, {
    fetch: (async () => (++starts === 1 ? json(refusal, 409) : json({ instanceId: APP }))) as unknown as typeof fetch,
  });
  assert.equal(res?.status, 200);
  assert.equal(starts, 2);
  assert.deepEqual(seen, [{ appId: APP, state: 'setup-required', error: { error: 'setup-required', message: 'set it up first' } }]);
  // Closed during the setup: no second start.
  starts = 0;
  assert.equal(await startWithSetup(APP, { showSetup: async () => false }, { fetch: (async () => { starts++; return json(refusal, 409); }) as unknown as typeof fetch }), null);
  assert.equal(starts, 1);
  // A1 (no engine on this AuraOS) and the intents shape are setup refusals too.
  const a1 = await setupLaunchOf(json({ error: 'setup-unsupported', category: 'unsupported-feature', state: 'blocked', message: 'no engine', hint: 'update' }, 409), APP);
  assert.deepEqual(a1, { appId: APP, state: 'blocked', error: { error: 'setup-unsupported', message: 'no engine', hint: 'update' } });
  const intent = await setupLaunchOf(json({ kind: 'setup-required', appId: APP, state: 'blocked', error: refusal }, 409), 'other');
  assert.equal(intent?.appId, APP);
});

test('the app frame resolves as before; the setup branch reads the setup state and spends no handoff', async () => {
  const handoff = (async () => json({ code: 'c0de', origin: HOST, slot: 2 })) as unknown as typeof fetch;
  const f = await resolveAppFrame({ appId: 'com.x.notes', instanceId: 'i', activityId: 'a1', path: '/doc' }, { shellOrigin: SHELL, fetch: handoff });
  assert.deepEqual(f, {
    origin: HOST, url: `${HOST}/_aura/handoff?code=c0de&next=${encodeURIComponent('/doc?_aura_activity=a1')}`, label: 'notes1a2b3c4d',
    slot: 2, sandbox: APP_FRAME_SANDBOX, allow: APP_FRAME_ALLOW, system: false,
  }, 'no `kind` key: the app result is unchanged');

  const ok = fakeFetch({ [`GET ${BASE}`]: [() => json(state({ step: 'values' }))] });
  const s = await resolveAppFrame({ kind: 'setup', appId: APP }, { shellOrigin: 'http://10.201.1.2:3000', fetch: ok.fetch });
  assert.equal(s.kind, 'setup');
  assert.equal(s.state?.step, 'values');
  assert.deepEqual(ok.calls.map((c) => c.url), [BASE], 'no handoff, works on a direct-IP address too');
  const down = fakeFetch({ [`GET ${BASE}`]: [() => json(UNAVAILABLE, 503)] });
  const d = await resolveAppFrame({ kind: 'setup', appId: APP }, { fetch: down.fetch });
  assert.equal(d.state, null);
  assert.deepEqual(d.refusal, { status: 503, error: 'unavailable', message: UNAVAILABLE.message, hint: 'update AuraOS' });
});

// ── the wizard ──────────────────────────────────────────────────────────────

test('without a setup engine (503) the window shows a clear notice, never progress', async () => {
  const body = windowBody();
  const api = fakeFetch({ [`GET ${BASE}`]: [() => json(UNAVAILABLE, 503)] });
  let ready = 0;
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => { ready++; } }, { fetch: api.fetch });
  await tick();
  assert.equal(w.element.dataset['phase'], 'notice');
  assert.ok(w.element.querySelector('[data-notice="unavailable"]'));
  assert.match(w.element.textContent ?? '', /not available on this AuraOS/);
  assert.equal(w.element.querySelector('[data-setup="progress"]'), null, 'no stepper');
  assert.equal(buttons(w.element).length, 0);
  assert.equal(ready, 0);
  w.dispose();
});

test('steps come from the plan: a skipped step is shown skipped and not walked', async () => {
  const body = windowBody();
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state())],
    [`GET ${BASE}/plan`]: [() => json(plan({ steps: steps({ profile: 'skipped', requirements: 'skipped' }) }))],
    [`POST ${BASE}/plan`]: [() => json(plan({ steps: steps({ profile: 'skipped', requirements: 'skipped' }) }))],
  });
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => undefined }, { fetch: api.fetch });
  await tick();
  assert.equal(w.element.dataset['phase'], 'edit');
  const li = [...w.element.querySelectorAll('.su-step')] as HTMLElement[];
  assert.deepEqual(li.map((x) => x.dataset['step']), ['profile', 'values', 'requirements', 'review', 'approval', 'init', 'readiness', 'done']);
  assert.equal(li[0]!.dataset['status'], 'skipped');
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'values', 'starts at the first walked step');
  assert.equal(w.element.querySelector('button[data-action="back"]'), null);
  click(w.element, 'next');
  await tick();
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'review', 'requirements skipped');
  assert.ok(w.element.querySelector('[data-setup="approval"]'), 'the approval preview');
  click(w.element, 'back');
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'values');
  w.dispose();
});

test('a reopened window resumes at the recorded step', async () => {
  const body = windowBody();
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state({ state: 'configuring', step: 'requirements', profile: 'personal' }))],
    [`GET ${BASE}/plan`]: [() => json(plan({ steps: steps({ profile: 'done', values: 'done' }) }))],
  });
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => undefined }, { fetch: api.fetch });
  await tick();
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'requirements');
  assert.equal(w.element.querySelector('.su-step-current')?.getAttribute('data-step'), 'requirements');
  w.dispose();
});

test('on hold: the window shows the pending approval and never a control that approves', async () => {
  const body = windowBody();
  const onHold: SetupOutcome = { status: 'on-hold', approvalId: 'apr_123', state: state({ state: 'awaiting-approval', step: 'approval', approvalId: 'apr_123' }) };
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state({ step: 'review' })), () => json(onHold.state)],
    [`GET ${BASE}/plan`]: [() => json(plan())],
    [`POST ${BASE}/apply`]: [() => json(onHold, 202)],
  });
  const reviewed: string[] = [];
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => undefined },
    { fetch: api.fetch, openApproval: (id) => reviewed.push(id), pollMs: 5 });
  await tick();
  click(w.element, 'apply');
  await tick();
  assert.equal(w.element.dataset['phase'], 'pending');
  assert.equal(w.element.querySelector('[data-pending-approval]')?.getAttribute('data-pending-approval'), 'apr_123');
  assert.match(w.element.textContent ?? '', /Waiting for your approval/);
  for (const b of buttons(w.element)) {
    assert.doesNotMatch(b.textContent ?? '', /approve|allow|deny|confirm/i, 'no approval control');
    assert.notEqual(b.dataset['action'], 'approve');
  }
  click(w.element, 'review-approval');
  assert.deepEqual(reviewed, ['apr_123'], 'Review opens the owner dialog (D102)');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.element.dataset['phase'], 'pending', 'still pending while the engine says so');
  assert.ok(!api.calls.some((c) => c.url.startsWith('/api/approvals')), 'the window never decides an approval');
  w.dispose();
});

test('ready hands the same window to the app: the wizard leaves, the frame resolves only then', async () => {
  const body = windowBody();
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state({ state: 'initializing', step: 'init' })), () => json(state({ state: 'ready', step: 'done' }))],
    [`GET ${BASE}/plan`]: [() => json(plan())],
  });
  let ready = 0;
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => { ready++; } }, { fetch: api.fetch, pollMs: 60 });
  await tick();
  assert.equal(w.element.dataset['phase'], 'progress');
  assert.match(w.element.textContent ?? '', /initializing/);
  assert.equal(ready, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ready, 1);
  assert.equal(body.querySelector('[data-aura-setup-window]'), null, 'the wizard left the window');
  assert.ok(body.querySelector('[data-aura-skeleton]'), 'the same window body waits for the app frame');
  assert.ok(!api.calls.some((c) => c.url.includes('handoff')), 'no frame before ready');
  w.dispose();

  // Already ready when the window opens (the start was refused anyway): no loop, the owner retries.
  const b2 = windowBody();
  const api2 = fakeFetch({ [`GET ${BASE}`]: [() => json(state({ state: 'ready' }))] });
  let r2 = 0;
  const launch = { appId: APP, state: 'ready', error: { error: 'setup-required', message: 'refused' } };
  const w2 = mountSetupWindow(b2, { appId: APP, appName: 'Mailer', launch, onReady: () => { r2++; } }, { fetch: api2.fetch });
  await tick();
  assert.equal(w2.element.dataset['phase'], 'refused');
  assert.equal(r2, 0);
  click(w2.element, 'open-app');
  assert.equal(r2, 1);
});

test('apply answering ready opens the app; a refusal stays in the window with its reasons', async () => {
  const body = windowBody();
  const ready: SetupOutcome = { status: 'ready', state: state({ state: 'ready' }) };
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state({ step: 'review' }))],
    [`GET ${BASE}/plan`]: [() => json(plan())],
    [`POST ${BASE}/plan`]: [() => json(plan())],
    [`POST ${BASE}/apply`]: [
      () => json({ error: 'config-invalid', category: 'invalid-request', message: 'fix the host', fieldErrors: { smtpHost: 'required' } }, 422),
      () => json(ready),
    ],
  });
  let opened = 0;
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => { opened++; } }, { fetch: api.fetch });
  await tick();
  click(w.element, 'apply');
  await tick();
  assert.equal(opened, 0);
  assert.equal(w.element.querySelector('[data-problem]')?.getAttribute('data-problem'), 'config-invalid');
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'values', 'back to the fields');
  click(w.element, 'next');
  await tick();
  click(w.element, 'next'); // requirements
  await tick();
  click(w.element, 'apply');
  await tick();
  assert.equal(opened, 1);
});

test('no secret value in the DOM or a request: secrets are vault handles, `ask` hands off', async () => {
  const body = windowBody();
  const api = fakeFetch({
    [`GET ${BASE}`]: [() => json(state())],
    [`GET ${BASE}/plan`]: [() => json(plan())],
    [`POST ${BASE}/plan`]: [() => json(plan())],
  });
  const w = mountSetupWindow(body, { appId: APP, appName: 'Mailer', launch: null, onReady: () => undefined }, { fetch: api.fetch });
  await tick();
  assert.equal(w.element.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step'), 'values');
  const html = (): string => doc.body.innerHTML;
  assert.ok(!html().includes(LEAK_MARK));
  assert.equal(w.element.querySelector('input[type="password"]'), null, 'no secret input in the wizard');
  // `ask` without a hand-off on this AuraOS: a note, no input.
  click(w.element, 'ask-secret');
  await tick();
  assert.equal(w.element.querySelector('[data-note]')?.textContent, SECRET_ASK_UNAVAILABLE);
  click(w.element, 'next');
  await tick();
  const sent = api.calls.filter((c) => c.method === 'POST');
  assert.ok(sent.length >= 1);
  for (const c of sent) assert.ok(!JSON.stringify(c.body ?? {}).includes(LEAK_MARK));
  assert.deepEqual((sent[0]!.body as { values?: unknown }).values, { smtpHost: 'mail.example' }, 'plain values only');
  assert.ok(!html().includes(LEAK_MARK));
  w.dispose();

  // With a hand-off: the owner's dialog opens on the credential.store request.
  const b2 = windowBody();
  const opened: string[] = [];
  const w2 = mountSetupWindow(b2, { appId: APP, appName: 'Mailer', launch: null, onReady: () => undefined }, {
    fetch: api.fetch, openApproval: (id) => opened.push(id), askSecret: async (_app, field) => ({ approvalId: `apr_${field}` }),
  });
  await tick();
  click(w2.element, 'ask-secret');
  await tick();
  assert.deepEqual(opened, ['apr_password']);
  w2.dispose();
});
