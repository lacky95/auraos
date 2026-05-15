/**
 * ViewportSettingsDialog — the ⚙ panel formerly drawn as a handwritten
 * `<dialog class="sci-dialog">` in StatusBar.astro.
 *
 * Imperative contract preserved verbatim — the rest of the shell still calls
 * the vanilla globals exposed by StatusBar's own script block:
 *
 *   window.auraSetZoom(value)
 *   window.auraSetMargins({ top, right, bottom, left })
 *   localStorage 'aura.shell.zoom' / 'aura.shell.margins'
 *
 * The dialog opens in response to a `aura.viewport.open` CustomEvent the
 * StatusBar dispatches when the user clicks the gear button. That way:
 *   - the dialog hydrates with `client:load`, mounts the React tree once
 *   - the click handler is plain vanilla JS in StatusBar (no React
 *     listener races during first paint)
 *
 * Color mode is read/written through the Settings content provider so the
 * picker stays in sync with the dedicated Settings · Theme activity.
 */
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
} from '@aura/ui';
import { Checkbox } from '@aura/ui';
import { Button }   from '@aura/ui';
import { Tabs, TabsList, TabsTrigger } from '@aura/ui';

type Margins = { top: number; right: number; bottom: number; left: number };
type ColorMode = 'light' | 'dark' | 'auto';

const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.05;
const MARGIN_MAX = 200;

const ZOOM_KEY    = 'aura.shell.zoom';
const MARGINS_KEY = 'aura.shell.margins';

declare global {
  interface Window {
    auraSetZoom?:     (z: number) => void;
    auraSetMargins?:  (m: Partial<Margins>) => void;
  }
}

function readZoom(): number {
  try {
    const z = parseFloat(localStorage.getItem(ZOOM_KEY) ?? '1');
    if (Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX) return z;
  } catch {}
  return 1;
}
function readMargins(): Margins {
  try {
    const raw = localStorage.getItem(MARGINS_KEY);
    if (raw) {
      const m = JSON.parse(raw) as Partial<Margins>;
      return {
        top:    clamp(Number(m.top    ?? 0)),
        right:  clamp(Number(m.right  ?? 0)),
        bottom: clamp(Number(m.bottom ?? 0)),
        left:   clamp(Number(m.left   ?? 0)),
      };
    }
  } catch {}
  return { top: 0, right: 0, bottom: 0, left: 0 };
}
function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MARGIN_MAX, Math.round(v)));
}

interface KvEnvelope<T> { value: T; updatedAt: number; }
interface ThemeKv { themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode; }

/** Read current color-mode preference from the OS KV (`os/theme`). */
async function fetchColorMode(): Promise<ColorMode> {
  try {
    const res = await fetch('/api/kv/os/theme');
    if (!res.ok) return 'dark';
    const body = await res.json() as KvEnvelope<ThemeKv>;
    return body.value?.colorMode ?? 'dark';
  } catch { return 'dark'; }
}
async function writeColorMode(mode: ColorMode): Promise<void> {
  console.log('[ViewportDialog] writeColorMode →', mode);
  try {
    // PUT to /api/kv/os/theme replaces the whole value — read-modify-write
    // so we don't blow away the user's theme picks while toggling mode.
    const current = await fetch('/api/kv/os/theme');
    const previous: ThemeKv = current.ok
      ? (await current.json() as KvEnvelope<ThemeKv>).value ?? {}
      : {};
    const r = await fetch('/api/kv/os/theme', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: { ...previous, colorMode: mode } }),
    });
    if (!r.ok) console.warn('[ViewportDialog] PUT not ok', r.status, await r.text());
    else       console.log('[ViewportDialog] PUT ok', await r.json());
  } catch (err) {
    console.warn('[ViewportDialog] set colorMode failed', err);
  }
}

function resolveMode(pref: ColorMode): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

export function ViewportSettingsDialog(): React.JSX.Element {
  const [open, setOpen]         = React.useState(false);
  const [zoom, setZoomState]    = React.useState<number>(1);
  const [margins, setMargins]   = React.useState<Margins>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [linkSides, setLinkSides] = React.useState(false);
  const [colorMode, setColorMode] = React.useState<ColorMode>('dark');
  const [resolvedMode, setResolvedMode] = React.useState<'light' | 'dark'>('dark');
  const [isFullscreen, setIsFullscreen] = React.useState<boolean>(false);

  // Open on custom event from the gear button. Hydrate state on every open.
  React.useEffect(() => {
    const onOpen = () => {
      setZoomState(readZoom());
      setMargins(readMargins());
      setLinkSides(false);
      void fetchColorMode().then((m) => {
        setColorMode(m);
        setResolvedMode(resolveMode(m));
      });
      setIsFullscreen(!!document.fullscreenElement);
      setOpen(true);
    };
    window.addEventListener('aura.viewport.open', onOpen);
    return () => window.removeEventListener('aura.viewport.open', onOpen);
  }, []);

  // Track fullscreen + prefers-color-scheme externally so the dialog is honest
  // about state the user could have changed elsewhere.
  React.useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    const mql = window.matchMedia?.('(prefers-color-scheme: light)');
    const onMql = () => setResolvedMode(resolveMode(colorMode));
    mql?.addEventListener?.('change', onMql);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      mql?.removeEventListener?.('change', onMql);
    };
  }, [colorMode]);

  // Listen to live theme/mode broadcasts from the shell so the picker stays in
  // sync if the user changes it from Settings while the dialog is open.
  React.useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data?.colorMode as ColorMode | undefined;
      if (ev.data?.type === 'aura.mode.changed' && m) {
        setColorMode(m);
        setResolvedMode(resolveMode(m));
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  function applyZoom(next: number) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100));
    setZoomState(clamped);
    window.auraSetZoom?.(clamped);
  }
  function applyMargin(side: keyof Margins, value: number) {
    const v = clamp(value);
    let next: Margins;
    if (linkSides) {
      next = { top: v, right: v, bottom: v, left: v };
    } else {
      next = { ...margins, [side]: v };
    }
    setMargins(next);
    window.auraSetMargins?.(next);
  }
  function resetZoom()    { applyZoom(1); }
  function resetMargins() { setMargins({ top: 0, right: 0, bottom: 0, left: 0 }); window.auraSetMargins?.({ top: 0, right: 0, bottom: 0, left: 0 }); }
  function resetAll()     { resetZoom(); resetMargins(); }

  async function pickColorMode(next: ColorMode) {
    setColorMode(next);
    setResolvedMode(resolveMode(next));
    await writeColorMode(next);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else                            await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn('[ViewportDialog] fullscreen toggle failed', err);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[520px] gap-0 p-0">
        <DialogHeader className="border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[var(--color-green)] text-sm tracking-widest uppercase">
            <span aria-hidden="true">▦</span> VIEWPORT
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="px-4 py-3 space-y-5">
          {/* ZOOM */}
          <section>
            <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// ZOOM</div>
            <div className="flex items-center gap-3">
              <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Level</span>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={ZOOM_STEP}
                value={zoom}
                onChange={(e) => applyZoom(parseFloat(e.target.value))}
                className="flex-1 accent-[var(--color-green)]"
              />
              <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[3ch] text-right">{Math.round(zoom * 100)}%</span>
              <Button variant="OUTLINE" size="SM" onClick={resetZoom}>RESET</Button>
            </div>
          </section>

          {/* MARGINS */}
          <section>
            <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// MARGIN FROM SCREEN EDGES</div>
            <div className="space-y-2">
              {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                <div key={side} className="flex items-center gap-3">
                  <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16 capitalize">{side}</span>
                  <input
                    type="range"
                    min={0}
                    max={MARGIN_MAX}
                    step={2}
                    value={margins[side]}
                    onChange={(e) => applyMargin(side, parseInt(e.target.value, 10))}
                    className="flex-1 accent-[var(--color-green)]"
                  />
                  <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[5ch] text-right">{margins[side]}px</span>
                </div>
              ))}
              <div className="flex items-center gap-3 pt-1">
                <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Uniform</span>
                <label className="flex items-center gap-2 text-[0.65rem] tracking-widest text-[var(--text-secondary)] uppercase cursor-pointer">
                  <Checkbox
                    checked={linkSides}
                    onCheckedChange={(v) => setLinkSides(v === true)}
                  />
                  LINK ALL SIDES
                </label>
                <span className="flex-1" />
                <Button variant="OUTLINE" size="SM" onClick={resetMargins}>RESET MARGINS</Button>
              </div>
            </div>
          </section>

          {/* COLOR MODE */}
          <section>
            <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// COLOR MODE</div>
            <div className="flex items-center gap-3">
              <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Mode</span>
              <Tabs value={colorMode} onValueChange={(v) => void pickColorMode(v as ColorMode)} className="flex-1">
                <TabsList>
                  <TabsTrigger value="light">LIGHT</TabsTrigger>
                  <TabsTrigger value="dark">DARK</TabsTrigger>
                  <TabsTrigger value="auto">AUTO</TabsTrigger>
                </TabsList>
              </Tabs>
              <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-2 py-1">
                {resolvedMode}
              </span>
            </div>
          </section>

          {/* FULLSCREEN */}
          <section>
            <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// MODE</div>
            <div className="flex items-center gap-3">
              <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Fullscreen</span>
              <Button variant="OUTLINE" size="SM" onClick={() => void toggleFullscreen()}>
                {isFullscreen ? 'EXIT' : 'ENTER'}
              </Button>
              <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-2 py-1">
                {isFullscreen ? 'ON' : 'OFF'}
              </span>
            </div>
          </section>
        </DialogBody>

        <DialogFooter className="border-t border-[var(--border)] px-4 py-3 gap-2">
          <Button variant="GHOST" size="SM" onClick={resetAll}>RESET ALL</Button>
          <DialogClose asChild>
            <Button variant="EXEC" size="SM">DONE</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ViewportSettingsDialog;
