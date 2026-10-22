// Smart "Clear all" grouping (phase 4). DOM-free.
//
//   cd packages/shell && npx tsx --test test/notification-clear-groups.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearPlan, confirmFor, groupItems, groupOf, idsFor, inBatches, resultText } from '../src/lib/notifications/clearGroups.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const APP = { kind: 'app', id: 'a.b', attribution: 'verified' };
const OS = { kind: 'auraos', id: 'auraos', attribution: 'internal' };
const n = (id: string, over: Partial<Notification> = {}) => ({
  id, type: 'simple', title: id, text: '', priority: 'medium', visibility: 'private', pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'anonymous', verification: 'unverified' }, sender: APP, senderKey: 'app:a.b', state: 'active', createdAt: 1, updatedAt: 1, history: [],
  ...over,
}) as unknown as Notification;
const form = [{ kind: 'input', id: 'x' }] as Notification['components'];

test('grouping: order and exclusivity (locked > pinned > decisions > questions > urgent > info)', () => {
  assert.equal(groupOf(n('l', { type: 'locked', pinned: true, priority: 'urgent' })), 'locked');
  assert.equal(groupOf(n('p', { type: 'dialogue', pinned: true, priority: 'urgent' })), 'pinned', 'a pinned urgent dialogue → Pinned');
  assert.equal(groupOf(n('d', { type: 'dialogue', scope: 'desktop', sender: OS as never })), 'decisions');
  assert.equal(groupOf(n('d2', { type: 'dialogue', scope: 'desktop' })), 'questions', 'a forged desktop scope from an app is a normal question');
  assert.equal(groupOf(n('q', { type: 'dialogue', priority: 'urgent' })), 'questions');
  assert.equal(groupOf(n('f', { components: form, priority: 'high' })), 'questions', 'a Simple item with a form is a question');
  assert.equal(groupOf(n('u', { priority: 'urgent' })), 'urgent');
  assert.equal(groupOf(n('h', { priority: 'high' })), 'urgent');
  assert.equal(groupOf(n('i', { priority: 'low', components: [{ kind: 'button', id: 'b', label: 'B', variant: 'secondary' }] as Notification['components'] })), 'info', 'buttons alone are not a form');
  const g = groupItems([n('a'), n('b', { priority: 'high' }), n('c', { type: 'locked' }), n('r', { state: 'resolved' })]);
  assert.deepEqual(Object.values(g).flat().map((x) => x.id).sort(), ['a', 'b', 'c'], 'each active item in exactly one group');
});

test('info-only fast path: no menu (locked / pinned / decisions never block it)', () => {
  assert.deepEqual(clearPlan(groupItems([n('a'), n('b'), n('l', { type: 'locked' }), n('p', { pinned: true })])), { kind: 'fast', ids: ['a', 'b'] });
  assert.deepEqual(clearPlan(groupItems([n('a'), n('q', { type: 'dialogue' })])), { kind: 'menu' });
  assert.deepEqual(clearPlan(groupItems([n('a'), n('u', { priority: 'urgent' })])), { kind: 'menu' });
  assert.deepEqual(clearPlan(groupItems([n('p', { pinned: true })])), { kind: 'menu' }, 'only pinned: the menu offers its own entry');
  assert.deepEqual(clearPlan(groupItems([n('l', { type: 'locked' })])), { kind: 'nothing' });
});

test('"Clear all (except …)" covers questions, urgent and info — never locked, pinned or decisions', () => {
  const g = groupItems([n('i'), n('q', { type: 'dialogue' }), n('u', { priority: 'urgent' }), n('p', { pinned: true }), n('l', { type: 'locked' }),
    n('d', { type: 'dialogue', scope: 'desktop', sender: OS as never })]);
  assert.deepEqual(idsFor(g, 'all').sort(), ['i', 'q', 'u']);
  assert.deepEqual(idsFor(g, 'pinned'), ['p'], 'pinned clears through its own entry');
  assert.deepEqual(idsFor(g, 'locked'), []);
  assert.deepEqual(idsFor(g, 'decisions'), []);
  assert.equal(resultText(3, g), 'Cleared 3 · kept 1 locked, 1 pinned, 1 decision');
});

test('confirm needed for questions / urgent (and "all" containing them), not for info or pinned', () => {
  const g = groupItems([n('i'), n('q1', { type: 'dialogue' }), n('q2', { components: form }), n('q3', { type: 'dialogue' }), n('u', { priority: 'high' }), n('p', { pinned: true })]);
  assert.equal(confirmFor(g, 'questions'), 'Dismiss 3 open questions? Senders will be told.');
  assert.equal(confirmFor(g, 'urgent'), 'Dismiss 1 urgent / high notification?');
  assert.match(confirmFor(g, 'all')!, /^Clear 5, including 3 open questions and 1 urgent \/ high\? Senders will be told\.$/);
  assert.equal(confirmFor(g, 'info'), null);
  assert.equal(confirmFor(g, 'pinned'), null);
  assert.equal(confirmFor(groupItems([n('i')]), 'all'), null);
});

test('batches run in parallel groups of N, in order', async () => {
  const seen: string[][] = [];
  let cur: string[] = [];
  const out = await inBatches(['a', 'b', 'c', 'd', 'e'], 2, async (id) => { cur.push(id); await Promise.resolve(); if (cur.length === 2 || id === 'e') { seen.push(cur); cur = []; } return id.toUpperCase(); });
  assert.deepEqual(out, ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(seen, [['a', 'b'], ['c', 'd'], ['e']]);
});
