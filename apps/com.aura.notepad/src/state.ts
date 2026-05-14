/**
 * In-memory shared state for the Notepad app.
 * One Astro server process owns this state and serves all activity views.
 *
 * Lives on globalThis to survive Vite HMR transforms.
 */
type NotepadState = {
  text: string;
  /** Set of activityIds currently connected (tracked via onActivityCreate). */
  activities: Set<string>;
  /** Bumped on every text change so SSE clients can show "version" indicators. */
  revision: number;
  /** Subscriber callbacks for SSE clients. */
  listeners: Set<() => void>;
};

const KEY = '__aura_notepad_state__';
const g = globalThis as typeof globalThis & { [KEY]?: NotepadState };

if (!g[KEY]) {
  g[KEY] = {
    text: '',
    activities: new Set(),
    revision: 0,
    listeners: new Set(),
  };
}

export const state = g[KEY]!;

export function setText(newText: string): void {
  state.text = newText;
  state.revision += 1;
  for (const cb of state.listeners) {
    try { cb(); } catch {}
  }
}

export function snapshot() {
  return {
    text: state.text,
    revision: state.revision,
    activityCount: state.activities.size,
    activityIds: Array.from(state.activities),
  };
}
