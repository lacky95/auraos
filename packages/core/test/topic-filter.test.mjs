// Tests for the SSE topic-glob matcher used by /api/apps/events?topics=.
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/topic-filter.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compileTopicGlob,
  compileTopicMatcher,
  parseTopicsParam,
} from '../dist/ipc/topicMatcher.js';

test('compileTopicGlob: exact match', () => {
  const re = compileTopicGlob('theme:changed');
  assert.equal(re.test('theme:changed'),     true);
  assert.equal(re.test('theme:changedx'),    false);
  assert.equal(re.test('xtheme:changed'),    false);
  assert.equal(re.test('mode:changed'),      false);
});

test('compileTopicGlob: single-star stays within one segment', () => {
  const re = compileTopicGlob('app:*');
  assert.equal(re.test('app:stateChanged'), true);
  assert.equal(re.test('app:crashed'),      true);
  assert.equal(re.test('app:'),             false);  // must consume at least one char
  assert.equal(re.test('app:foo:bar'),      false);  // colon stops the wildcard
  assert.equal(re.test('activity:opened'),  false);
});

test('compileTopicGlob: double-star crosses segments', () => {
  const re = compileTopicGlob('app:**');
  assert.equal(re.test('app:stateChanged'), true);
  assert.equal(re.test('app:foo:bar'),      true);
  assert.equal(re.test('activity:opened'),  false);
});

test('compileTopicGlob: regex metachars in pattern are escaped, not interpreted', () => {
  const re = compileTopicGlob('foo.bar+baz');
  assert.equal(re.test('foo.bar+baz'), true);
  assert.equal(re.test('fooXbar+baz'), false);  // '.' is literal, not "any"
  assert.equal(re.test('foo.barbaz'),  false);  // '+' is literal, not "one or more"
});

test('compileTopicMatcher: empty list matches nothing (caller handles "firehose")', () => {
  const m = compileTopicMatcher([]);
  assert.equal(m('app:stateChanged'), false);
  assert.equal(m('theme:changed'),    false);
});

test('compileTopicMatcher: OR across patterns', () => {
  const m = compileTopicMatcher(['app:*', 'activity:*']);
  assert.equal(m('app:stateChanged'), true);
  assert.equal(m('activity:opened'),  true);
  assert.equal(m('theme:changed'),    false);
  assert.equal(m('notification'),     false);
});

test('parseTopicsParam: null/empty → null (no filter requested)', () => {
  assert.equal(parseTopicsParam(null),       null);
  assert.equal(parseTopicsParam(undefined),  null);
  assert.equal(parseTopicsParam(''),         null);
  assert.equal(parseTopicsParam('   '),      null);
});

test('parseTopicsParam: comma-split with whitespace tolerance', () => {
  assert.deepEqual(parseTopicsParam('app:*, theme:*'),       ['app:*', 'theme:*']);
  assert.deepEqual(parseTopicsParam('app:*,,theme:*'),       ['app:*', 'theme:*']);  // drops empties
  assert.deepEqual(parseTopicsParam('  app:stateChanged  '), ['app:stateChanged']);
});
