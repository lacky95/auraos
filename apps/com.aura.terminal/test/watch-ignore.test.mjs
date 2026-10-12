// TM-5: files a shell's programs write inside the app tree (dotfiles,
// dot-dirs of program state, logs, a tmux socket dir) must not reach Vite's watcher — a change
// there used to reload or restart the dev server under every live session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWriteIgnore } from '../watch-ignore.mjs';

const ROOT = '/workspace/apps/com.aura.terminal';
const ignored = shellWriteIgnore(ROOT);
const at = (p) => ignored(`${ROOT}/${p}`);

test('ignores what shells and agents write into the tree', () => {
  for (const p of [
    '.claude', '.claude/settings.local.json', '.claude.json', '.claude.json.backup',
    '.bash_history', '.viminfo', 'src/.foo.ts.swp', '.cache/x', '.config/gh/hosts.yml', '.npm/_logs/a.log',
    'debug.log', 'src/pty.log', 'tmux-0', 'tmux-0/default', '.lesshst', '.node_repl_history',
  ]) assert.equal(at(p), true, p);
});

test('keeps watching the source, config and Astro’s own files', () => {
  for (const p of ['', 'src/pty-server.ts', 'src/pages/index.astro', 'astro.config.mjs', 'tmux.conf',
    'package.json', '.astro/types.d.ts', '.env', '.env.local', 'src/catalog.ts', 'src/logo.svg']) {
    assert.equal(at(p), false, p);
  }
  assert.equal(ignored(ROOT), false, 'the root itself');
});

test('paths outside the root are never ignored by this rule', () => {
  assert.equal(ignored('/home/aura/.claude/x.json'), false);
  assert.equal(ignored('/workspace/packages/app-sdk/src/index.ts'), false);
});

test('a root under a dot directory does not ignore everything', () => {
  const f = shellWriteIgnore('/home/u/.aura/apps/com.aura.terminal');
  assert.equal(f('/home/u/.aura/apps/com.aura.terminal/src/pty-server.ts'), false);
  assert.equal(f('/home/u/.aura/apps/com.aura.terminal/.claude/x'), true);
});

test('relative paths are taken relative to the root', () => {
  assert.equal(ignored('.claude/x'), true);
  assert.equal(ignored('src/a.ts'), false);
});
