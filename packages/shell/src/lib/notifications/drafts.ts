/**
 * Drafts of the user's input per notification — DOM-free (phase 4).
 *
 * Every input / change is saved at once to localStorage under
 * `aura.notif.draft.<notificationId>` as `{v:1, values:{componentId:value},
 * updatedAt}`, so a reload never loses what was typed. Every rendering of
 * the notification (list, pop-up, window / floating / desktop dialogue,
 * phone sheet / full view) restores it — only component ids that still
 * exist with a matching kind / value shape.
 *
 * Cleared on a successful submit / cancel, when the item is resolved or
 * removed by anyone (store event), and by the garbage collection: ids that
 * are no longer active and anything older than 7 days.
 *
 * Privacy trade-off (phase 5 lock screen): drafts are NOT rendered while the
 * screen is locked (the UI is hidden and wiped), but they stay in THIS
 * browser's localStorage across a lock — the user wants persistence across
 * reloads. `aura:notifications:wipe` clears views, not drafts.
 *
 * Storage access is wrapped; without localStorage (private mode, quota,
 * tests) a memory map stands in.
 */
import type { Notification } from './api.ts';

export const DRAFT_PREFIX = 'aura.notif.draft.';
export const DRAFT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export type DraftValue = string | string[];
export interface Draft { v: 1; values: Record<string, DraftValue>; updatedAt: number }

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

function isValue(v: unknown): v is DraftValue {
  return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

export class DraftStore {
  private readonly memory = new Map<string, Draft>();
  private storage: StorageLike | null;
  private readonly now: () => number;

  constructor(opts: { storage?: StorageLike | null; now?: () => number } = {}) {
    this.storage = opts.storage ?? null;
    this.now = opts.now ?? Date.now;
  }

  private read(id: string): Draft | null {
    if (this.storage) {
      try {
        const raw = this.storage.getItem(DRAFT_PREFIX + id);
        if (raw === null) return this.memory.get(id) ?? null;
        const d = JSON.parse(raw) as Draft;
        if (d && d.v === 1 && d.values && typeof d.values === 'object') return d;
        return null;
      } catch { /* fall back to memory */ }
    }
    return this.memory.get(id) ?? null;
  }

  private write(id: string, d: Draft): void {
    this.memory.set(id, d);
    if (!this.storage) return;
    try { this.storage.setItem(DRAFT_PREFIX + id, JSON.stringify(d)); } catch { /* memory keeps it */ }
  }

  get(id: string): Record<string, DraftValue> | null {
    const d = this.read(id);
    return d ? { ...d.values } : null;
  }

  set(id: string, componentId: string, value: DraftValue): void {
    const d = this.read(id) ?? { v: 1 as const, values: {}, updatedAt: 0 };
    d.values[componentId] = Array.isArray(value) ? [...value] : value;
    d.updatedAt = this.now();
    this.write(id, d);
  }

  clear(id: string): void {
    this.memory.delete(id);
    if (!this.storage) return;
    try { this.storage.removeItem(DRAFT_PREFIX + id); } catch { /* ignore */ }
  }

  ids(): string[] {
    const out = new Set(this.memory.keys());
    if (this.storage) {
      try {
        for (let i = 0; i < this.storage.length; i++) {
          const k = this.storage.key(i);
          if (k && k.startsWith(DRAFT_PREFIX)) out.add(k.slice(DRAFT_PREFIX.length));
        }
      } catch { /* ignore */ }
    }
    return [...out];
  }

  /** Drop drafts of ids not in `active` (when given) and older than `maxAgeMs`. Returns how many. */
  gc(active: ReadonlySet<string> | null, maxAgeMs = DRAFT_MAX_AGE_MS): number {
    let n = 0;
    const cutoff = this.now() - maxAgeMs;
    for (const id of this.ids()) {
      const d = this.read(id);
      if (!d || d.updatedAt < cutoff || (active && !active.has(id))) { this.clear(id); n++; }
    }
    return n;
  }
}

/** Only values whose component still exists with a matching kind / shape. */
export function draftValuesFor(n: Pick<Notification, 'components'>, values: Record<string, DraftValue> | null): Record<string, DraftValue> {
  const out: Record<string, DraftValue> = {};
  if (!values) return out;
  for (const c of n.components ?? []) {
    if (!c.id || !(c.id in values)) continue;
    const v = values[c.id];
    if (!isValue(v)) continue;
    if (c.kind === 'input' && typeof v === 'string') out[c.id] = v;
    else if (c.kind === 'markdown' && c.editable && typeof v === 'string') out[c.id] = v;
    else if (c.kind === 'select' && typeof v === 'string') {
      if (v === '' || c.options.some((o) => o.id === v)) out[c.id] = v;
    } else if (c.kind === 'combobox' && typeof v === 'string') {
      if (v === '' || c.allowCustom || c.options.some((o) => o.id === v)) out[c.id] = v;
    }
    else if (c.kind === 'options') {
      const known = new Set(c.options.map((o) => o.id));
      const ids = (typeof v === 'string' ? [v] : v).filter((x) => known.has(x));
      if (c.multiple) out[c.id] = ids;
      else if (ids[0] !== undefined) out[c.id] = ids[0];
    }
  }
  return out;
}

let shared: DraftStore | null = null;
/** The page-wide store on localStorage (memory fallback). */
export function getDrafts(): DraftStore {
  if (shared) return shared;
  let storage: StorageLike | null = null;
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls) { const probe = `${DRAFT_PREFIX}__probe`; ls.setItem(probe, '1'); ls.removeItem(probe); storage = ls; }
  } catch { storage = null; }
  shared = new DraftStore({ storage });
  return shared;
}
