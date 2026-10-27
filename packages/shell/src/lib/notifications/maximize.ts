/**
 * Maximize for notification dialogues (phase 6) — DOM-free.
 *
 * Every dialogue frame (desktop modal, centred desktop dialogue, floating
 * panel, in-window panel; not the phone) has a ⤢ / ⤡ header button and the
 * shortcut Alt+Shift+Enter (while focus is inside the dialogue). The state
 * is remembered per notification for this tab in sessionStorage
 * (`aura.notif.max.<id>` = "1"), so it survives patches, re-mounts and
 * reloads; the dialogue layer clears it when the item ends.
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
  get(id: string): boolean {
    if (this.storage) {
      try { return this.storage.getItem(MAX_PREFIX + id) === '1'; } catch { /* fall through */ }
    }
    return this.memory.get(id) ?? false;
  }
  set(id: string, on: boolean): void {
    this.memory.set(id, on);
    if (!on) this.memory.delete(id);
    if (!this.storage) return;
    try {
      if (on) this.storage.setItem(MAX_PREFIX + id, '1');
      else this.storage.removeItem(MAX_PREFIX + id);
    } catch { /* ignore */ }
  }
  clear(id: string): void { this.set(id, false); }
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
