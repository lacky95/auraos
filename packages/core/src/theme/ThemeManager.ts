/**
 * OS theme system v2 — flat tone model.
 *
 * Each theme is intrinsically `light` or `dark`. The user picks ONE light theme
 * and ONE dark theme; `colorMode` (light/dark/auto) decides which is active.
 *
 *   user prefs:  themeIdLight = 'paper'   themeIdDark = 'sci-fi'   colorMode = 'auto'
 *   active:      resolvedMode = 'dark'  →  active theme = sci-fi
 *
 * Apps consume the OS palette via `<link rel="stylesheet" href="/api/os/theme.css">`
 * (auto-injected by the proxy for `themeStrategy='inherit'` apps) and read the
 * resolved `var(--aura-color-*)` values; mode/theme switching is broadcast over
 * SSE and the live `<style id="aura-theme">` block is swapped in place.
 *
 * Adding more themes: append to `THEMES` below. Specify `tone` and a single
 * `palette`. No code changes needed elsewhere.
 */

export interface DesignFramework {
  id:      string;   // 'scificn'
  name:    string;   // 'sci-fi/cn'
  source:  string;   // 'https://www.scificn.dev'
  version: string;   // '0.1.0'
}

export interface ColorPalette {
  // Accents
  primary:   string;
  secondary: string;
  danger:    string;
  info:      string;   // cyan-ish notification / info accent
  warning:   string;   // amber-ish caution
  success:   string;   // green-ish confirmation

  // Surfaces
  bg:        string;
  surface:   string;
  surface2:  string;

  // Text + lines
  text:      string;
  textDim:   string;
  border:    string;  // rgba allowed; usually accent-tinted at low alpha

  // Glows — designed per theme; light-theme glows should be weak
  glowPrimary:   string;
  glowSecondary: string;
  glowDanger:    string;
  glowSubtle:    string;
}

/** A theme is intrinsically either a light or a dark scheme. */
export type ThemeTone = 'light' | 'dark';

export interface OsTheme {
  id:           string;
  name:         string;
  description?: string;   // one-liner for theme picker tooltip
  tags?:        string[]; // free-form: ['warm', 'high-contrast', 'phosphor']
  tone:         ThemeTone;
  framework:    DesignFramework;
  palette:      ColorPalette;
}

/** User preference. `'auto'` defers to `prefers-color-scheme`. */
export type ColorMode    = 'light' | 'dark' | 'auto';
/** What the active palette actually is right now (`auto` resolved). */
export type ResolvedMode = 'light' | 'dark';

/** Lightweight summary used by the theme inventory provider. */
export interface ThemeSummary {
  id:           string;
  name:         string;
  description?: string;
  tags?:        string[];
  tone:         ThemeTone;
  framework:    DesignFramework;
}

const SCIFICN_FRAMEWORK: DesignFramework = {
  id:      'scificn',
  name:    'sci-fi/cn',
  source:  'https://www.scificn.dev',
  version: '0.1.0',
};

// ----- THEMES -----
//
// Dark themes: SCI-FI / STAR WARS / ALIEN approximate the three themes that the
// scificn library ships, plus our additions (AMBER, RED ALERT, CYAN). The
// scificn lib itself ships no light/dark axis — we layer light themes on top.
//
// Semantic colors (`danger` / `warning` / `info` / `success`) are SHARED across
// all themes of a given tone — a red error should look like an error in every
// theme, not a desaturated theme-tinted hint. Brand color slots (`primary`,
// `secondary`) stay per-theme. Spread `DARK_SEMANTIC` / `LIGHT_SEMANTIC` into
// each palette so the contract is enforced by structure, not discipline.

/** Universal status colors for all dark themes. */
const DARK_SEMANTIC = {
  danger:  '#ff2020',   // bright red — error / destructive
  warning: '#ffd166',   // amber — caution
  info:    '#00aaff',   // cyan — informational
  success: '#7acc4d',   // green — confirmation (distinct from primary in green themes)
} as const;

/** Universal status colors for all light themes — desaturated for contrast on bright bg. */
const LIGHT_SEMANTIC = {
  danger:  '#c50f0f',
  warning: '#b35a00',
  info:    '#0277bd',
  success: '#1f7a3a',
} as const;

const sciFi: OsTheme = {
  id:          'sci-fi',
  name:        'SCI-FI',
  description: 'Classic phosphor terminal — green-on-black.',
  tags:        ['scificn', 'phosphor', 'high-contrast'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#00ff41',
    secondary: '#ff9900',
    ...DARK_SEMANTIC,
    bg:        '#0a0a0a',
    surface:   '#111111',
    surface2:  '#161616',
    text:      '#ccffcc',
    textDim:   '#557755',
    border:    'rgba(0, 255, 65, 0.20)',
    glowPrimary:   '0 0 4px #00ff41, 0 0 8px rgba(0, 255, 65, 0.18)',
    glowSecondary: '0 0 4px #ff9900, 0 0 8px rgba(255, 153, 0, 0.18)',
    glowDanger:    '0 0 4px #ff2020, 0 0 8px rgba(255, 32, 32, 0.18)',
    glowSubtle:    '0 0 2px rgba(0, 255, 65, 0.18)',
  },
};

const starWars: OsTheme = {
  id:          'star-wars',
  name:        'STAR WARS',
  description: 'Crawl-text yellow on pure black — a long time ago…',
  tags:        ['scificn', 'cinematic', 'high-contrast'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#ffe81f',   // the canonical Star Wars title yellow
    secondary: '#ff9900',
    ...DARK_SEMANTIC,
    bg:        '#000000',
    surface:   '#0a0a0a',
    surface2:  '#141414',
    text:      '#ffe9a0',
    textDim:   '#7a6a30',
    border:    'rgba(255, 232, 31, 0.20)',
    glowPrimary:   '0 0 5px #ffe81f, 0 0 10px rgba(255, 232, 31, 0.18)',
    glowSecondary: '0 0 4px #ff9900, 0 0 8px rgba(255, 153, 0, 0.18)',
    glowDanger:    '0 0 4px #ff2020, 0 0 8px rgba(255, 32, 32, 0.18)',
    glowSubtle:    '0 0 2px rgba(255, 232, 31, 0.15)',
  },
};

const alien: OsTheme = {
  id:          'alien',
  name:        'ALIEN',
  description: 'Nostromo monitor green — industrial readout.',
  tags:        ['scificn', 'industrial'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#48ff00',
    secondary: '#a8c800',
    ...DARK_SEMANTIC,
    bg:        '#050a05',
    surface:   '#0a1006',
    surface2:  '#101a0a',
    text:      '#c0ffaa',
    textDim:   '#5a8a3a',
    border:    'rgba(72, 255, 0, 0.22)',
    glowPrimary:   '0 0 4px #48ff00, 0 0 8px rgba(72, 255, 0, 0.18)',
    glowSecondary: '0 0 3px #a8c800, 0 0 6px rgba(168, 200, 0, 0.18)',
    glowDanger:    '0 0 4px #ff2020, 0 0 8px rgba(255, 32, 32, 0.18)',
    glowSubtle:    '0 0 2px rgba(72, 255, 0, 0.15)',
  },
};

const amber: OsTheme = {
  id:          'amber',
  name:        'AMBER',
  description: 'Vintage amber terminal — warm, glowy.',
  tags:        ['warm', 'phosphor'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#ff9900',
    secondary: '#ffd166',
    ...DARK_SEMANTIC,
    bg:        '#0a0805',
    surface:   '#141008',
    surface2:  '#1d160b',
    text:      '#ffe9c2',
    textDim:   '#8a6b3a',
    border:    'rgba(255, 153, 0, 0.20)',
    glowPrimary:   '0 0 4px #ff9900, 0 0 8px rgba(255, 153, 0, 0.18)',
    glowSecondary: '0 0 4px #ffd166, 0 0 8px rgba(255, 209, 102, 0.18)',
    glowDanger:    '0 0 4px #ff2020, 0 0 8px rgba(255, 32, 32, 0.18)',
    glowSubtle:    '0 0 2px rgba(255, 153, 0, 0.18)',
  },
};

const redAlert: OsTheme = {
  id:          'red-alert',
  name:        'RED ALERT',
  description: 'Critical-warning crimson; danger flips to yellow for contrast.',
  tags:        ['warm', 'high-contrast', 'alert'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#ff2020',
    secondary: '#ff7070',
    ...DARK_SEMANTIC,
    bg:        '#0a0303',
    surface:   '#160808',
    surface2:  '#1f0a0a',
    text:      '#ffcccc',
    textDim:   '#7a4040',
    border:    'rgba(255, 32, 32, 0.25)',
    glowPrimary:   '0 0 4px #ff2020, 0 0 9px rgba(255, 32, 32, 0.22)',
    glowSecondary: '0 0 4px #ff7070, 0 0 8px rgba(255, 112, 112, 0.18)',
    glowDanger:    '0 0 4px #ffea00, 0 0 8px rgba(255, 234, 0, 0.18)',
    glowSubtle:    '0 0 2px rgba(255, 32, 32, 0.18)',
  },
};

const cyan: OsTheme = {
  id:          'cyan',
  name:        'CYAN',
  description: 'Cool cyan retro-future — bridge-display blue.',
  tags:        ['cool'],
  tone:        'dark',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#00aaff',
    secondary: '#88ddff',
    ...DARK_SEMANTIC,
    bg:        '#04080a',
    surface:   '#0a1014',
    surface2:  '#0e1820',
    text:      '#ccecff',
    textDim:   '#557788',
    border:    'rgba(0, 170, 255, 0.20)',
    glowPrimary:   '0 0 4px #00aaff, 0 0 8px rgba(0, 170, 255, 0.18)',
    glowSecondary: '0 0 4px #88ddff, 0 0 8px rgba(136, 221, 255, 0.18)',
    glowDanger:    '0 0 4px #ff2020, 0 0 8px rgba(255, 32, 32, 0.18)',
    glowSubtle:    '0 0 2px rgba(0, 170, 255, 0.18)',
  },
};

// ---- Light themes ----
//
// Light glows are intentionally weak (small radius, low alpha) — bloom on a
// bright background looks like a printing defect.

const paper: OsTheme = {
  id:          'paper',
  name:        'PAPER',
  description: 'Phosphor green on cream — printout / blueprint.',
  tags:        ['paper', 'cool'],
  tone:        'light',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#007a1f',
    secondary: '#b35a00',
    ...LIGHT_SEMANTIC,
    bg:        '#f4f7f1',
    surface:   '#e8ede2',
    surface2:  '#dde3d4',
    text:      '#142014',
    textDim:   '#5a6a5a',
    border:    'rgba(0, 122, 31, 0.25)',
    glowPrimary:   '0 0 2px rgba(0, 122, 31, 0.22)',
    glowSecondary: '0 0 2px rgba(179, 90, 0, 0.18)',
    glowDanger:    '0 0 2px rgba(197, 15, 15, 0.18)',
    glowSubtle:    '0 0 1px rgba(0, 122, 31, 0.12)',
  },
};

const parchment: OsTheme = {
  id:          'parchment',
  name:        'PARCHMENT',
  description: 'Amber ink on parchment — warm, low-glare.',
  tags:        ['paper', 'warm'],
  tone:        'light',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#b35a00',
    secondary: '#c79100',
    ...LIGHT_SEMANTIC,
    bg:        '#fffaf0',
    surface:   '#fbeed6',
    surface2:  '#f5e3c0',
    text:      '#3a2606',
    textDim:   '#806a3a',
    border:    'rgba(179, 90, 0, 0.25)',
    glowPrimary:   '0 0 2px rgba(179, 90, 0, 0.22)',
    glowSecondary: '0 0 2px rgba(199, 145, 0, 0.18)',
    glowDanger:    '0 0 2px rgba(197, 15, 15, 0.18)',
    glowSubtle:    '0 0 1px rgba(179, 90, 0, 0.12)',
  },
};

const mist: OsTheme = {
  id:          'mist',
  name:        'MIST',
  description: 'Cool cyan-on-mist — clinical, calm.',
  tags:        ['paper', 'cool'],
  tone:        'light',
  framework:   SCIFICN_FRAMEWORK,
  palette: {
    primary:   '#00688b',
    secondary: '#0277bd',
    ...LIGHT_SEMANTIC,
    bg:        '#f1f7fa',
    surface:   '#dceaf2',
    surface2:  '#c8dde9',
    text:      '#0a1a22',
    textDim:   '#557788',
    border:    'rgba(0, 104, 139, 0.25)',
    glowPrimary:   '0 0 2px rgba(0, 104, 139, 0.22)',
    glowSecondary: '0 0 2px rgba(2, 119, 189, 0.18)',
    glowDanger:    '0 0 2px rgba(197, 15, 15, 0.18)',
    glowSubtle:    '0 0 1px rgba(0, 104, 139, 0.12)',
  },
};

// ----- Manager -----

export class ThemeManager {
  /**
   * The OS commits to a single design framework at runtime. The shape of
   * `OsTheme` allows different frameworks per theme (forward-compatible), but
   * the static check below ensures that's not the case today — apps can cache
   * `getDesignFramework()` for the session and trust it won't change.
   *
   * Lift this invariant when we actually ship a second framework.
   */
  static readonly OS_FRAMEWORK_ID = 'scificn';

  static readonly THEMES: readonly OsTheme[] = [
    // dark
    sciFi, starWars, alien, amber, redAlert, cyan,
    // light
    paper, parchment, mist,
  ];

  /** Default pick for the dark slot when no user pref exists. */
  static readonly DEFAULT_THEME_ID_DARK  = 'sci-fi';
  /** Default pick for the light slot when no user pref exists. */
  static readonly DEFAULT_THEME_ID_LIGHT = 'paper';
  /** Backwards-compat alias — most call sites still want "the active dark theme". */
  static readonly DEFAULT_THEME_ID       = ThemeManager.DEFAULT_THEME_ID_DARK;
  static readonly DEFAULT_COLOR_MODE: ColorMode = 'dark';

  static {
    // Boot-time framework-uniformity invariant.
    for (const t of ThemeManager.THEMES) {
      if (t.framework.id !== ThemeManager.OS_FRAMEWORK_ID) {
        throw new Error(
          `[ThemeManager] Theme '${t.id}' uses framework '${t.framework.id}', expected '${ThemeManager.OS_FRAMEWORK_ID}'. ` +
          `Multi-framework support is not yet implemented — keep all themes on the same framework.`,
        );
      }
    }
  }

  static getThemes(): readonly OsTheme[] {
    return ThemeManager.THEMES;
  }

  static getTheme(id: string): OsTheme | undefined {
    return ThemeManager.THEMES.find((t) => t.id === id);
  }

  /** All themes filtered by tone — used by the Settings UI for the two pickers. */
  static getThemesByTone(tone: ThemeTone): OsTheme[] {
    return ThemeManager.THEMES.filter((t) => t.tone === tone);
  }

  /** Inventory of themes minus the full palettes — light-bandwidth listing for apps. */
  static listSummaries(): ThemeSummary[] {
    return ThemeManager.THEMES.map((t) => ({
      id:          t.id,
      name:        t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.tags        !== undefined ? { tags:        t.tags        } : {}),
      tone:        t.tone,
      framework:   t.framework,
    }));
  }

  static getDesignFramework(themeId: string): DesignFramework {
    return (ThemeManager.getTheme(themeId) ?? ThemeManager.getTheme(ThemeManager.DEFAULT_THEME_ID)!).framework;
  }

  /** Default per-tone theme id when no user pref exists. */
  static getDefaultForTone(tone: ThemeTone): string {
    return tone === 'light' ? ThemeManager.DEFAULT_THEME_ID_LIGHT : ThemeManager.DEFAULT_THEME_ID_DARK;
  }

  /**
   * Resolve a `ColorMode` to a concrete `'light' | 'dark'`. `auto` defaults to
   * `'dark'` server-side (the SSR fallback); the @media block in the emitted
   * CSS lets the client swap to `light` automatically based on
   * `prefers-color-scheme`.
   */
  static resolveMode(mode: ColorMode): ResolvedMode {
    return mode === 'light' ? 'light' : 'dark';
  }

  /**
   * Pick the active theme given the user's two prefs + colorMode. Falls back to
   * the per-tone default if the requested id is unknown, or to the OS default
   * theme if THAT is also missing.
   */
  static resolveActiveTheme(
    themeIdLight: string,
    themeIdDark:  string,
    mode:         ColorMode,
  ): { theme: OsTheme; resolvedMode: ResolvedMode } {
    const resolvedMode = ThemeManager.resolveMode(mode);
    const wantedId     = resolvedMode === 'light' ? themeIdLight : themeIdDark;
    const wanted       = ThemeManager.getTheme(wantedId);
    const themed       = wanted && wanted.tone === resolvedMode ? wanted : undefined;
    if (themed) return { theme: themed, resolvedMode };
    // Fallback: per-tone default. The default ids ALWAYS exist (asserted below).
    const fallback = ThemeManager.getTheme(ThemeManager.getDefaultForTone(resolvedMode))
                  ?? ThemeManager.getTheme(ThemeManager.DEFAULT_THEME_ID)!;
    return { theme: fallback, resolvedMode };
  }

  /** Active palette for the given selection — for callers that don't need the full theme. */
  static getActivePalette(themeIdLight: string, themeIdDark: string, mode: ColorMode): ColorPalette {
    return ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, mode).theme.palette;
  }

  /**
   * Render the active CSS document.
   *
   *   • `:root` exposes the active theme's palette as `--aura-color-*`.
   *   • Always emits both `--aura-light-color-*` and `--aura-dark-color-*`
   *     (resolved from the user's two prefs) so apps can pin a tone.
   *   • For `mode === 'auto'`, additionally emits a `prefers-color-scheme: light`
   *     block that flips `--aura-color-*` to the light theme's palette
   *     without JS.
   */
  static toCss(themeIdLight: string, themeIdDark: string, mode: ColorMode = ThemeManager.DEFAULT_COLOR_MODE): string {
    const lightTheme = ThemeManager.getTheme(themeIdLight) ?? ThemeManager.getTheme(ThemeManager.DEFAULT_THEME_ID_LIGHT)!;
    const darkTheme  = ThemeManager.getTheme(themeIdDark)  ?? ThemeManager.getTheme(ThemeManager.DEFAULT_THEME_ID_DARK)!;
    const { theme: active, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, mode);

    const lines: string[] = [];
    lines.push(':root {');
    lines.push(`  --aura-design-framework: ${active.framework.id};`);
    lines.push(`  --aura-design-framework-version: ${active.framework.version};`);
    lines.push(`  --aura-color-mode: ${mode};`);
    lines.push(`  --aura-resolved-mode: ${resolvedMode};`);
    lines.push(`  --aura-theme-id: ${active.id};`);
    lines.push(`  --aura-theme-id-light: ${lightTheme.id};`);
    lines.push(`  --aura-theme-id-dark: ${darkTheme.id};`);
    for (const [k, v] of paletteVars(active.palette,      '')) lines.push(`  ${k}: ${v};`);
    for (const [k, v] of paletteVars(lightTheme.palette,  'light-')) lines.push(`  ${k}: ${v};`);
    for (const [k, v] of paletteVars(darkTheme.palette,   'dark-' )) lines.push(`  ${k}: ${v};`);
    lines.push('}');

    if (mode === 'auto') {
      lines.push('@media (prefers-color-scheme: light) {');
      lines.push('  :root {');
      lines.push(`    --aura-color-mode: auto;`);
      lines.push(`    --aura-resolved-mode: light;`);
      lines.push(`    --aura-theme-id: ${lightTheme.id};`);
      for (const [k, v] of paletteVars(lightTheme.palette, '')) lines.push(`    ${k}: ${v};`);
      lines.push('  }');
      lines.push('}');
    }

    return lines.join('\n') + '\n';
  }
}

// ----- internals -----

/** Map a `ColorPalette` to `--aura-<prefix>color-*` / `--aura-<prefix>glow-*` entries. */
function paletteVars(p: ColorPalette, prefix: string): Array<[string, string]> {
  return [
    [`--aura-${prefix}color-primary`,   p.primary],
    [`--aura-${prefix}color-secondary`, p.secondary],
    [`--aura-${prefix}color-danger`,    p.danger],
    [`--aura-${prefix}color-info`,      p.info],
    [`--aura-${prefix}color-warning`,   p.warning],
    [`--aura-${prefix}color-success`,   p.success],
    [`--aura-${prefix}color-bg`,        p.bg],
    [`--aura-${prefix}color-surface`,   p.surface],
    [`--aura-${prefix}color-surface-2`, p.surface2],
    [`--aura-${prefix}color-text`,      p.text],
    [`--aura-${prefix}color-text-dim`,  p.textDim],
    [`--aura-${prefix}color-border`,    p.border],
    [`--aura-${prefix}glow-primary`,    p.glowPrimary],
    [`--aura-${prefix}glow-secondary`,  p.glowSecondary],
    [`--aura-${prefix}glow-danger`,     p.glowDanger],
    [`--aura-${prefix}glow-subtle`,     p.glowSubtle],
  ];
}
