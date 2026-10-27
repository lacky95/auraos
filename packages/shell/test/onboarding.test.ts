// Onboarding cards: step rendering, progress, buttons. DOM-free; the
// rendered components are checked against core's real notification schema.
//
//   cd packages/shell && npx tsx --test test/onboarding.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateInputSchema } from '@aura/core';
import {
  HIDE_BUTTON_ID, WELCOME_STEPS, appForButton, failedSteps, isSettled, openButtonId,
  renderSetupChecklist, renderWelcome, setupProgress,
  type SetupStep, type WelcomeStepId, type WelcomeTarget,
} from '../src/lib/onboarding/steps.ts';

const step = (over: Partial<SetupStep> & Pick<SetupStep, 'id' | 'status'>): SetupStep => ({ label: over.id, ...over });
const ALL: ReadonlySet<WelcomeTarget> = new Set(['terminal', 'settings', 'docs']);

test('setup progress counts settled steps and a running step’s own fraction', () => {
  const steps = [
    step({ id: 'image', status: 'running', progress: 0.5 }),
    step({ id: 'sdk', status: 'done' }),
    step({ id: 'docs', status: 'pending' }),
    step({ id: 'speech', status: 'warn', optional: true }),
  ];
  assert.equal(setupProgress(steps), (0.5 + 1 + 0 + 1) / 4);
  assert.equal(setupProgress([]), null);
});

test('an optional step that fails does not block "ready", a required one does', () => {
  const speech = step({ id: 'speech', status: 'failed', optional: true });
  const docs = step({ id: 'docs', status: 'failed' });
  assert.equal(isSettled(speech), true);
  assert.equal(isSettled(docs), false);
  assert.deepEqual(failedSteps([speech, docs]).map((s) => s.id), ['docs']);
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
  assert.deepEqual(buttons, [openButtonId('settings'), openButtonId('terminal'), openButtonId('docs'), HIDE_BUTTON_ID]);
  assert.match(v.text, /0 of 6 done/);
});

test('welcome: done steps are checked off and their app button goes away', () => {
  const done = new Set<WelcomeStepId>(['admin', 'theme', 'docs']);
  const v = renderWelcome(done, ALL);
  const md = v.components.find((c) => c.kind === 'markdown');
  assert.ok(md && md.kind === 'markdown');
  assert.match(md.text, /- \[x\] ~~Unlock admin~~/);
  assert.match(md.text, /- \[ \] \*\*Install an AI agent\*\*/);
  assert.deepEqual(v.components.filter((c) => c.kind === 'button').map((c) => c.id), ['open-terminal', HIDE_BUTTON_ID]);
  assert.match(v.text, /3 of 6 done/);
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
