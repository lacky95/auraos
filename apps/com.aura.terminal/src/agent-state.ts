/**
 * Agent state per session — what a coding agent (Claude Code, Codex) running
 * in a terminal session is doing, as reported by the agent ITSELF through its
 * hooks, not guessed from the screen.
 *
 *   hook (agent-hook.sh, in the shell) ──POST /api/sessions/events──► here
 *        ──► `agent` on every /api/sessions row and in the terminal MCP
 *        ──► GET /api/sessions/events?stream=1 (SSE) for apps that react,
 *            e.g. TerminalX turning transitions into notifications.
 *
 * Generic on purpose: the terminal only records state; what to DO about it
 * (notify, show a badge, auto-approve…) is the consuming app's business.
 * Event-driven, so it costs nothing while no agent is running. The screen
 * detectors (screen-summary.ts) remain the fallback for agents with no hooks.
 *
 * `reduce()` is pure; the store below is a module-level map pinned on
 * globalThis (same reason as `sessions` in pty-server.ts).
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */

export type AgentSource = 'claude' | 'codex';

/**
 * running         — working on a turn (prompt submitted, tool in flight)
 * needs_approval  — blocked on a permission prompt
 * waiting_input   — asked the user something / idle reminder
 * idle            — turn finished, back at its prompt
 * exited          — the agent session ended
 */
export type AgentStatus = 'running' | 'needs_approval' | 'waiting_input' | 'idle' | 'exited';

export interface AgentState {
  source: AgentSource;
  status: AgentStatus;
  /** Tool in flight (`running`) or asked about (`needs_approval`), when known. */
  tool: string | null;
  /** The agent's own words for `needs_approval` / `waiting_input`. */
  message: string | null;
  /** The agent's session id (Claude `session_id`, Codex `thread-id`), when given. */
  agentSessionId: string | null;
  cwd: string | null;
  /** Epoch ms the current status began / the last event arrived. */
  since: number;
  updatedAt: number;
}

export interface AgentEvent {
  source: AgentSource;
  /** The hook's own payload: Claude's stdin JSON, Codex's notify argument. */
  payload: Record<string, unknown>;
  at: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The status an event moves to; null ⇒ the event is not about status (ignored). */
function statusOf(ev: AgentEvent): { status: AgentStatus; tool?: string | null; message?: string | null } | null {
  const p = ev.payload;
  if (ev.source === 'codex') {
    // Codex `notify` only reports finished turns.
    return str(p['type']) === 'agent-turn-complete' ? { status: 'idle' } : null;
  }
  switch (str(p['hook_event_name'])) {
    case 'SessionStart':     return { status: 'idle' };
    case 'UserPromptSubmit': return { status: 'running', tool: null };
    case 'PreToolUse':
    case 'PostToolUse':      return { status: 'running', tool: str(p['tool_name']) };
    case 'Notification': {
      const message = str(p['message']);
      const kind = str(p['notification_type']);
      const approval = kind ? kind === 'permission_prompt' : /permission|approv/i.test(message ?? '');
      return { status: approval ? 'needs_approval' : 'waiting_input', message };
    }
    case 'Stop':             return { status: 'idle', tool: null };
    case 'SessionEnd':       return { status: 'exited', tool: null };
    default:                 return null;
  }
}

/** Next state for one event. Unchanged object identity ⇒ nothing changed. */
export function reduce(prev: AgentState | null, ev: AgentEvent): AgentState | null {
  const next = statusOf(ev);
  if (!next) return prev;
  const p = ev.payload;
  const statusChanged = prev?.status !== next.status || prev?.source !== ev.source;
  return {
    source: ev.source,
    status: next.status,
    tool: next.tool !== undefined ? next.tool : (prev?.tool ?? null),
    message: next.message !== undefined ? next.message
      : (next.status === 'needs_approval' || next.status === 'waiting_input' ? prev?.message ?? null : null),
    agentSessionId: str(p['session_id']) ?? str(p['thread-id']) ?? prev?.agentSessionId ?? null,
    cwd: str(p['cwd']) ?? prev?.cwd ?? null,
    since: statusChanged ? ev.at : prev!.since,
    updatedAt: ev.at,
  };
}

/** Parse + validate a POST body; throws a message for a 400. */
export function parseEventBody(body: unknown, now: number): { session: string; event: AgentEvent } {
  const b = body as Record<string, unknown> | null;
  const session = str(b?.['session']);
  if (!session || !/^[^#\s]+#[^#\s]+$/.test(session)) throw new Error('session must be a session id (<instanceId>#a<n>)');
  const source = b?.['source'];
  if (source !== 'claude' && source !== 'codex') throw new Error('source must be "claude" or "codex"');
  const payload = b?.['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  return { session, event: { source, payload: payload as Record<string, unknown>, at: now } };
}

// ─── Store ──────────────────────────────────────────────────────────────

export interface AgentChange { session: string; agent: AgentState | null }
type Listener = (change: AgentChange) => void;

interface Store { states: Map<string, AgentState>; listeners: Set<Listener> }
const STORE_KEY = '__aura_agent_state__';
const store: Store =
  ((globalThis as Record<string, unknown>)[STORE_KEY] as Store | undefined)
  ?? ((globalThis as Record<string, unknown>)[STORE_KEY] = { states: new Map(), listeners: new Set() }) as Store;

function emit(change: AgentChange): void {
  for (const l of store.listeners) { try { l(change); } catch { /* a listener's problem */ } }
}

export function recordEvent(session: string, ev: AgentEvent): AgentState | null {
  const prev = store.states.get(session) ?? null;
  const next = reduce(prev, ev);
  if (next === prev) return prev;
  if (next) store.states.set(session, next);
  emit({ session, agent: next });
  return next;
}

export function agentFor(session: string): AgentState | null {
  return store.states.get(session) ?? null;
}

export function allAgents(): Record<string, AgentState> {
  return Object.fromEntries(store.states);
}

/** The session is gone (killed / root exit): its agent state goes with it. */
export function forgetAgent(session: string): void {
  if (store.states.delete(session)) emit({ session, agent: null });
}

export function subscribeAgents(l: Listener): () => void {
  store.listeners.add(l);
  return () => { store.listeners.delete(l); };
}
