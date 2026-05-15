/**
 * ColorModePicker — scificn `Tabs`-based segmented control for the OS
 * color-mode preference (LIGHT / DARK / AUTO), plus a "resolved" pill
 * showing what `auto` evaluates to right now.
 *
 * Replaces the handwritten `.mode-row` button group that lived in both
 * `theme.astro` and `general.astro`. State plumbing:
 *
 *   read:  PUT /api/data/theme  (relative — through the proxy → app endpoint)
 *   write: same endpoint with `{ colorMode }`. Hops through theme-changed
 *          broadcast and back to every shell tab via SSE.
 *
 * Live updates from elsewhere:
 *   • `aura.mode.changed` postMessage from the shell (when someone toggles
 *     the StatusBar viewport-dialog picker, the matchMedia bridge, etc.)
 *   • `prefers-color-scheme` media query (re-resolves the pill when AUTO
 *     is selected and the OS pref flips).
 */
import * as React from 'react';
import { Tabs, TabsList, TabsTrigger } from '@aura/ui';

export type ColorMode = 'light' | 'dark' | 'auto';

export interface ColorModePickerProps {
  defaultMode?: ColorMode;
}

function resolveMode(pref: ColorMode): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function ColorModePicker({ defaultMode = 'dark' }: ColorModePickerProps): React.JSX.Element {
  const [mode, setMode] = React.useState<ColorMode>(defaultMode);
  const [resolved, setResolved] = React.useState<'light' | 'dark'>(resolveMode(defaultMode));

  // matchMedia bridge — only fires when AUTO is selected.
  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => { if (mode === 'auto') setResolved(resolveMode('auto')); };
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else                       mql.addListener?.(handler);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else                          mql.removeListener?.(handler);
    };
  }, [mode]);

  // Cross-iframe / cross-tab sync — pick up changes made elsewhere.
  React.useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'aura.mode.changed' && ev.data.colorMode) {
        setMode(ev.data.colorMode);
        setResolved(resolveMode(ev.data.colorMode));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  async function pick(next: ColorMode): Promise<void> {
    console.log('[ColorModePicker] click →', next);
    setMode(next);
    setResolved(resolveMode(next));
    // Read-modify-write: the OS KV at /api/kv/os/theme stores the whole
    // selection object; PUT replaces it entirely, so we merge the new
    // colorMode in without losing the theme picks.
    try {
      const cur = await fetch('/api/kv/os/theme');
      const previous = cur.ok
        ? (await cur.json() as { value?: Record<string, unknown> }).value ?? {}
        : {};
      const r = await fetch('/api/kv/os/theme', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value: { ...previous, colorMode: next } }),
      });
      if (!r.ok) console.warn('[ColorModePicker] PUT not ok', r.status, await r.text());
      else       console.log('[ColorModePicker] PUT ok', await r.json());
    } catch (err) {
      console.warn('[settings] colorMode PUT failed', err);
    }
  }

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '12px' }}>
      <Tabs value={mode} onValueChange={(v) => void pick(v as ColorMode)}>
        <TabsList>
          <TabsTrigger value="light">LIGHT</TabsTrigger>
          <TabsTrigger value="dark">DARK</TabsTrigger>
          <TabsTrigger value="auto">AUTO</TabsTrigger>
        </TabsList>
      </Tabs>
      <span
        style={{
          fontFamily:     'var(--aura-font-mono)',
          fontSize:       '0.6rem',
          letterSpacing:  '0.12em',
          textTransform:  'uppercase',
          color:          'var(--aura-color-primary)',
          border:         '1px solid var(--aura-color-primary)',
          background:     'color-mix(in srgb, var(--aura-color-primary) 14%, transparent)',
          padding:        '2px 8px',
        }}
      >
        {resolved}
      </span>
    </div>
  );
}

export default ColorModePicker;
