/**
 * OS icon system — Lucide is the AuraOS default icon set.
 *
 * Icons are rendered server-side from the vanilla `lucide` package's icon
 * data (no DOM, no client JS), in two shapes:
 *
 *   • `renderIconSvg('settings')` — a standalone inline `<svg>` string.
 *     The shell's `Icon.astro` uses this to render chrome icons at SSR time.
 *   • `renderSprite(names)` — a `<symbol>` sprite document. Served at
 *     `/api/os/icons.svg` so themed apps can use any curated icon with zero
 *     npm dependency:
 *
 *       <svg class="aura-icon"><use href="/api/os/icons.svg#lucide-settings"/></svg>
 *
 * Every icon strokes `currentColor`, so it follows the active theme's text
 * color (or whatever `color` the surrounding element sets) automatically.
 * The long tail (any of Lucide's ~2000 icons) is available individually at
 * `/api/os/icons/<name>.svg`.
 *
 * Names are Lucide's kebab-case ids (`rotate-cw`, `mic-off`); PascalCase is
 * accepted too. Browse the catalogue at https://lucide.dev/icons.
 */

import { icons } from 'lucide';

/** One lucide icon: a list of `[tag, attributes]` child nodes. */
type IconNode = ReadonlyArray<readonly [string, Record<string, string | number>]>;

export interface IconRenderOptions {
  /** Width/height — px number or any CSS length (e.g. '1em'). Default 24. */
  size?: number | string;
  /** Stroke width on the 24px grid. Default 2. */
  strokeWidth?: number;
  /** Extra class attribute for the root `<svg>`. */
  class?: string;
  /** Extra attributes for the root `<svg>` (e.g. aria-hidden). */
  attrs?: Record<string, string>;
}

/**
 * Curated set served in the `/api/os/icons.svg` sprite: every icon the shell
 * chrome uses plus the common vocabulary apps reach for. Extend freely —
 * each name adds ~150 bytes to the sprite. Anything not listed here is still
 * reachable at `/api/os/icons/<name>.svg`.
 */
export const CURATED_ICONS: readonly string[] = [
  // shell chrome
  'settings', 'maximize', 'unfold-vertical', 'layout-grid', 'square',
  'columns-2', 'rotate-cw', 'chevron-right', 'chevron-left', 'chevron-up',
  'chevron-down', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down',
  'panel-left', 'ellipsis', 'circle-dot', 'circle', 'menu', 'x',
  'corner-down-right', 'circle-x', 'layout-template', 'rows-3',
  // common vocabulary
  'check', 'plus', 'minus', 'trash-2', 'search', 'info', 'alert-triangle',
  'alert-circle', 'octagon-alert', 'mic', 'mic-off', 'volume-2', 'volume-x',
  'phone', 'phone-off', 'play', 'pause', 'loader-2', 'refresh-cw',
  'external-link', 'copy', 'clipboard', 'file', 'file-text', 'folder',
  'folder-open', 'home', 'user', 'users', 'lock', 'unlock', 'eye', 'eye-off',
  'download', 'upload', 'terminal', 'list', 'grip', 'star', 'heart', 'bell',
  'bell-off', 'calendar', 'clock', 'camera', 'image', 'link', 'mail',
  'message-square', 'send', 'save', 'pencil', 'plug', 'power', 'wifi',
  'wifi-off', 'sun', 'moon', 'zap', 'filter', 'log-out', 'log-in',
  'more-vertical', 'more-horizontal', 'sliders-horizontal', 'globe',
  'database', 'server', 'cpu', 'hard-drive', 'activity', 'bug', 'shield',
  'key', 'help-circle', 'minimize', 'expand', 'shrink',
];

export class IconManager {
  /** True if `name` (kebab or PascalCase) is a known Lucide icon. */
  static has(name: string): boolean {
    return getIconNode(name) !== undefined;
  }

  /** Render one icon as a standalone inline `<svg>` string, or undefined for unknown names. */
  static renderIconSvg(name: string, opts: IconRenderOptions = {}): string | undefined {
    const node = getIconNode(name);
    if (!node) return undefined;
    const size = opts.size ?? 24;
    const attrs: Record<string, string> = {
      xmlns: 'http://www.w3.org/2000/svg',
      width: String(size),
      height: String(size),
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': String(opts.strokeWidth ?? 2),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      ...(opts.class ? { class: opts.class } : {}),
      ...(opts.attrs ?? {}),
    };
    return `<svg ${attrString(attrs)}>${childMarkup(node)}</svg>`;
  }

  /**
   * Render a `<symbol>` sprite for the given icon names (unknown names are
   * skipped). Symbol ids are `lucide-<kebab-name>`, referenced via
   * `<use href="...#lucide-<name>">`. Stroke styling lives on each symbol so
   * consumers only size the outer `<svg>`.
   */
  static renderSprite(names: readonly string[] = CURATED_ICONS): string {
    const symbols: string[] = [];
    for (const name of names) {
      const node = getIconNode(name);
      if (!node) continue;
      const id = `lucide-${toKebab(name)}`;
      symbols.push(
        `<symbol id="${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
        `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${childMarkup(node)}</symbol>`
      );
    }
    return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>\n`;
  }
}

// ----- internals -----

function getIconNode(name: string): IconNode | undefined {
  const table = icons as Record<string, IconNode>;
  return table[toPascal(name)];
}

function toPascal(name: string): string {
  return name
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function toKebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/-+/g, '-').toLowerCase();
}

function childMarkup(node: IconNode): string {
  return node.map(([tag, attrs]) => `<${tag} ${attrString(attrs)}/>`).join('');
}

function attrString(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
    .join(' ');
}
