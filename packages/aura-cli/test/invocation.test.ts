// D109 AF3: `--agent` is reserved and pre-parsed with argument boundaries;
// `--help` never runs an action; the human help is golden (the baseline of
// the Addendum's byte-identity rule).
//
//   pnpm --filter @aura/cli test     (AURA_UPDATE_GOLDEN=1 rewrites test/golden/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { buildProgram } from '../src/program.js';
import { AGENT_FLAG, EXIT_USAGE, agentUnavailableText, parseInvocation } from '../src/lib/invocation.js';
import { assertGolden } from './helpers/golden.js';

/** Every command of the tree with its path, hidden and legacy ones included. */
function walk(cmd: Command, path: string[] = []): Array<{ cmd: Command; path: string[] }> {
  const out = [{ cmd, path }];
  for (const c of cmd.commands) out.push(...walk(c, [...path, c.name()]));
  return out;
}

const quiet = (cmd: Command) => {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {}, getOutHelpWidth: () => 80, getErrHelpWidth: () => 80 });
};

test('no command defines an option named --agent (reserved, D109)', () => {
  for (const { cmd, path } of walk(buildProgram())) {
    for (const o of cmd.options) {
      assert.ok(!(o.long ?? '').startsWith(AGENT_FLAG), `aura ${path.join(' ')} defines ${o.long}`);
    }
  }
});

test('pre-parse: --agent is taken as an option only, never after -- and never as an option value', () => {
  const p = buildProgram();
  const inv = (s: string) => parseInvocation(s.split(' ').filter(Boolean), p);

  assert.deepEqual(inv('dev new com.x.y --agent'), { agent: true, help: false, path: ['dev', 'new'], args: ['dev', 'new', 'com.x.y'] });
  assert.deepEqual(inv('--agent dev new').path, ['dev', 'new']);
  assert.equal(inv('dev new --agent --help').help, true);
  assert.equal(inv('dev new --agent=yes').agentError, '--agent takes no value');

  // A literal after a bare `--` belongs to the command it runs.
  const exec = inv('exec inst com.x.y -- tool --agent --help');
  assert.equal(exec.agent, false);
  assert.equal(exec.help, false);
  assert.deepEqual(exec.args, ['exec', 'inst', 'com.x.y', '--', 'tool', '--agent', '--help']);

  // The value of an option that takes one (long and short, a root option too).
  assert.equal(inv('dev new com.x.y --description --agent').agent, false);
  assert.equal(inv('--shell-url --agent dev new').agent, false);
  assert.equal(inv('get apps -o --agent').agent, false);
  assert.equal(inv('dev new com.x.y --description=--agent').agent, false);
  // A flag that takes no value does not swallow it.
  assert.equal(inv('dev new com.x.y --force --agent').agent, true);

  // Aliases resolve the path without running anything.
  assert.deepEqual(inv('ps').path, ['ps']);
  assert.deepEqual(inv('nosuchcommand --agent').path, []);
});

test('the reserved answer names the command and runs nothing', () => {
  const p = buildProgram();
  assert.match(agentUnavailableText(parseInvocation(['dev', 'new', '--agent'], p)), /Nothing was run\.\nRun the command without --agent; `aura dev new --help`/);
  assert.equal(agentUnavailableText(parseInvocation(['--agent=1'], p)), 'error: --agent takes no value\n');
  assert.equal(EXIT_USAGE, 2);
});

test('--help never runs an action, for every command', async () => {
  const program = buildProgram();
  const all = walk(program);
  const ran: string[] = [];
  for (const { cmd, path } of all) {
    quiet(cmd);
    // Replace every action with a spy: a help request must stop before any of them.
    cmd.action(() => { ran.push(path.join(' ')); });
  }
  for (const { path } of all) {
    for (const flag of ['--help', '-h']) {
      await assert.rejects(program.parseAsync([...path, flag], { from: 'user' }), (err: { code?: string }) => {
        assert.equal(err.code, 'commander.helpDisplayed', `aura ${path.join(' ')} ${flag}: ${String(err.code)}`);
        return true;
      });
    }
  }
  assert.deepEqual(ran, []);
});

test('golden: the human help of every command is unchanged (D109 Addendum baseline)', () => {
  const program = buildProgram();
  const help: Record<string, string> = {};
  for (const { cmd, path } of walk(program)) {
    quiet(cmd);
    help[['aura', ...path].join(' ')] = cmd.helpInformation();
  }
  assertGolden('human-help.json', help);
});

test('the built aura answers --agent with exit 2 and runs nothing (when dist/aura.cjs exists)', (t) => {
  const bin = join(__dirname, '..', 'dist', 'aura.cjs');
  if (!existsSync(bin)) { t.skip('dist/aura.cjs not built'); return; }
  const env = { ...process.env, AURA_SHELL_URL: 'http://127.0.0.1:9' };
  const r = spawnSync(process.execPath, [bin, 'dev', 'new', 'com.example.reserved', '--non-interactive', '--agent'], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(r.status, EXIT_USAGE, r.stderr);
  assert.match(r.stderr, /Nothing was run/);
  assert.equal(r.stdout, '');
  const lit = spawnSync(process.execPath, [bin, 'dev', 'new', '--help'], { encoding: 'utf8', env, timeout: 20_000 });
  assert.equal(lit.status, 0);
  assert.match(lit.stdout, /Usage: aura dev new/);
});
