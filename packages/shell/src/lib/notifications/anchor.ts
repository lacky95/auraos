/**
 * Shell anchors — named attachment points for floating UI. The
 * notification list and pop-ups attach to the 'notifications' anchor (the
 * Dock button today), not to the Dock itself, so a later layout can move
 * the button without touching them.
 *
 * The registry lives on globalThis so every bundled <script> shares it.
 * Generic over the element type, so it stays DOM-free (tests pass plain
 * objects).
 */
export type AnchorListener<T> = (el: T | null) => void;

interface Registry {
  els: Map<string, unknown>;
  listeners: Map<string, Set<AnchorListener<unknown>>>;
}

const KEY = '__auraShellAnchors';

function registry(): Registry {
  const g = globalThis as typeof globalThis & { [KEY]?: Registry };
  return (g[KEY] ??= { els: new Map(), listeners: new Map() });
}

function notify(name: string, el: unknown): void {
  for (const fn of [...(registry().listeners.get(name) ?? [])]) {
    try { fn(el); } catch (err) { console.warn('[anchor] listener threw', err); }
  }
}

/** Register `el` as anchor `name`. Returns an unregister function. */
export function registerAnchor<T>(name: string, el: T): () => void {
  const r = registry();
  r.els.set(name, el);
  notify(name, el);
  return () => {
    if (r.els.get(name) !== el) return;
    r.els.delete(name);
    notify(name, null);
  };
}

export function getAnchor<T>(name: string): T | null {
  return (registry().els.get(name) as T | undefined) ?? null;
}

/** Called with the current anchor right away, then on every change. */
export function watchAnchor<T>(name: string, fn: AnchorListener<T>): () => void {
  const r = registry();
  let set = r.listeners.get(name);
  if (!set) { set = new Set(); r.listeners.set(name, set); }
  set.add(fn as AnchorListener<unknown>);
  try { fn(getAnchor<T>(name)); } catch (err) { console.warn('[anchor] listener threw', err); }
  return () => { set!.delete(fn as AnchorListener<unknown>); };
}

export const NOTIFICATIONS_ANCHOR = 'notifications';
