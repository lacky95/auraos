/**
 * Registry of available window-layout strategies. Modelled after
 * `ThemeManager.THEMES` (static-list, singleton-on-globalThis) — but with a
 * mutable `register()` seam so a future "plugin pack" pass can hot-add
 * strategies declared in app manifests without changing this API.
 *
 * The shell consults this registry to translate a workspace's `layoutId`
 * (persisted in Settings) into the actual Astro component used to render
 * the desktop. The registry only carries metadata; the matching .astro
 * component lives in `packages/shell/src/components/layout/strategies/`
 * and is looked up via a static map there. (Two-table lookup: shell knows
 * how to load the bundle; core only knows what's available.)
 */

export interface LayoutStrategyMeta {
  /** Stable lowercase id used as the workspace's `layoutId`. */
  id:          string;
  /** User-facing display name (Settings, status bar chip). */
  name:        string;
  /** One-sentence description for the Settings inventory page. */
  description: string;
  /** Free-form icon hint (emoji / glyph) for the Settings card. */
  icon?:       string;
  /**
   * Minimum view count this strategy makes sense for. The shell uses this
   * to grey out an option in the cycle chip when only 1 view exists
   * (e.g. tiling is pointless for a single view — fullscreen is the
   * natural pick). Strategies that work for any count omit the field.
   */
  minViews?:   number;
  /**
   * Whether the strategy honors user-positioned slots (drag, resize). The
   * shell uses this to know whether to persist `(x,y,w,h,z)` in the
   * workspace's `layoutState`. Defaults to false (auto-layouts that ignore
   * user drag, e.g. tiling).
   */
  supportsManualPlacement?: boolean;
}

export class LayoutStrategyRegistry {
  private readonly byId = new Map<string, LayoutStrategyMeta>();

  constructor(initial: readonly LayoutStrategyMeta[] = []) {
    for (const m of initial) this.byId.set(m.id, m);
  }

  list(): LayoutStrategyMeta[] {
    return Array.from(this.byId.values());
  }

  get(id: string): LayoutStrategyMeta | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /**
   * Add or replace a strategy. Intended for the future plugin loader; the
   * shell's component-map must be updated in lockstep, otherwise the new
   * id resolves in the registry but renders to nothing.
   */
  register(meta: LayoutStrategyMeta): void {
    this.byId.set(meta.id, meta);
  }
}

/** Strategies that ship in the shell out of the box. */
export const DEFAULT_LAYOUT_STRATEGIES: readonly LayoutStrategyMeta[] = [
  {
    id: 'tiling',
    name: 'Tiling',
    description: 'Auto-arrange every window in an equal-sized grid. Resizes with the desktop; new windows reflow the existing slots.',
    icon: '▦',
  },
  {
    id: 'fullscreen',
    name: 'Fullscreen',
    description: 'One window fills the desktop; the rest are kept running but hidden. Switch focus via Process Manager.',
    icon: '▣',
    minViews: 1,
  },
  {
    // id stays 'stack' so existing persisted workspaces don't break; the
    // user-facing name is "Free Window" since the strategy is traditional
    // floating-WM behavior, not vertical row stacking.
    id: 'stack',
    name: 'Free Window',
    description: 'Free-positioned floating windows you can drag and resize. Position persists per-workspace.',
    icon: '▥',
    supportsManualPlacement: true,
  },
  {
    id: 'rows',
    name: 'Rows',
    description: 'Each window gets its own full-width row, stacked top to bottom. New windows pile on at the bottom.',
    icon: '▤',
  },
];

/**
 * Singleton on globalThis so Vite/Astro's multiple module graphs (SSR
 * route handlers, page SSR, plugin context) all see the same instance —
 * same pattern as `OsEventBus`. Without this, a strategy registered from
 * one graph wouldn't be visible from another.
 */
const GLOBAL_KEY = '__aura_layout_registry__';
type GlobalWithRegistry = typeof globalThis & { [GLOBAL_KEY]?: LayoutStrategyRegistry };

const existing = (globalThis as GlobalWithRegistry)[GLOBAL_KEY];
export const layoutRegistry: LayoutStrategyRegistry =
  existing ?? new LayoutStrategyRegistry(DEFAULT_LAYOUT_STRATEGIES);
if (!existing) (globalThis as GlobalWithRegistry)[GLOBAL_KEY] = layoutRegistry;
