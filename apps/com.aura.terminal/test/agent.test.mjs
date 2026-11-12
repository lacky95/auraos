// Agent awareness: hook events → per-session agent state (agent-state.ts),
// and the hook installer's merges + the hook script itself (agent-hooks.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduce, parseEventBody, recordEvent, agentFor, forgetAgent, subscribeAgents } from '../src/agent-state.ts';
import {
  HOOK_MARK, HOOK_SCRIPT, addClaudeHooks, removeClaudeHooks, claudeHooksInstalled,
  addCodexNotify, removeCodexNotify, codexNotifyInstalled, installHooks, uninstallHooks, hookStatus,
} from '../src/agent-hooks.ts';

const claude = (payload, at = 1) => ({ source: 'claude', payload, at });

test('claude turn: prompt → tool → permission → tool → stop', () => {
  let s = reduce(null, claude({ hook_event_name: 'SessionStart', session_id: 'c1', cwd: '/w' }, 1));
  assert.equal(s.status, 'idle'); assert.equal(s.agentSessionId, 'c1'); assert.equal(s.cwd, '/w');
  s = reduce(s, claude({ hook_event_name: 'UserPromptSubmit' }, 2));
  assert.equal(s.status, 'running'); assert.equal(s.since, 2);
  s = reduce(s, claude({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, 3));
  assert.equal(s.tool, 'Bash'); assert.equal(s.since, 2, 'still running: since unchanged');
  s = reduce(s, claude({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }, 4));
  assert.equal(s.status, 'needs_approval'); assert.equal(s.tool, 'Bash'); assert.match(s.message, /permission/);
  s = reduce(s, claude({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 5));
  assert.equal(s.status, 'running'); assert.equal(s.message, null);
  s = reduce(s, claude({ hook_event_name: 'Stop' }, 6));
  assert.equal(s.status, 'idle'); assert.equal(s.tool, null);
  s = reduce(s, claude({ hook_event_name: 'SessionEnd' }, 7));
  assert.equal(s.status, 'exited');
});

test('notification_type decides over message wording', () => {
  assert.equal(reduce(null, claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'permission?' })).status, 'waiting_input');
  assert.equal(reduce(null, claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' })).status, 'needs_approval');
  assert.equal(reduce(null, claude({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })).status, 'waiting_input');
});

test('codex turn complete; unknown events change nothing', () => {
  const s = reduce(null, { source: 'codex', payload: { type: 'agent-turn-complete', 'thread-id': 't1' }, at: 1 });
  assert.equal(s.status, 'idle'); assert.equal(s.source, 'codex'); assert.equal(s.agentSessionId, 't1');
  assert.equal(reduce(s, { source: 'codex', payload: { type: 'other' }, at: 2 }), s);
  assert.equal(reduce(null, claude({ hook_event_name: 'PreCompact' })), null);
});

test('parseEventBody validates', () => {
  const ok = parseEventBody({ session: 'com.aura.terminal-2#a3', source: 'claude', payload: {} }, 9);
  assert.equal(ok.session, 'com.aura.terminal-2#a3'); assert.equal(ok.event.at, 9);
  assert.throws(() => parseEventBody({ session: 'x', source: 'claude', payload: {} }, 0), /session/);
  assert.throws(() => parseEventBody({ session: 'a#b', source: 'gpt', payload: {} }, 0), /source/);
  assert.throws(() => parseEventBody({ session: 'a#b', source: 'codex', payload: [] }, 0), /payload/);
});

test('store: record, notify listeners on change only, forget', () => {
  const seen = [];
  const off = subscribeAgents((c) => seen.push(c));
  recordEvent('t-1#a1', claude({ hook_event_name: 'UserPromptSubmit' }));
  recordEvent('t-1#a1', claude({ hook_event_name: 'PreCompact' }));   // ignored event
  assert.equal(agentFor('t-1#a1').status, 'running');
  forgetAgent('t-1#a1');
  off();
  assert.equal(agentFor('t-1#a1'), null);
  assert.deepEqual(seen.map((c) => c.agent?.status ?? null), ['running', null]);
});

test('claude hooks merge: idempotent, keeps foreign hooks, removable', () => {
  const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, model: 'opus' };
  const once = addClaudeHooks(foreign, '/h/.local/share/aura-terminal/agent-hook.sh');
  const twice = addClaudeHooks(once, '/h/.local/share/aura-terminal/agent-hook.sh');
  assert.deepEqual(twice, once);
  assert.ok(claudeHooksInstalled(once));
  assert.equal(once.hooks.Stop.length, 2);
  assert.equal(once.model, 'opus');
  assert.deepEqual(removeClaudeHooks(once), foreign);
  assert.deepEqual(removeClaudeHooks(addClaudeHooks({}, '/s/' + HOOK_MARK)), {});
});

test('codex notify: top-level insert, replace ours, refuse foreign', () => {
  const script = '/h/.local/share/aura-terminal/agent-hook.sh';
  const base = 'model = "o4"\n\n[profiles.x]\nnotify = "not top level"\n';
  const r = addCodexNotify(base, script);
  assert.equal(r.conflict, null);
  assert.ok(r.toml.startsWith('notify = ["bash", '));
  assert.ok(codexNotifyInstalled(r.toml));
  assert.equal(addCodexNotify(r.toml, script).toml, r.toml);
  assert.equal(removeCodexNotify(r.toml), base);
  const foreign = 'notify = ["notify-send"]\n';
  assert.equal(addCodexNotify(foreign, script).conflict, 'notify = ["notify-send"]');
  assert.equal(removeCodexNotify(foreign), foreign);
});

test('install / uninstall on disk, with backups', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-hooks-'));
  const paths = { script: join(home, 's', HOOK_MARK), claude: join(home, 'c/settings.json'), codex: join(home, 'x/config.toml') };
  let st = installHooks(paths);
  assert.deepEqual([st.script, st.claude, st.codex, st.codexConflict], [true, true, true, null]);
  st = uninstallHooks(paths);
  assert.deepEqual([st.claude, st.codex], [false, false]);
  assert.deepEqual(JSON.parse(readFileSync(paths.claude, 'utf-8')), {});
  assert.equal(hookStatus(paths).script, true);
});

test('hook script posts the event and never blocks or fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hook-'));
  const script = join(dir, 'agent-hook.sh');
  writeFileSync(script, HOOK_SCRIPT);
  const got = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const run = (args, input, env) => new Promise((resolve) => {
    const p = spawn('bash', [script, ...args], { env: { PATH: process.env.PATH, OS_API_BASE: base, ...env } });
    p.stdin.end(input);
    p.on('exit', (code) => resolve(code));
  });

  assert.equal(await run(['claude'], '{"hook_event_name":"Stop"}', { AURA_TERM_SESSION: 'com.aura.terminal-2#a3' }), 0);
  assert.equal(await run(['codex', '{"type":"agent-turn-complete"}'], '', { AURA_TERM_SESSION: 'com.aura.terminal-2#a3' }), 0);
  assert.equal(await run(['claude'], '{"hook_event_name":"Stop"}', {}), 0, 'outside a terminal session: silent no-op');
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  server.close();

  assert.equal(got.length, 2);
  assert.equal(got[0].url, '/api/proxy/com.aura.terminal-2/api/sessions/events');
  const bodies = got.map((g) => g.body).sort((a, b) => a.source.localeCompare(b.source));
  assert.deepEqual(bodies[0], { session: 'com.aura.terminal-2#a3', source: 'claude', payload: { hook_event_name: 'Stop' } });
  assert.deepEqual(bodies[1], { session: 'com.aura.terminal-2#a3', source: 'codex', payload: { type: 'agent-turn-complete' } });

  // Endpoint down: still exits 0 promptly.
  const t0 = Date.now();
  const r = spawnSync('bash', [script, 'claude'], {
    input: '{}', env: { PATH: process.env.PATH, OS_API_BASE: 'http://127.0.0.1:1', AURA_TERM_SESSION: 'x-1#a1' },
  });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 1500);
});
