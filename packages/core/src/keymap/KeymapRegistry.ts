/**
 * Singleton registry of every keymap action known to the OS. Mirrors the
 * pattern used by `OsEventBus` (pinned on globalThis so Vite/Astro's
 * multi-module-graph SSR can't fracture the singleton across copies).
 *
 * Two populations live here:
 *   - DEFAULT_OS_ACTIONS, registered once at construction.
 *   - Per-app `keymapActions` declarations, refreshed from manifests via
 *     `reloadFromManifests` after every AppRegistry init/reload. App-action
 *     ids are namespaced `app.<appId>.<short>` so they cannot collide with
 *     OS ids or with each other.
 *
 * The registry does NOT hold user bindings — those live in the OS KV at
 * `os/keymap`. Use `KeyDispatcher` (shell-side) to combine the two and
 * resolve a combo to an action.
 */

import type { AppManifest } from '../types/manifest.js';
import { canonicalize } from './canonical.js';
import { DEFAULT_OS_ACTIONS, type KeyAction } from './types.js';

export class KeymapRegistry {
  private byId       = new Map<string, KeyAction>();
  private byCategory = new Map<string, KeyAction[]>();

  constructor(initial: readonly KeyAction[] = DEFAULT_OS_ACTIONS) {
    for (const a of initial) this.addInternal(a);
  }

  list(): KeyAction[] {
    return Array.from(this.byId.values());
  }

  listCategories(): string[] {
    return Array.from(this.byCategory.keys());
  }

  listByCategory(category: string): KeyAction[] {
    return [...(this.byCategory.get(category) ?? [])];
  }

  get(id: string): KeyAction | undefined {
    return this.byId.get(id);
  }

  /**
   * Register or replace a single action. App-scope actions must be prefixed
   * `app.<appId>.` already — this method does NOT do the prefixing; manifest
   * reload does it on the caller's behalf in `reloadFromManifests`.
   */
  register(action: KeyAction): void {
    this.removeInternal(action.id);
    this.addInternal(action);
  }

  registerAll(actions: readonly KeyAction[]): void {
    for (const a of actions) this.register(a);
  }

  /**
   * Wipe every existing `app.*` action and replace it with the union of the
   * provided manifests' `keymapActions`. OS-scope actions (scope ≠ 'app',
   * id NOT starting with `app.`) are preserved. Idempotent — call after
   * every AppRegistry change.
   *
   * Each manifest entry `{ id: 'save', label, category, defaultCombo }`
   * becomes an action with id `app.<manifest.id>.<save>`. The defaultCombo
   * is run through `canonicalize` so a manifest that says `"ctrl+s"` ends
   * up indistinguishable from `"Ctrl+KeyS"` at lookup time.
   *
   * Malformed entries are dropped with a console.warn so a typo in one
   * app's manifest can't break the OS-wide registry.
   */
  reloadFromManifests(manifests: readonly AppManifest[]): void {
    for (const id of Array.from(this.byId.keys())) {
      if (id.startsWith('app.')) this.removeInternal(id);
    }
    for (const m of manifests) {
      for (const decl of m.keymapActions ?? []) {
        const fullId = `app.${m.id}.${decl.id}`;
        let combo: string | null = null;
        if (decl.defaultCombo) {
          try { combo = canonicalize(decl.defaultCombo); }
          catch (err) {
            console.warn(`[KeymapRegistry] dropping malformed combo for ${fullId}: ${(err as Error).message}`);
            continue;
          }
        }
        const action: KeyAction = {
          id:           fullId,
          label:        decl.label,
          category:     decl.category,
          scope:        decl.scope,
          defaultCombo: combo,
          ...(decl.description !== undefined ? { description: decl.description } : {}),
        };
        this.addInternal(action);
      }
    }
  }

  /**
   * Find every action whose default combo equals the given canonical combo
   * AND whose scope is reachable from the current mode. Used by
   * KeyDispatcher when looking up an unbound combo (the user has not
   * overridden it). For user-overridden combos, the dispatcher consults
   * the KV-backed bindings directly and doesn't call this.
   */
  resolveDefault(combo: string, mode: 'nav' | 'app'): KeyAction[] {
    const out: KeyAction[] = [];
    for (const a of this.byId.values()) {
      if (a.defaultCombo !== combo) continue;
      if (!scopeReachable(a.scope, mode)) continue;
      out.push(a);
    }
    return out;
  }

  // ---- internals ---------------------------------------------------------

  private addInternal(action: KeyAction): void {
    this.byId.set(action.id, action);
    const bucket = this.byCategory.get(action.category) ?? [];
    bucket.push(action);
    this.byCategory.set(action.category, bucket);
  }

  private removeInternal(id: string): void {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.byId.delete(id);
    const bucket = this.byCategory.get(existing.category);
    if (!bucket) return;
    const next = bucket.filter((a) => a.id !== id);
    if (next.length === 0) this.byCategory.delete(existing.category);
    else this.byCategory.set(existing.category, next);
  }
}

function scopeReachable(scope: KeyAction['scope'], mode: 'nav' | 'app'): boolean {
  if (scope === 'os-always')   return true;
  if (scope === 'os-modifier') return true;
  if (scope === 'os-nav')      return mode === 'nav';
  if (scope === 'app')         return mode === 'app';
  return false;
}

const GLOBAL_KEY = '__aura_keymap_registry__';
type GlobalWithKeymap = typeof globalThis & { [GLOBAL_KEY]?: KeymapRegistry };
const existing = (globalThis as GlobalWithKeymap)[GLOBAL_KEY];
export const keymapRegistry: KeymapRegistry = existing ?? new KeymapRegistry();
if (!existing) (globalThis as GlobalWithKeymap)[GLOBAL_KEY] = keymapRegistry;
