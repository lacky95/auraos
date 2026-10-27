/**
 * Layout-manager SDK — the contract between the shell desktop
 * (`pages/index.astro` renderLayout) and a layout strategy.
 *
 * The core `layoutRegistry` (packages/core/src/layout) owns a strategy's
 * METADATA (id, name, icon — what `/api/os/layouts` lists). This module owns
 * its BEHAVIOUR in the browser: how windows are placed, what the layout adds
 * to the desktop's content space, which window controls it changes.
 *
 * Every hook except `containerStyle` + `place` is optional, so a simple grid
 * layout is ~20 lines (see strategies/grid.ts) and a full window manager
 * (strategies/freeWindow) uses the same surface — nothing in the shell is
 * specific to one layout.
 *
 * Extension points:
 *   • `regions`      — bars inside the content space (top/bottom/left/right).
 *                      App windows get the remaining box, so maximize, clamping
 *                      and the viewport broadcast all respect the bar.
 *   • overlay layer  — `host.overlay()`: a layer above the windows for
 *                      previews, splitters, guides. pointer-events:none except
 *                      on the children that opt back in.
 *   • `minimize`     — 'hide' gives every window a minimize control that hides
 *                      it with its app alive (iframe kept); the host persists
 *                      the list in `layoutState.minimized`.
 *   • `chromeButtons`/`onChromeAction` — extra title-bar buttons.
 *   • `onActivate`   — the user interacted with a window (title, content,
 *                      even a click inside the app iframe).
 *   • `dragPolicy`   — title-bar drag & drop between windows / workspaces
 *                      (lib/windowDrag.ts).
 */
import type { LayoutDragPolicy } from '../windowDrag.ts';

/** What a strategy knows about one window. */
export interface LayoutViewInfo {
  viewId:      string;
  appId:       string;
  title:       string;
  /** The user's ephemeral window label, if set. */
  windowName?: string;
  /** Hidden by a `minimize: 'hide'` layout (app still alive). */
  minimized:   boolean;
  isFocused:   boolean;
}

export type RegionSide = 'top' | 'bottom' | 'left' | 'right';

export interface LayoutRegion {
  /** Build the region's DOM into `container` (an empty element the host
   *  placed on that side of the content space). Size it with CSS — the host
   *  measures the container and gives the windows what is left. */
  mount(container: HTMLElement, host: LayoutHost): void;
  /** Called after every render pass (window opened/closed/minimized/focus). */
  update?(host: LayoutHost): void;
  unmount?(): void;
}

export interface ChromeButton {
  /** Routed back to `onChromeAction(action, …)`. */
  action: string;
  title:  string;
  /** Inner HTML (glyph or `<svg class="aura-icon">`). */
  html:   string;
  pressed?: boolean;
}

/** One render pass, as the host computed it. */
export interface LayoutRenderContext {
  /** Visible windows of the active workspace, in workspace member order. */
  visible:     LayoutViewInfo[];
  /** First grid row free for windows — 2 while the host's minimized strip
   *  occupies row 1, else 1. Only grid layouts care. */
  baseRow:     number;
  /** True when the host shows its minimized strip in this pass. */
  stripShown:  boolean;
  layoutState: Readonly<Record<string, unknown>>;
}

export interface ShellLayoutStrategy {
  /** Must match a core layoutRegistry id. */
  id: string;
  /** 'unmount' (default): the host's classic minimize — the slot is torn down
   *  and the window listed in the minimized strip. 'hide': every window gets
   *  a minimize control, the slot is hidden and its app keeps running. */
  minimize?: 'unmount' | 'hide';
  /** Show the host's "MIN ▾" strip. Default true; a layout that lists
   *  minimized windows itself (a taskbar) turns it off. */
  showsMinimizedStrip?: boolean;
  dragPolicy?: LayoutDragPolicy;
  regions?: Partial<Record<RegionSide, LayoutRegion>>;

  /** The strategy became active for the shown workspace / was switched away. */
  activate?(host: LayoutHost): void;
  deactivate?(host: LayoutHost): void;

  /** Container styles for the windows area (grid template, display…). */
  containerStyle(ctx: LayoutRenderContext): Partial<CSSStyleDeclaration>;
  /** Position one visible, non-maximized window. */
  place(el: HTMLElement, view: LayoutViewInfo, index: number, ctx: LayoutRenderContext, host: LayoutHost): void;
  /** Undo `place` — the window is being maximized, hidden, or the layout is
   *  being switched away. Must leave no inline geometry or listeners. */
  release?(el: HTMLElement): void;
  /** After all windows were placed. */
  afterRender?(ctx: LayoutRenderContext, host: LayoutHost): void;

  onActivate?(viewId: string, host: LayoutHost): void;
  chromeButtons?(view: LayoutViewInfo, host: LayoutHost): ChromeButton[];
  onChromeAction?(action: string, viewId: string, host: LayoutHost): void;
}

/** What the shell hands to a strategy. Narrow on purpose: a strategy never
 *  reaches into the shell's view list or the workspace client directly. */
export interface LayoutHost {
  /** The windows area (`#dynamic-layout`). */
  readonly container: HTMLElement;
  /** Layer above the windows, same box as `container`. */
  overlay(): HTMLElement;
  /** Every window of the active workspace, minimized ones included. */
  views(): LayoutViewInfo[];
  slotOf(viewId: string): HTMLElement | null;
  /** Window maximized in place (focus mode), if any. */
  maximizedViewId(): string | null;

  layoutState(): Readonly<Record<string, unknown>>;
  /** Shallow-merge into the active workspace's layoutState (debounced write).
   *  `undefined` values delete the key. Triggers a render. */
  patchLayoutState(patch: Record<string, unknown>): void;

  focus(viewId: string): void;
  minimize(viewId: string): void;
  restore(viewId: string): void;
  close(viewId: string): void;
  toggleMaximize(viewId: string): void;

  requestRender(): void;
  /** Tell every app iframe its (new) box once — after a gesture ends. */
  broadcastViewport(): void;
  /** Mute per-iframe resize broadcasts during a live gesture. */
  setGestureActive(on: boolean): void;
  /** Convert a pointer event's client coordinates into `container`-local
   *  CSS pixels (accounts for the shell's zoom transform). */
  toLocal(clientX: number, clientY: number): { x: number; y: number; scale: number };
}
