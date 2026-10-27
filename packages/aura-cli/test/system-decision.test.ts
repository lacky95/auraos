// `aura admin dev system-decision`: flags → the payload for the DEV hook, and
// the command is registered under `aura admin dev`. Pure — no shell needed.
//
//   pnpm --filter @aura/cli test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';
import { buildSystemDecisionPayload, describeDecision, releaseBody } from '../src/lib/system-decision.js';
import { buildProgram } from '../src/program.js';

test('payload: flags build title / text / priority / options / inputs / role buttons', () => {
  const p = buildSystemDecisionPayload({ title: 'Install update?', text: 'Restarts the shell', priority: 'urgent', options: 'Now,Tonight', inputs: 'Reason,Ticket', cancelLabel: 'Not now', submitLabel: 'Install' });
  assert.equal(p['title'], 'Install update?');
  assert.equal(p['priority'], 'urgent');
  assert.deepEqual(p['components'], [
    { kind: 'options', id: 'choice', label: 'Choose', options: [{ id: 'now', label: 'Now' }, { id: 'tonight', label: 'Tonight' }] },
    { kind: 'input', id: 'reason', label: 'Reason' },
    { kind: 'input', id: 'ticket', label: 'Ticket' },
    { kind: 'button', role: 'cancel', label: 'Not now' },
    { kind: 'button', role: 'submit', label: 'Install' },
  ]);
  assert.equal(p['scope'], undefined, 'scope is the shell\'s business (forced there)');
});

test('payload: bare --options / --inputs use defaults; > 4 options become a radio list; no flags → shell defaults', () => {
  const p = buildSystemDecisionPayload({ options: true, inputs: true });
  const comps = p['components'] as Array<Record<string, unknown>>;
  assert.deepEqual((comps[0]!['options'] as Array<{ label: string }>).map((o) => o.label), ['Allow', 'Deny', 'Ask me later']);
  assert.deepEqual(comps[1], { kind: 'input', id: 'reason', label: 'Reason' });
  const many = buildSystemDecisionPayload({ options: 'a,b,c,d,e' });
  assert.equal((many['components'] as Array<Record<string, unknown>>)[0]!['display'], 'radio');
  assert.deepEqual(buildSystemDecisionPayload({}), {}, 'the shell fills title, text, priority and Allow / Deny');
});

test('payload: --json is the base, flags override; bad input is refused with a clear error', () => {
  const p = buildSystemDecisionPayload({ json: '{"title":"From JSON","text":"t","components":[{"kind":"select","id":"s","options":[{"id":"a","label":"A"}]},{"kind":"button","role":"submit"}]}', title: 'Flag wins', submitLabel: 'Go' });
  assert.equal(p['title'], 'Flag wins');
  assert.equal(p['text'], 't');
  assert.deepEqual((p['components'] as Array<Record<string, unknown>>).map((c) => c['kind'] + ':' + (c['role'] ?? c['id'])), ['select:s', 'button:cancel', 'button:submit']);
  assert.throws(() => buildSystemDecisionPayload({ json: '{nope' }), /--json is not valid JSON/);
  assert.throws(() => buildSystemDecisionPayload({ json: '[1]' }), /JSON object/);
  assert.throws(() => buildSystemDecisionPayload({ priority: 'max' }), /--priority/);
  assert.throws(() => buildSystemDecisionPayload({ options: 'a,b,c,d,e,f,g,h,i' }), /at most 8/);
});

test('describeDecision: submitted with values, cancelled, removed, pending', () => {
  assert.equal(describeDecision({ state: 'resolved', outcome: 'submitted', answer: { buttonId: 'submit', values: { choice: 'now' } } }), 'submitted (button submit) values {"choice":"now"}');
  assert.equal(describeDecision({ state: 'resolved', outcome: 'cancelled', answer: { buttonId: 'cancel' } }), 'cancelled (button cancel)');
  assert.equal(describeDecision({ state: 'removed', removedReason: 'force-removed' }), 'removed (force-removed)');
  assert.equal(describeDecision({ state: 'active' }), 'pending');
});

test('the command is registered: aura admin dev system-decision with its flags', () => {
  const program = buildProgram();
  const admin = program.commands.find((c: Command) => c.name() === 'admin')!;
  const dev = admin.commands.find((c: Command) => c.name() === 'dev')!;
  const sd = dev.commands.find((c: Command) => c.name() === 'system-decision')!;
  assert.ok(sd, 'registered');
  const flags = sd.options.map((o) => o.long);
  for (const f of ['--title', '--text', '--priority', '--inputs', '--options', '--cancel-label', '--submit-label', '--json', '--wait']) assert.ok(flags.includes(f), f);
});

test('admin notif release: one id or --app, never both; registered', () => {
  assert.deepEqual(releaseBody('ntf_0mvk1abcdef12345', {}), { id: 'ntf_0mvk1abcdef12345' });
  assert.deepEqual(releaseBody(undefined, { app: 'com.example.x' }), { appId: 'com.example.x' });
  assert.throws(() => releaseBody('ntf_0mvk1abcdef12345', { app: 'x' }), /not both/);
  assert.throws(() => releaseBody('nope', {}), /not a notification id/);
  assert.throws(() => releaseBody(undefined, {}), /release <id>/);
  const admin = buildProgram().commands.find((c: Command) => c.name() === 'admin')!;
  const rel = admin.commands.find((c: Command) => c.name() === 'notif')!.commands.find((c: Command) => c.name() === 'release')!;
  assert.ok(rel.options.some((o) => o.long === '--app'));
});
