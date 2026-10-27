/**
 * Maximize for notification dialogues (phase 6) — DOM-free.
 *
 * Every dialogue frame (desktop modal, centred desktop dialogue, floating
 * panel, in-window panel; not the phone) has a ⤢ / ⤡ header button and the
 * shortcut Alt+Shift+Enter (while focus is inside the dialogue). The
 * USER's choice is remembered per notification for this tab in
 * sessionStorage (`aura.notif.max.<id>` = "1" maximized / "0" restored), so
 * it survives patches, re-mounts and reloads; the dialogue layer clears it
 * when the item ends.
 *
 * Precedence (`initialMaximized`): the user's choice in this tab beats the
 * sender's hint (`Notification.maximized`); without a choice the hint
 * decides (also when an update changes it).
 *
 * Alt+Shift+Enter: Enter with modifiers types nothing in fields, it is not
 * a browser / OS shortcut (unlike Ctrl+Shift+M, F11 or AltGr+M = µ on
 * German layouts), and the card's own Enter handling ignores Alt.
 */
export const MAX_PREFIX = 'aura.notif.max.';
export const MAXIMIZE_SHORTCUT_LABEL = 'Alt+Shift+Enter';
export const MAXIMIZE_ARIA_KEYS = 'Alt+Shift+Enter';

export function isMaximizeShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): boolean {
  return e.key === 'Enter' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

export interface MaxStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class MaximizeMemory {
  private memory = new Map<string, boolean>();
  constructor(private storage: MaxStorage | null) {}
  /** The user's choice for `id` in this tab; null when they made none. */
  get(id: string): boolean | null {
    if (this.storage) {
      try {
        const v = this.storage.getItem(MAX_PREFIX + id);
        if (v === '1') return true;
        if (v === '0') return false;
        if (v === null && !this.memory.has(id)) return null;
      } catch { /* fall through */ }
    }
    return this.memory.get(id) ?? null;
  }
  /** Remember the user's maximize (true) / restore (false). */
  set(id: string, on: boolean): void {
    this.memory.set(id, on);
    if (!this.storage) return;
    try { this.storage.setItem(MAX_PREFIX + id, on ? '1' : '0'); } catch { /* ignore */ }
  }
  /** Forget the choice (the item ended). */
  clear(id: string): void {
    this.memory.delete(id);
    if (!this.storage) return;
    try { this.storage.removeItem(MAX_PREFIX + id); } catch { /* ignore */ }
  }
}

/** The state a dialogue opens in: the user's choice, else the sender's hint. */
export function initialMaximized(userChoice: boolean | null, hint: boolean | undefined): boolean {
  return userChoice ?? !!hint;
}

let shared: MaximizeMemory | null = null;
/** The tab-wide memory on sessionStorage (memory fallback). */
export function getMaximizeMemory(): MaximizeMemory {
  if (shared) return shared;
  let storage: MaxStorage | null = null;
  try {
    const ss = (globalThis as { sessionStorage?: MaxStorage }).sessionStorage;
    if (ss) { const probe = `${MAX_PREFIX}__probe`; ss.setItem(probe, '1'); ss.removeItem(probe); storage = ss; }
  } catch { storage = null; }
  shared = new MaximizeMemory(storage);
  return shared;
}
