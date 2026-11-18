/**
 * Flight notices: the pure view logic of lib/flight/notice.ts — level/count
 * precedence over the badge, the one-shot blink only when `at` changes (never
 * on a first paint / restore), and the text bubble's ttl.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeView, NOTICE_TTL_DEFAULT, NOTICE_BLINK_DEFAULT } from '../src/lib/flight/notice.ts';

test('no notice: the badge count shows, nothing else', () => {
  assert.deepEqual(noticeView(undefined, 4, 0, 1000), { level: null, count: 4, text: null, showText: false, blinkTimes: 0, textUntil: null });
  assert.equal(noticeView(null, 0, 0, 1000).count, null);
});

test('a notice colours by level and its count wins over the badge count', () => {
  const v = noticeView({ level: 'attention', count: 2, at: 500 }, 9, 0, 600);
  assert.equal(v.level, 'attention');
  assert.equal(v.count, 2);
  const noCount = noticeView({ level: 'urgent', at: 500 }, 9, 0, 600);
  assert.equal(noCount.count, 9);
});

test('blink only when `at` changed since the last paint; never on the first paint', () => {
  assert.equal(noticeView({ level: 'info', at: 500 }, undefined, null, 600).blinkTimes, 0);      // first paint / restored
  assert.equal(noticeView({ level: 'info', at: 500 }, undefined, 500, 600).blinkTimes, 0);       // unchanged
  assert.equal(noticeView({ level: 'info', at: 700 }, undefined, 500, 800).blinkTimes, NOTICE_BLINK_DEFAULT);
  assert.equal(noticeView({ level: 'info', at: 700, blink: 1 }, undefined, 500, 800).blinkTimes, 1);
  assert.equal(noticeView({ level: 'info', at: 700, blink: 0 }, undefined, 500, 800).blinkTimes, 0);
});

test('the text bubble lives for ttlMs (default 6 s) from `at`', () => {
  const n = { level: 'attention' as const, text: ' Koch: hi ', at: 10_000 };
  const during = noticeView(n, undefined, 0, 12_000);
  assert.equal(during.text, 'Koch: hi');
  assert.equal(during.showText, true);
  assert.equal(during.textUntil, 10_000 + NOTICE_TTL_DEFAULT);
  const after = noticeView(n, undefined, 0, 10_000 + NOTICE_TTL_DEFAULT + 1);
  assert.equal(after.showText, false);
  assert.equal(after.textUntil, null);
  assert.equal(noticeView({ ...n, ttlMs: 1000 }, undefined, 0, 11_500).showText, false);
  assert.equal(noticeView({ level: 'info', at: 10_000 }, undefined, 0, 10_001).showText, false); // no text
});
