/**
 * Agent hooks — make coding agents report what they do to the terminal
 * session they run in (agent-state.ts), so any app can react to it.
 *
 * One small script, written into the SHARED home (so it is there in every
 * sandbox `aura jump` lands in), is registered as:
 *   • Claude Code hooks in ~/.claude/settings.json (SessionStart,
 *     UserPromptSubmit, Pre/PostToolUse, Notification, Stop, SessionEnd);
 *   • Codex's `notify` program in ~/.codex/config.toml (finished turns).
 *
 * The script posts `{ session: $AURA_TERM_SESSION, source, payload }` to
 * `/api/sessions/events` on the instance the session lives on, in the
 * background with a 2s cap, and always exits 0 — an agent outside a terminal
 * session, or with the terminal down, is never slowed or blocked.
 *
 * Install is explicit (POST /api/agent-hooks), idempotent, backs up each file
 * it changes, and never overwrites a Codex `notify` someone else set. Our
 * entries are recognised by the script path, so uninstall removes only them.
 *
 * The merge functions are pure; the I/O wrappers are at the bottom.
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_MARK = 'aura-terminal/agent-hook.sh';

export const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
] as const;

export const HOOK_SCRIPT = `#!/usr/bin/env bash
# AuraOS terminal agent hook (installed by com.aura.terminal, see agent-hooks.ts).
# Reports a coding agent's hook event to the terminal session it runs in.
#   Claude Code: agent-hook.sh claude      (event JSON on stdin)
#   Codex:       agent-hook.sh codex JSON  (notify passes the JSON as an argument)
# Never blocks the agent: background post, 2s cap, always exit 0.
src="\${1:-claude}"
if [ "$src" = codex ]; then payload="\${2:-}"; else payload="$(cat)"; fi
[ -n "\${AURA_TERM_SESSION:-}" ] && [ -n "$payload" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
inst="\${AURA_TERM_SESSION%%#*}"
base="\${OS_API_BASE:-http://localhost:3000}"
printf '{"session":"%s","source":"%s","payload":%s}' "$AURA_TERM_SESSION" "$src" "$payload" \\
  | curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- \\
      "$base/api/proxy/$inst/api/sessions/events" >/dev/null 2>&1 &
exit 0
`;

export interface HookPaths { script: string; claude: string; codex: string }

export function defaultPaths(home = homedir()): HookPaths {
  return {
    script: join(home, '.local/share', HOOK_MARK),
    claude: join(home, '.claude/settings.json'),
    codex:  join(home, '.codex/config.toml'),
  };
}

type Json = Record<string, unknown>;
interface HookGroup { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }

const isOurs = (g: HookGroup): boolean => (g.hooks ?? []).some((h) => (h.command ?? '').includes(HOOK_MARK));

/** Claude settings with our hook on every event (exactly once). */
export function addClaudeHooks(settings: Json, script: string): Json {
  const hooks = { ...((settings['hooks'] as Json | undefined) ?? {}) };
  for (const ev of CLAUDE_EVENTS) {
    const groups = ((hooks[ev] as HookGroup[] | undefined) ?? []).filter((g) => !isOurs(g));
    groups.push({ hooks: [{ type: 'command', command: `bash ${script} claude` }] });
    hooks[ev] = groups;
  }
  return { ...settings, hooks };
}

/** Claude settings without our hooks; events left empty are dropped. */
export function removeClaudeHooks(settings: Json): Json {
  const hooks = { ...((settings['hooks'] as Json | undefined) ?? {}) };
  for (const ev of Object.keys(hooks)) {
    const groups = ((hooks[ev] as HookGroup[] | undefined) ?? []).filter((g) => !isOurs(g));
    if (groups.length) hooks[ev] = groups; else delete hooks[ev];
  }
  const out = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete out['hooks'];
  return out;
}

export function claudeHooksInstalled(settings: Json): boolean {
  const hooks = (settings['hooks'] as Json | undefined) ?? {};
  return CLAUDE_EVENTS.every((ev) => ((hooks[ev] as HookGroup[] | undefined) ?? []).some(isOurs));
}

// `notify` must be a TOP-LEVEL key, i.e. before the first [table] header.
const NOTIFY_RE = /^notify\s*=.*$/m;

function topLevel(toml: string): { head: string; rest: string } {
  const m = /^\s*\[/m.exec(toml);
  return m ? { head: toml.slice(0, m.index), rest: toml.slice(m.index) } : { head: toml, rest: '' };
}

/** Codex config with our `notify`; `conflict` when another notify program is set (left untouched). */
export function addCodexNotify(toml: string, script: string): { toml: string; conflict: string | null } {
  const { head, rest } = topLevel(toml);
  const existing = NOTIFY_RE.exec(head)?.[0] ?? null;
  const line = `notify = ["bash", ${JSON.stringify(script)}, "codex"]`;
  if (existing && !existing.includes(HOOK_MARK)) return { toml, conflict: existing };
  const newHead = existing ? head.replace(NOTIFY_RE, line) : `${line}\n${head}`;
  return { toml: newHead + rest, conflict: null };
}

export function removeCodexNotify(toml: string): string {
  const { head, rest } = topLevel(toml);
  const existing = NOTIFY_RE.exec(head)?.[0];
  if (!existing || !existing.includes(HOOK_MARK)) return toml;
  return head.replace(/^notify\s*=.*\n?/m, '') + rest;
}

export function codexNotifyInstalled(toml: string): boolean {
  return (NOTIFY_RE.exec(topLevel(toml).head)?.[0] ?? '').includes(HOOK_MARK);
}

// ─── I/O ────────────────────────────────────────────────────────────────

export interface HookStatus {
  script: boolean;
  claude: boolean;
  codex: boolean;
  /** An existing Codex `notify` we did not set (install leaves it alone). */
  codexConflict: string | null;
  paths: HookPaths;
}

function readText(p: string): string { try { return readFileSync(p, 'utf-8'); } catch { return ''; } }
function readJson(p: string): Json {
  const t = readText(p);
  if (!t.trim()) return {};
  const v = JSON.parse(t);   // a broken settings file is an error, never silently replaced
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
}
function backupAndWrite(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) {
    if (readText(p) === text) return;
    copyFileSync(p, `${p}.bak-aura-terminal`);
  }
  writeFileSync(p, text);
}

export function hookStatus(paths = defaultPaths()): HookStatus {
  const toml = readText(paths.codex);
  const notify = NOTIFY_RE.exec(topLevel(toml).head)?.[0] ?? null;
  let claude = false;
  try { claude = claudeHooksInstalled(readJson(paths.claude)); } catch { /* unreadable ⇒ not installed */ }
  return {
    script: existsSync(paths.script),
    claude,
    codex: codexNotifyInstalled(toml),
    codexConflict: notify && !notify.includes(HOOK_MARK) ? notify : null,
    paths,
  };
}

export function installHooks(paths = defaultPaths()): HookStatus {
  mkdirSync(dirname(paths.script), { recursive: true });
  writeFileSync(paths.script, HOOK_SCRIPT);
  chmodSync(paths.script, 0o755);
  backupAndWrite(paths.claude, JSON.stringify(addClaudeHooks(readJson(paths.claude), paths.script), null, 2) + '\n');
  const codex = addCodexNotify(readText(paths.codex), paths.script);
  if (!codex.conflict) backupAndWrite(paths.codex, codex.toml);
  return hookStatus(paths);
}

export function uninstallHooks(paths = defaultPaths()): HookStatus {
  if (existsSync(paths.claude)) {
    backupAndWrite(paths.claude, JSON.stringify(removeClaudeHooks(readJson(paths.claude)), null, 2) + '\n');
  }
  if (existsSync(paths.codex)) backupAndWrite(paths.codex, removeCodexNotify(readText(paths.codex)));
  return hookStatus(paths);
}
