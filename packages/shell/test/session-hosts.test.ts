// Audit N2 (5b): the system app ids are the kernel's (core system/systemApps.ts,
// `@aura/core/system-apps`). The shell keeps one dependency-free copy
// (server/session-hosts.mjs) for code that loads from a bare checkout (the
// security gate's route audit); this keeps the two equal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '@aura/core/system-apps';
import * as shell from '../server/session-hosts.mjs';

test('the shell\'s system app ids equal the kernel\'s', () => {
  assert.equal(shell.TERMINAL_APP_ID, kernel.TERMINAL_APP_ID);
  assert.equal(shell.AURASHELLD_APP_ID, kernel.AURASHELLD_APP_ID);
  assert.equal(shell.SETTINGS_APP_ID, kernel.SETTINGS_APP_ID);
  // D107 S1: the kernel's one predicate; the shell's app-keyed copy names the same session hosts.
  for (const appId of ['com.aura.terminal', 'com.aura.aurashelld', 'com.aura.settings', 'com.aura.terminalx', 'io.x', ...shell.SESSION_HOST_APPS]) {
    assert.equal(shell.SESSION_HOST_APPS.has(appId), kernel.isUserEnvironment({ appId }), appId);
  }
  assert.deepEqual([...shell.OWNER_AGENT_APPS].sort(), [...kernel.OWNER_AGENT_APP_IDS].sort());
  for (const [id, app] of [['com.aura.terminal-2', 'com.aura.terminal'], ['com.aura.terminal', 'com.aura.terminal'],
    ['com.aura.terminalx-1', 'com.aura.terminal'], ['io.x-1', 'com.aura.terminal']] as const) {
    assert.equal(shell.isInstanceIdOf(id, app), kernel.isInstanceIdOf(id, app), id);
  }
});
