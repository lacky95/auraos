/**
 * OS theme presets. Each theme is a flat map of CSS custom properties that
 * override the static `:root` declarations in `packages/shell/src/styles/tokens.css`.
 *
 * The shell injects a `<style id="aura-theme">` block built from the current
 * theme. Apps can pull `/api/os/theme.css` to receive the same vars in their
 * own iframe context.
 *
 * Adding more themes: append to `THEMES` below. No code changes needed elsewhere.
 */

export interface OsTheme {
  id: string;
  name: string;
  vars: Record<string, string>;
}

const phosphorGreen: OsTheme = {
  id:   'scificn',
  name: 'SCIFICN',
  vars: {
    '--aura-color-primary':   '#00ff41',
    '--aura-color-secondary': '#ff9900',
    '--aura-color-danger':    '#ff2020',
    '--aura-color-bg':        '#0a0a0a',
    '--aura-color-surface':   '#111111',
    '--aura-color-surface-2': '#161616',
    '--aura-color-border':    'rgba(0, 255, 65, 0.20)',
    '--aura-color-text':      '#ccffcc',
    '--aura-color-text-dim':  '#557755',
    '--aura-glow-primary':    '0 0 8px #00ff41, 0 0 16px rgba(0, 255, 65, 0.30)',
    '--aura-glow-secondary':  '0 0 8px #ff9900, 0 0 16px rgba(255, 153, 0, 0.30)',
    '--aura-glow-danger':     '0 0 8px #ff2020, 0 0 16px rgba(255, 32, 32, 0.30)',
    '--aura-glow-subtle':     '0 0 4px rgba(0, 255, 65, 0.30)',
  },
};

const amber: OsTheme = {
  id:   'amber',
  name: 'AMBER',
  vars: {
    '--aura-color-primary':   '#ff9900',
    '--aura-color-secondary': '#ffd166',
    '--aura-color-danger':    '#ff2020',
    '--aura-color-bg':        '#0a0805',
    '--aura-color-surface':   '#141008',
    '--aura-color-surface-2': '#1d160b',
    '--aura-color-border':    'rgba(255, 153, 0, 0.20)',
    '--aura-color-text':      '#ffe9c2',
    '--aura-color-text-dim':  '#8a6b3a',
    '--aura-glow-primary':    '0 0 8px #ff9900, 0 0 16px rgba(255, 153, 0, 0.30)',
    '--aura-glow-secondary':  '0 0 8px #ffd166, 0 0 16px rgba(255, 209, 102, 0.30)',
    '--aura-glow-danger':     '0 0 8px #ff2020, 0 0 16px rgba(255, 32, 32, 0.30)',
    '--aura-glow-subtle':     '0 0 4px rgba(255, 153, 0, 0.30)',
  },
};

const redAlert: OsTheme = {
  id:   'red-alert',
  name: 'RED ALERT',
  vars: {
    '--aura-color-primary':   '#ff2020',
    '--aura-color-secondary': '#ff7070',
    '--aura-color-danger':    '#ffea00',
    '--aura-color-bg':        '#0a0303',
    '--aura-color-surface':   '#160808',
    '--aura-color-surface-2': '#1f0a0a',
    '--aura-color-border':    'rgba(255, 32, 32, 0.25)',
    '--aura-color-text':      '#ffcccc',
    '--aura-color-text-dim':  '#7a4040',
    '--aura-glow-primary':    '0 0 8px #ff2020, 0 0 18px rgba(255, 32, 32, 0.40)',
    '--aura-glow-secondary':  '0 0 8px #ff7070, 0 0 16px rgba(255, 112, 112, 0.30)',
    '--aura-glow-danger':     '0 0 8px #ffea00, 0 0 16px rgba(255, 234, 0, 0.30)',
    '--aura-glow-subtle':     '0 0 4px rgba(255, 32, 32, 0.30)',
  },
};

const blue: OsTheme = {
  id:   'blue',
  name: 'CYAN',
  vars: {
    '--aura-color-primary':   '#00aaff',
    '--aura-color-secondary': '#88ddff',
    '--aura-color-danger':    '#ff2020',
    '--aura-color-bg':        '#04080a',
    '--aura-color-surface':   '#0a1014',
    '--aura-color-surface-2': '#0e1820',
    '--aura-color-border':    'rgba(0, 170, 255, 0.20)',
    '--aura-color-text':      '#ccecff',
    '--aura-color-text-dim':  '#557788',
    '--aura-glow-primary':    '0 0 8px #00aaff, 0 0 16px rgba(0, 170, 255, 0.30)',
    '--aura-glow-secondary':  '0 0 8px #88ddff, 0 0 16px rgba(136, 221, 255, 0.30)',
    '--aura-glow-danger':     '0 0 8px #ff2020, 0 0 16px rgba(255, 32, 32, 0.30)',
    '--aura-glow-subtle':     '0 0 4px rgba(0, 170, 255, 0.30)',
  },
};

export class ThemeManager {
  static readonly THEMES: readonly OsTheme[] = [phosphorGreen, amber, redAlert, blue];
  static readonly DEFAULT_THEME_ID = 'scificn';

  static getThemes(): readonly OsTheme[] {
    return ThemeManager.THEMES;
  }

  static getTheme(id: string): OsTheme | undefined {
    return ThemeManager.THEMES.find((t) => t.id === id);
  }

  /** Render a theme as a CSS string targeting `:root`. */
  static toCss(theme: OsTheme): string {
    const lines = Object.entries(theme.vars).map(([k, v]) => `  ${k}: ${v};`);
    return `:root {\n${lines.join('\n')}\n}\n`;
  }

  /** Convenience: render theme by id (falls back to default if unknown). */
  static toCssById(id: string): string {
    const theme = ThemeManager.getTheme(id) ?? ThemeManager.getTheme(ThemeManager.DEFAULT_THEME_ID)!;
    return ThemeManager.toCss(theme);
  }
}
