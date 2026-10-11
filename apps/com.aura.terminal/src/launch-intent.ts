/**
 * `aura.intent.action.OPEN_TERMINAL` — how another app or agent opens a
 * terminal through the OS intent system (`OsClient.startIntent`,
 * `POST /api/intents/start`), instead of a launch-parameter API of our own.
 *
 * WHICH INSTANCE is the OS's call, made from intent-level fields before we
 * are asked anything (see AppManager.pickIntentInstance):
 *   • nothing        → reuse the first running terminal instance, exactly like
 *                      the launcher icon (manifest `defaultLaunch: new-activity`),
 *                      starting/claiming one when none runs;
 *   • `instanceId`   → that instance; unknown/dead → the OS answers 404/409;
 *   • `flags: ['NEW_INSTANCE']` → a fresh container.
 *
 * WHAT HAPPENS ON IT is ours, from `extras` (all optional):
 *   • `sessionId`  — open the new window on that EXISTING session instead of a
 *                    new one. It must be live on the target instance (a session
 *                    id names its instance: `com.aura.terminal-2#a3` lives on
 *                    `com.aura.terminal-2`), so send `instanceId` = that prefix.
 *   • `command`    — one command line, typed + Enter into the session once the
 *                    window's terminal is live (or, with `background`, as soon
 *                    as the shell is up). Runs exactly once.
 *   • `background` — create the session with NO window. The intent result's
 *                    `result.sessionId` lets a later intent open a window on it.
 *
 * Conflicts are rejected, never resolved by guessing (`rejected` reply → the
 * OS opens nothing and stops an instance it started only for this intent):
 *   • `sessionId` + `NEW_INSTANCE`  → a fresh container has no sessions;
 *   • `sessionId` + `background`    → background only creates new sessions;
 *   • `sessionId` on another instance / not live → names the right instance /
 *     says it is gone, rather than quietly opening a new shell;
 *   • unknown extras keys (incl. `instanceId`/`newInstance`, which belong on
 *     the intent itself) and any other action.
 *
 * Pure: no tmux, no fs — the lifecycle route does the I/O.
 */

export const OPEN_TERMINAL_ACTION = 'aura.intent.action.OPEN_TERMINAL';

/** Long enough for any real one-liner; short enough that a runaway payload is refused. */
export const MAX_COMMAND_LENGTH = 4096;

export interface OpenTerminalOptions {
  sessionId?: string;
  command?: string;
  background: boolean;
}

export interface LaunchRejection {
  code: string;
  message: string;
  hint?: string;
  status: number;
}

/** The parts of the delivered intent this reads (an `IntentPayload`). */
export interface OpenTerminalIntent {
  action: string;
  extras?: Record<string, unknown>;
  flags?: string[];
}

const KNOWN_EXTRAS = new Set(['sessionId', 'command', 'background']);
const INTENT_LEVEL = new Set(['instanceId', 'newInstance', 'flags', 'appId']);
const APP_ID = 'com.aura.terminal';
const SESSION_RE = /^([^#\s]+)#([^#\s]+)$/;
// C0 controls except TAB, plus DEL. A newline would run a partial command and
// an ESC would drive the terminal — a command is one plain line.
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const reject = (status: number, code: string, message: string, hint?: string): { ok: false; rejection: LaunchRejection } =>
  ({ ok: false, rejection: { code, message, status, ...(hint ? { hint } : {}) } });

/**
 * Validate an OPEN_TERMINAL intent against the instance it landed on.
 * Session liveness is NOT checked here (needs tmux) — see the route.
 */
export function parseOpenTerminal(
  intent: OpenTerminalIntent,
  localInstanceId: string,
): { ok: true; opts: OpenTerminalOptions } | { ok: false; rejection: LaunchRejection } {
  if (intent.action !== OPEN_TERMINAL_ACTION) {
    return reject(400, 'unsupported-action', `The terminal does not handle "${intent.action}".`,
      `Send action "${OPEN_TERMINAL_ACTION}".`);
  }
  const extras = intent.extras ?? {};
  for (const key of Object.keys(extras)) {
    if (INTENT_LEVEL.has(key)) {
      return reject(400, 'misplaced-option', `"${key}" is not an extra — it is part of the intent itself.`,
        'Target an instance with intent.instanceId, ask for a fresh one with intent.flags: ["NEW_INSTANCE"].');
    }
    if (!KNOWN_EXTRAS.has(key)) {
      return reject(400, 'unknown-extra', `Unknown extra "${key}".`,
        `OPEN_TERMINAL understands: ${[...KNOWN_EXTRAS].join(', ')}.`);
    }
  }

  const { sessionId, command, background } = extras as { sessionId?: unknown; command?: unknown; background?: unknown };
  if (background !== undefined && typeof background !== 'boolean') {
    return reject(400, 'bad-background', '"background" must be true or false.');
  }
  if (command !== undefined) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      return reject(400, 'bad-command', '"command" must be a non-empty string.');
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return reject(400, 'bad-command', `"command" is longer than ${MAX_COMMAND_LENGTH} characters.`);
    }
    if (CONTROL_RE.test(command)) {
      return reject(400, 'bad-command', '"command" must be one line without control characters.',
        'Chain steps with ; or && — the terminal presses Enter for you.');
    }
  }

  if (sessionId !== undefined) {
    const m = typeof sessionId === 'string' ? SESSION_RE.exec(sessionId) : null;
    if (!m || !m[1]!.startsWith(APP_ID)) {
      return reject(400, 'bad-session-id', `"${String(sessionId)}" is not a terminal session id.`,
        `Expected <instanceId>#<name>, e.g. ${APP_ID}-2#a3.`);
    }
    if (background === true) {
      return reject(400, 'conflicting-options', '"background" creates a new session; it cannot be combined with "sessionId".',
        'Drop "background" to open a window on the existing session.');
    }
    if ((intent.flags ?? []).includes('NEW_INSTANCE')) {
      return reject(400, 'conflicting-options', 'NEW_INSTANCE starts a fresh terminal container, which has no session to attach to.',
        `Send intent.instanceId "${m[1]}" instead of NEW_INSTANCE.`);
    }
    if (m[1] !== localInstanceId) {
      return reject(409, 'session-on-other-instance',
        `Session "${sessionId}" lives on ${m[1]}, not on ${localInstanceId}.`,
        `Send the intent with instanceId "${m[1]}".`);
    }
  }

  return {
    ok: true,
    opts: {
      ...(typeof sessionId === 'string' ? { sessionId } : {}),
      ...(typeof command === 'string' ? { command } : {}),
      background: background === true,
    },
  };
}

/**
 * Whether a captured screen looks like a shell that has finished starting:
 * something is drawn, and two captures `quietMs` apart are identical. Used
 * to time `command` so it lands at a prompt, not in the middle of rc files.
 */
export function screenSettled(prev: string[] | null, next: string[]): boolean {
  if (!prev) return false;
  if (!next.some((l) => l.trim().length > 0)) return false;
  return prev.length === next.length && prev.every((l, i) => l === next[i]);
}
