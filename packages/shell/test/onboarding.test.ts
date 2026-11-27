// Onboarding cards: step rendering, progress, buttons. DOM-free; the
// rendered components are checked against core's real notification schema.
//
//   cd packages/shell && npx tsx --test test/onboarding.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { CreateInputSchema, parseCapabilityRegistry } from '@aura/core';
import {
  HIDE_BUTTON_ID, WELCOME_STEPS, appForButton, failedSteps, isSettled, openButtonId,
  renderSetupChecklist, renderWelcome, setupHeadline, setupProgress, welcomeAgents,
  type SetupStep, type WelcomeStepId, type WelcomeTarget,
} from '../src/lib/onboarding/steps.ts';

const step = (over: Partial<SetupStep> & Pick<SetupStep, 'id' | 'status'>): SetupStep => ({ label: over.id, ...over });
const ALL: ReadonlySet<WelcomeTarget> = new Set(['terminal', 'settings', 'docs']);

test('setup progress counts settled steps and a running step’s own fraction', () => {
  const steps = [
    step({ id: 'image', status: 'running', progress: 0.5 }),
    step({ id: 'sdk', status: 'done' }),
    step({ id: 'docs', status: 'pending' }),
    step({ id: 'docs', status: 'warn', optional: true }),
  ];
  assert.equal(setupProgress(steps), (0.5 + 1 + 0 + 1) / 4);
  assert.equal(setupProgress([]), null);
});

test('an optional step that fails does not block "ready", a required one does', () => {
  const sdk = step({ id: 'sdk', status: 'failed', optional: true });
  const docs = step({ id: 'docs', status: 'failed' });
  assert.equal(isSettled(sdk), true);
  assert.equal(isSettled(docs), false);
  assert.deepEqual(failedSteps([sdk, docs]).map((s) => s.id), ['docs']);
});

test('the setup checklist shows one line per step with status and detail', () => {
  const md = renderSetupChecklist([
    step({ id: 'image', label: 'App image', status: 'done' }),
    step({ id: 'sdk', label: 'App registry and SDK', status: 'failed', detail: 'the registry did not answer\nwithin 90 s' }),
  ]);
  assert.equal(md, '- ✅ **App image**\n- ❌ **App registry and SDK** — the registry did not answer within 90 s');
});

test('welcome: open steps get one button per distinct app, in checklist order, plus Hide', () => {
  const v = renderWelcome(new Set(), ALL);
  assert.equal(v.allDone, false);
  const buttons = v.components.filter((c) => c.kind === 'button').map((c) => c.id);
  assert.deepEqual(buttons, [openButtonId('terminal'), openButtonId('settings'), openButtonId('docs'), HIDE_BUTTON_ID]);
  assert.match(v.text, /0 of 5 done/);
});

test('welcome: done steps are checked off and their app button goes away', () => {
  const done = new Set<WelcomeStepId>(['theme', 'docs']);
  const v = renderWelcome(done, ALL);
  const md = v.components.find((c) => c.kind === 'markdown');
  assert.ok(md && md.kind === 'markdown');
  assert.match(md.text, /- \[x\] ~~Pick a theme~~/);
  assert.match(md.text, /- \[ \] \*\*Install an AI agent\*\*/);
  assert.deepEqual(v.components.filter((c) => c.kind === 'button').map((c) => c.id), ['open-terminal', HIDE_BUTTON_ID]);
  assert.match(v.text, /2 of 5 done/);
});

test('welcome: the agent steps name the registry\'s agent CLIs (tags: [agent]), none in code', () => {
  const agents = welcomeAgents({
    'agent-a': { source: 'npm', package: 'a', binary: 'a', tags: ['agent'], login_probe: ['.a/creds.json'] },
    jq: { source: 'apt', package: 'jq', binary: 'jq' },
    'agent-b': { source: 'npm', package: 'b', tags: ['agent'] },
  });
  assert.deepEqual(agents, [
    { cap: 'agent-a', binary: 'a', loginProbe: ['.a/creds.json'] },
    { cap: 'agent-b', binary: 'agent-b', loginProbe: [] },
  ]);
  const md = (v: ReturnType<typeof renderWelcome>) => { const c = v.components.find((x) => x.kind === 'markdown'); return c && c.kind === 'markdown' ? c.text : ''; };
  const text = md(renderWelcome(new Set(), ALL, agents));
  assert.match(text, /\*\*Install an AI agent\*\* — In the Terminal: `aura cap install agent-a` \(or `agent-b`\)\./);
  assert.match(text, /\*\*Log in to your agent\*\* — Run `a` \(or `agent-b`\) in the Terminal and sign in\./);
  // No agent in the registry: still a how-to, without a product name.
  const none = md(renderWelcome(new Set(), ALL));
  assert.match(none, /`aura get caps` lists the tools you can install/);
  assert.match(none, /Run your agent in the Terminal/);
});

test('welcome: the release registry keeps today\'s agent steps (claude, codex and their login files)', () => {
  const registry = parseCapabilityRegistry(parseYaml(readFileSync(new URL('../../../.aura/capabilities.yaml', import.meta.url), 'utf8')));
  const agents = welcomeAgents(registry);
  assert.deepEqual(agents, [
    { cap: 'claude', binary: 'claude', loginProbe: ['.claude/.credentials.json'] },
    { cap: 'codex', binary: 'codex', loginProbe: ['.codex/auth.json'] },
  ]);
  const c = renderWelcome(new Set(), ALL, agents).components.find((x) => x.kind === 'markdown');
  assert.ok(c && c.kind === 'markdown');
  assert.ok(c.text.includes('In the Terminal: `aura cap install claude` (or `codex`).'));
  assert.ok(c.text.includes('Run `claude` (or `codex`) in the Terminal and sign in. The login follows you into every app.'));
});

test('welcome: no button for an app that is not installed or disabled', () => {
  const v = renderWelcome(new Set(), new Set<WelcomeTarget>(['terminal']));
  assert.deepEqual(v.components.filter((c) => c.kind === 'button').map((c) => c.id), ['open-terminal', HIDE_BUTTON_ID]);
});

test('welcome: all done', () => {
  const v = renderWelcome(new Set(WELCOME_STEPS.map((s) => s.id)), ALL);
  assert.equal(v.allDone, true);
  assert.deepEqual(v.components, []);
});

test('button ids map back to the app they open', () => {
  assert.equal(appForButton('open-terminal'), 'com.aura.terminal');
  assert.equal(appForButton('open-settings'), 'com.aura.settings');
  assert.equal(appForButton('open-docs'), 'com.aura.docs');
  assert.equal(appForButton(HIDE_BUTTON_ID), null);
  assert.equal(appForButton('open-nope'), null);
  assert.equal(appForButton(undefined), null);
});

test('the cards are valid notifications for core’s schema', () => {
  const welcome = renderWelcome(new Set(['agent']), ALL);
  assert.doesNotThrow(() => CreateInputSchema.parse({
    type: 'simple', pinned: true, visibility: 'public', priority: 'medium',
    context: { kind: 'task', id: 'onboarding', label: 'Getting started' },
    title: welcome.title, text: welcome.text, components: welcome.components,
  }));
  const steps = [step({ id: 'image', label: 'App image', status: 'running', progress: 0.25, detail: 'Step 2 of 4: RUN apt-get …' })];
  assert.doesNotThrow(() => CreateInputSchema.parse({
    type: 'locked', pinned: true, visibility: 'public', priority: 'high',
    context: { kind: 'installation', id: 'auraos-setup', label: 'AuraOS setup' },
    title: 'Setting up AuraOS', text: '…',
    components: [
      { kind: 'markdown', id: 'steps', text: renderSetupChecklist(steps) },
      { kind: 'progress', id: 'progress', value: setupProgress(steps), label: 'App image' },
    ],
  }));
});

test('setup card: medium priority while running, urgent only when the app image fails', () => {
  const running = [step({ id: 'image', status: 'running', progress: 0.5 }), step({ id: 'sdk', status: 'pending', optional: true })];
  const h = setupHeadline(running, { firstBoot: true, settled: false });
  assert.equal(h.phase, 'running');
  assert.equal(h.priority, 'medium');
  assert.match(setupHeadline(running, { firstBoot: false, settled: false }).text, /rebuilding the image/);

  const imageFailed = [step({ id: 'image', label: 'App image', status: 'failed' })];
  const f = setupHeadline(imageFailed, { firstBoot: true, settled: false });
  assert.equal(f.phase, 'failed');
  assert.equal(f.priority, 'urgent');
  assert.match(f.text, /App image failed/);
});

test('setup card: failed optional steps (SDK, docs) still end in "ready", with a warning', () => {
  const steps = [
    step({ id: 'image', label: 'App image', status: 'done' }),
    step({ id: 'sdk', label: 'App registry and SDK', status: 'failed', optional: true }),
    step({ id: 'docs', label: 'Aura Docs', status: 'warn', optional: true }),
  ];
  assert.ok(steps.every(isSettled));
  const h = setupHeadline(steps, { firstBoot: true, settled: true });
  assert.equal(h.phase, 'ready');
  assert.equal(h.priority, 'medium');
  assert.match(h.text, /App registry and SDK, Aura Docs/);
  assert.equal(setupHeadline([step({ id: 'image', status: 'done' })], { firstBoot: true, settled: true }).text, 'Setup is finished.');
});
