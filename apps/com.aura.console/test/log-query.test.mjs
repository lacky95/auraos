// Reading a tail window of the JSONL log and shaping entries for the MCP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterEntries, formatEntry, formatSources, parseSince, readTailLines, summarizeSources, textMatcher,
} from '../src/log-query.ts';

const T0 = Date.UTC(2026, 9, 31, 14, 5, 3, 123);
const entry = (i, over = {}) => ({ type: 'aura.console', level: 'log', timestamp: T0 + i * 1000, source: 'shell', args: [`line ${i}`], ...over });
const dir = mkdtempSync(join(tmpdir(), 'console-log-'));
function writeLog(name, entries, extra = '') {
  const p = join(dir, name);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n' + extra);
  return p;
}

test('readTailLines returns the whole file when it fits, oldest first', () => {
  const p = writeLog('small.jsonl', [entry(0), entry(1), entry(2)]);
  const r = readTailLines(p, 1 << 20);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => e.args[0]), ['line 0', 'line 1', 'line 2']);
});

test('a window that starts mid-file drops the torn first line and flags truncation', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry(i));
  const p = writeLog('big.jsonl', entries);
  const oneLine = JSON.stringify(entry(0)).length + 1;
  const r = readTailLines(p, Math.round(oneLine * 10.5));      // lands inside a line
  assert.equal(r.truncated, true);
  assert.equal(r.entries.length, 10);
  assert.equal(r.entries.at(-1).args[0], 'line 49');
  assert.equal(r.entries[0].args[0], 'line 40');
});

test('foreign or torn lines are skipped; a missing file is an empty log', () => {
  const p = writeLog('mixed.jsonl', [entry(0)], 'not json\n{"type":"x"}\n{"type":"aura.console","level":"warn","timestamp":1,"source":"a","args":["ok"]}\n{"truncated":');
  const r = readTailLines(p, 1 << 20);
  assert.deepEqual(r.entries.map((e) => e.args[0]), ['line 0', 'ok']);
  assert.deepEqual(readTailLines(join(dir, 'nope.jsonl'), 100), { entries: [], truncated: false });
});

test('filterEntries: levels, source, substring, regex and since', () => {
  const all = [
    entry(0, { level: 'error', source: 'io.lakner.foo', args: ['Request failed: ECONNRESET'] }),
    entry(1, { level: 'warn', source: 'shell', args: ['slow', 'timeout after 5s'] }),
    entry(2, { level: 'log', source: 'io.lakner.foo', args: ['hello'] }),
  ];
  assert.deepEqual(filterEntries(all, { levels: ['error', 'warn'] }).map((e) => e.level), ['error', 'warn']);
  assert.equal(filterEntries(all, { source: 'io.lakner.foo' }).length, 2);
  assert.equal(filterEntries(all, { contains: 'TIMEOUT' }).length, 1, 'case-insensitive substring');
  assert.equal(filterEntries(all, { contains: 'lakner' }).length, 2, 'source is searchable too');
  assert.deepEqual(filterEntries(all, { contains: '/econn|timeout/' }).map((e) => e.level), ['error', 'warn']);
  assert.equal(filterEntries(all, { sinceMs: T0 + 1500 }).length, 1);
  assert.throws(() => textMatcher('/[/'), /invalid regex/);
});

test('formatEntry: ISO time, padded level, source, args joined; long args cut', () => {
  assert.equal(formatEntry(entry(0, { level: 'warn', source: 'io.lakner.foo', args: ['a', 'b'] })),
    '2026-10-31T14:05:03.123Z WARN  [io.lakner.foo] a b');
  const long = formatEntry(entry(0, { args: ['x'.repeat(5000)] }));
  assert.ok(long.length < 2200 && long.endsWith('…'));
});

test('summarizeSources counts per source and level, most recently active first', () => {
  const rows = summarizeSources([
    entry(0, { source: 'a', level: 'error' }), entry(5, { source: 'a' }),
    entry(2, { source: 'b', level: 'warn' }), entry(3, { source: 'b', level: 'warn' }),
  ]);
  assert.deepEqual(rows.map((r) => r.source), ['a', 'b']);
  assert.deepEqual(rows[0], { source: 'a', count: 2, byLevel: { error: 1, log: 1 }, firstTs: T0, lastTs: T0 + 5000 });
  assert.equal(rows[1].byLevel.warn, 2);
  const table = formatSources(rows);
  assert.deepEqual(table.split('\n'), [
    'source  count  error  warn  last',
    'a           2      1     0  2026-10-31T14:05:08.123Z',
    'b           2      0     2  2026-10-31T14:05:06.123Z',
  ]);
  assert.equal(formatSources([]), '(no entries)');
});

test('parseSince: relative, ISO, epoch ms', () => {
  const now = 1_000_000_000_000;
  assert.equal(parseSince('5m', now), now - 300_000);
  assert.equal(parseSince('2h', now), now - 7_200_000);
  assert.equal(parseSince('30s', now), now - 30_000);
  assert.equal(parseSince('1d', now), now - 86_400_000);
  assert.equal(parseSince('2026-10-31T14:05:03.123Z', now), T0);
  assert.equal(parseSince(String(T0), now), T0);
  assert.equal(parseSince(T0, now), T0);
  assert.throws(() => parseSince('yesterday-ish', now), /cannot parse since/);
});
