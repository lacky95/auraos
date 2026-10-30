/**
 * The markup of one desktop activity slot (title bar + body), shared by the
 * browser (`createSlot` in pages/index.astro) and the server render of the
 * active workspace. Server and browser must produce the SAME structure: the
 * desktop script adopts the server-rendered slots in place instead of
 * recreating them, because recreating — or moving — an iframe reloads the app.
 * Pure strings, no DOM: safe on the server.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Inline style of the slot element itself. */
export const SLOT_STYLE = 'display:flex;flex-direction:column;background:var(--aura-color-surface);border:var(--aura-border);overflow:clip;';

/** Inline style of an activity iframe inside `.slot-body`. */
export const IFRAME_STYLE = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:transparent;';

const BTN_STYLE = 'background:transparent;border:var(--aura-border);color:var(--aura-color-text-dim);font-family:var(--aura-font-mono);font-size:0.65rem;padding:2px 10px;cursor:pointer;line-height:1;';

const icon = (name: string) => `<svg class="aura-icon" aria-hidden="true"><use href="/api/os/icons.svg#lucide-${name}"/></svg>`;

/**
 * innerHTML of a slot: the title bar with every control, and the body.
 * `bodyHtml` goes inside `.slot-body` (the server passes the iframe; the
 * browser leaves it empty and lets updateSlot() add skeleton + iframe).
 * Dynamic parts (title trail, window name, layout buttons, focus state) are
 * filled by updateSlot() on both paths.
 */
export function slotInnerHtml(opts: { minimizable?: boolean; bodyHtml?: string }): string {
  // Rendered for every activity; updateSlot() shows it when the view is
  // minimizable OR the active layout minimizes by hiding (keeps the app
  // alive, so any activity can be minimized there).
  const minimizeBtn = `<button data-action="minimize" class="slot-minimize-btn" title="Minimize" style="${BTN_STYLE}${opts.minimizable ? '' : ';display:none;'}">_</button>`;
  // Title-bar buttons contributed by the active layout strategy
  // (ShellLayoutStrategy.chromeButtons) — filled by updateSlot().
  const layoutBtns = `<span class="slot-layout-btns" style="display:contents;"></span>`;
  // Maximize == in-place focus: promote this slot to fill the desktop
  // WITHOUT reloading its iframe. updateSlot() swaps the glyph/title to a
  // restore affordance while this view is the maximized one.
  const maximizeBtn = `<button data-action="maximize" class="slot-maximize-btn" title="Focus this window (maximize)" style="${BTN_STYLE}">[ ]</button>`;
  // Full-size (focus mode only): toggles the maximized window between filling
  // the DESKTOP area and covering the ENTIRE shell. Hidden until this window is
  // the maximized one — updateSlot() reveals it + swaps its glyph.
  const fullSizeBtn = `<button data-action="maximize-full" class="slot-fullsize-btn" title="Full size (cover bars)" style="${BTN_STYLE};display:none;">${icon('maximize')}</button>`;
  // Refresh = reload the iframe in place; left of minimize, away from close.
  const refreshBtn = `<button data-action="refresh" title="Reload window" style="${BTN_STYLE}">${icon('rotate-cw')}</button>`;
  // Rename = set this window's ephemeral user label. Leftmost control.
  const renameBtn = `<button data-action="rename" title="Name this window" style="${BTN_STYLE}">${icon('pencil')}</button>`;
  return `
      <div class="slot-chrome" style="display:flex;align-items:center;justify-content:space-between;padding:0 8px;height:28px;background:var(--aura-color-surface-2);border-bottom:var(--aura-border);flex-shrink:0;gap:8px;min-width:0;">
        <div class="slot-title" title="Double-click to name this window" style="flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow:hidden;color:var(--aura-color-primary);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.08em;">
          <span class="slot-window-name" style="display:none;flex-shrink:0;max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;background:var(--aura-color-surface);border:var(--aura-border);color:var(--aura-color-primary);text-transform:none;letter-spacing:0.04em;"></span>
          <span class="slot-title-trail" style="display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow:hidden;"></span>
          <span class="slot-title-id" style="color:var(--aura-color-text-dim);font-size:0.6rem;flex-shrink:0;"></span>
        </div>
        <div class="slot-controls" style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
          <span class="slot-focus-hint" style="display:none;align-items:center;gap:4px;margin-right:4px;padding:1px 6px;border:1px solid var(--aura-color-primary);color:var(--aura-color-primary);font-family:var(--aura-font-mono);font-size:0.55rem;letter-spacing:0.1em;white-space:nowrap;">${icon('circle-dot')} FOCUS · ESC</span>
          ${renameBtn}
          ${layoutBtns}
          ${refreshBtn}
          ${minimizeBtn}
          ${maximizeBtn}
          ${fullSizeBtn}
          <button data-action="close" class="slot-close-btn" title="Close" style="${BTN_STYLE}">${icon('x')}</button>
        </div>
      </div>
      <div class="slot-body" style="flex:1;overflow:clip;position:relative;">${opts.bodyHtml ?? ''}</div>`;
}

/** Server-side iframe markup for an activity that loads right away. */
export function iframeHtml(src: string, title: string): string {
  return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(title)}" style="${IFRAME_STYLE}"></iframe>`;
}
