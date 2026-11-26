// Phase 5 stream R: `aura runtime` (commands/runtime.ts) and `aura dev new`'s
// runtime choice (commands/dev.ts): `key=value` parsing, the list rows and
// the capability wording, and that a new app's manifest names no runtime
// unless one was chosen (it follows the Runtime Settings default, Q18).
//
//   pnpm --filter @aura/cli test   (via node tools/run-tests.mjs --only=aura-cli)
import './helpers/dev-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { capabilityText, parseAssignments, registerRuntime, runtimeRows, type RuntimesState } from '../src/commands/runtime.js';
import { manifestFromConfig, registerDev } from '../src/commands/dev.js';

test('set: key=value pairs, values kept as strings for the schema', () => {
  assert.deepEqual(parseAssignments(['placement=master', 'groups=a,b', 'x=']), { placement: 'master', groups: 'a,b', x: '' });
  assert.throws(() => parseAssignments(['placement']), /expected <key>=<value>/);
  assert.throws(() => parseAssignments(['=master']), /expected <key>=<value>/);
});

test('capabilities read for people: a missing fail-closed one says so', () => {
  assert.equal(capabilityText('privateHomeSession', false), 'no, fails closed');
  assert.equal(capabilityText('readOnlyBinds', false), 'no, fails closed');
  assert.equal(capabilityText('sidecars', false), 'no');
  assert.equal(capabilityText('mounts', true), 'yes');
  assert.equal(capabilityText('isolation', 'ptrace'), 'ptrace');
});

test('ls rows: enabled, default, health, apps and instances per runtime', () => {
  const s = {
    default: 'container', trusted: true, useProotEnv: 'true', overrides: [], pending: [], migration: { d75: null },
    runtimes: [
      { id: 'container', title: 'Container', isDefault: true, enabled: true, health: { status: 'ok' }, instances: [{}] },
      { id: 'proot', title: 'PRoot', isDefault: false, enabled: false, health: { status: 'unavailable' }, instances: [] },
    ],
    installations: [
      { appId: 'a', runtime: 'container' }, { appId: 'b', runtime: 'container' }, { appId: 'c', runtime: 'proot', error: { code: 'x', message: 'y' } },
    ],
  } as unknown as RuntimesState;
  const rows = runtimeRows(s);
  assert.deepEqual(rows.map((r) => [r['RUNTIME'], r['APPS'], r['INSTANCES']]), [['container', '2', '1'], ['proot', '0', '0']]);
  assert.match(rows[0]!['DEFAULT']!, /\*/);
  assert.match(rows[1]!['HEALTH']!, /unavailable/);
});

test('the command tree: ls, show, set, enable, disable, default, check, override ls|rm, migrate', () => {
  const program = new Command();
  registerRuntime(program);
  const rt = program.commands.find((c) => c.name() === 'runtime')!;
  assert.deepEqual(rt.commands.map((c) => c.name()).sort(),
    ['check', 'default', 'disable', 'enable', 'ls', 'migrate', 'override', 'set', 'show']);
  assert.deepEqual(rt.commands.find((c) => c.name() === 'override')!.commands.map((c) => c.name()).sort(), ['ls', 'rm']);
});

test('dev new writes no sandbox unless one is chosen; --sandbox has no default', () => {
  const base = { appId: 'com.example.hello', name: 'Hello', shape: 'activity' as const, instanceMode: 'single' as const, tools: [], scope: 'user' as const };
  assert.equal('sandbox' in manifestFromConfig(base), false, 'follows the Runtime Settings default');
  assert.equal(manifestFromConfig({ ...base, sandbox: 'proot' })['sandbox'], 'proot');
  assert.equal(manifestFromConfig({ ...base, sandbox: 'container' })['sandbox'], 'container');
  const program = new Command();
  registerDev(program);
  const dnew = program.commands.find((c) => c.name() === 'dev')!.commands.find((c) => c.name() === 'new')!;
  const opt = dnew.options.find((o) => o.long === '--sandbox')!;
  assert.equal(opt.defaultValue, undefined);
});
