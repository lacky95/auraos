// Stream T: a session host's lifecycle token comes as a one-time file, never in its env (app-sdk lifecycle-secret).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleSecret, takeSecretFile } from '../dist/lifecycle-secret.js';

const KEY = Symbol.for('aura.lifecycle.secret');

test('the one-time file is read once and removed; the value stays in memory only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-ls-'));
  try {
    delete globalThis[KEY];
    const file = join(dir, 'lifecycle-token');
    writeFileSync(file, 'lt-file-1\n', { mode: 0o400 });
    const env = { AURA_LIFECYCLE_TOKEN_FILE: file };
    assert.equal(lifecycleSecret(env), 'lt-file-1');
    assert.equal(existsSync(file), false, 'removed right after it was read');
    assert.equal(lifecycleSecret(env), 'lt-file-1', 'later calls: from memory');
    assert.equal(lifecycleSecret({ AURA_LIFECYCLE_TOKEN: 'lt-env' }), 'lt-env', 'an ordinary app: its env');
  } finally {
    delete globalThis[KEY];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file, an emptied one, or a symlink: nothing (never follows a link)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-ls-'));
  try {
    delete globalThis[KEY];
    assert.equal(lifecycleSecret({}), undefined);
    assert.equal(lifecycleSecret({ AURA_LIFECYCLE_TOKEN_FILE: join(dir, 'missing') }), undefined);
    const target = join(dir, 'target');
    writeFileSync(target, 'not-the-token');
    const link = join(dir, 'link');
    symlinkSync(target, link);
    assert.equal(takeSecretFile(link), '', 'O_NOFOLLOW');
    assert.equal(existsSync(link), false, 'the link itself is removed');
    assert.equal(existsSync(target), true, 'its target untouched');
  } finally {
    delete globalThis[KEY];
    rmSync(dir, { recursive: true, force: true });
  }
});
