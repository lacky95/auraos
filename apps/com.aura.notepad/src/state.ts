/**
 * Shared state for the Notepad app.
 * Lives on globalThis to survive Vite HMR transforms.
 *
 * Persistence: the document text is written to /data/note.txt on every
 * change and loaded back on module init, so it survives container restarts.
 * /data is bind-mounted by the OS to the per-instance data directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type NotepadState = {
  text: string;
  /** Set of activityIds currently connected (tracked via onActivityCreate). */
  activities: Set<string>;
  /** Bumped on every text change so SSE clients can show "version" indicators. */
  revision: number;
  /** Subscriber callbacks for SSE clients. */
  listeners: Set<() => void>;
};

const DATA_DIR  = process.env['AURA_DATA_DIR'] ?? '/data';
const DATA_FILE = join(DATA_DIR, 'note.txt');

function loadFromDisk(): string {
  try {
    if (existsSync(DATA_FILE)) return readFileSync(DATA_FILE, 'utf-8');
  } catch { /* first run or unreadable — start empty */ }
  return '';
}

function saveToDisk(text: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(DATA_FILE, text, 'utf-8');
  } catch { /* best-effort */ }
}

const KEY = '__aura_notepad_state__';
const g = globalThis as typeof globalThis & { [KEY]?: NotepadState };

if (!g[KEY]) {
  g[KEY] = {
    text:      loadFromDisk(),
    activities: new Set(),
    revision:  0,
    listeners: new Set(),
  };
}

export const state = g[KEY]!;

export function setText(newText: string): void {
  state.text = newText;
  state.revision += 1;
  saveToDisk(newText);
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
