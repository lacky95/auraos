import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmbed } from '../src/embed.ts';

test('no embed flag: normal page, session ignored', () => {
  assert.deepEqual(parseEmbed(''), { embed: false, session: null });
  assert.deepEqual(parseEmbed('?session=com.aura.terminal-2%23a3'), { embed: false, session: null });
});

test('embed with a session id', () => {
  assert.deepEqual(parseEmbed('?embed=1&session=com.aura.terminal-2%23a3'),
    { embed: true, session: 'com.aura.terminal-2#a3' });
});

test('embed without a valid session falls back to the default session', () => {
  assert.deepEqual(parseEmbed('?embed=1'), { embed: true, session: null });
  assert.deepEqual(parseEmbed('?embed=1&session=nonsense'), { embed: true, session: null });
  assert.deepEqual(parseEmbed('?embed=true&session=com.aura.terminal-2%23a3'), { embed: false, session: null });
});
