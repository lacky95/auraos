/**
 * ViewportSettingsDialog — the ⚙ panel that manages VIEWPORT PROFILES.
 *
 * A profile is a named bundle of viewport settings (three zoom factors +
 * screen-edge margins + a light/dark theme pick) persisted in device
 * localStorage. The user keeps e.g. a "TV" and a "Mobile" profile and switches
 * between them in one click. By default there is exactly one profile
 * ("Default").
 *
 * All viewport state flows through lib/viewportClient (the single source of
 * truth + localStorage persistence + cross-tab `storage` sync). This
 * component is a pure UI layer over it.
 *
 * Layout is two-pane. A VERTICAL RAIL on the left selects the SETTINGS TOPIC —
 * "Profiles" or "⚙ Global". Under Profiles the right pane leads with a
 * HORIZONTAL tab bar of the individual profiles (selecting one switches the
 * live active profile) above that profile's settings (VIEWPORT/zoom first, then
 * margins, then theme). Under Global the right pane shows the NON-profile
 * settings.
 *
 * Non-profile / device-wide settings are deliberately separated under Global:
 * color mode (os/theme KV), fullscreen (the Fullscreen API) and the dev-only
 * auto-reload toggle (top-level ViewportState). They are NOT part of a profile.
 *
 * The dialog opens on the `aura.viewport.open` CustomEvent the StatusBar
 * dispatches when the user clicks the gear button.
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
import * as viewportClient from '../../lib/viewportClient';
import {
  type ViewportProfile,
  type ViewportMargins,
  type ViewportState,
  ZOOM_MIN,
  ZOOM_MAX,
  MARGIN_MAX,
  defaultProfile,
} from '../../lib/viewport';
// Narrow subpath, not the '@aura/core' barrel — this is a client:load island,
// so a barrel import would bundle the Node-only app-manager into the browser
// and crash the dialog. See the same note in lib/viewport.ts.
import { ThemeManager } from '@aura/core/theme';

type ColorMode = 'light' | 'dark' | 'auto';

const ZOOM_STEP = 0.05;

// Vertical-rail tab styling. @aura/ui's TabsList/TabsTrigger ship hardcoded
// HORIZONTAL classes (inline-flex / items-end / border-b; trigger border-b-2
// -mb-px with a bottom active border). `cn` is clsx+tailwind-merge, and
// tailwind-merge will NOT drop `border-b-*` just because we add `border-l-*`
// (different utility groups) — so we neutralize the bottom border explicitly
// and switch the active indicator to a LEFT border for the column layout.
const RAIL_LIST =
  'flex flex-col items-stretch w-40 shrink-0 gap-0 py-1 ' +
  'border-b-0 border-r border-[var(--border)] overflow-y-auto min-h-0';
const RAIL_TRIGGER =
  'flex items-center justify-between w-full text-left gap-2 px-3 py-2 mb-0 ' +
  'border-b-0 border-l-2 border-transparent ' +
  'data-[state=active]:border-l-[var(--color-green)] data-[state=active]:border-b-transparent ' +
  'data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--color-green)]';
const RIGHT_PANE = 'flex-1 min-w-0 px-4 py-3 space-y-5 overflow-y-auto min-h-0';

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
    if (!r.ok) console.warn('[ViewportDialog] colorMode PUT not ok', r.status, await r.text());
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
  const [vp, setVp]             = React.useState<ViewportState | null>(null);
  const [linkSides, setLinkSides] = React.useState(false);
  const [colorMode, setColorMode] = React.useState<ColorMode>('dark');
  const [resolvedMode, setResolvedMode] = React.useState<'light' | 'dark'>('dark');
  const [isFullscreen, setIsFullscreen] = React.useState<boolean>(false);
  // The profile-name input is decoupled from the profile's stored name: it
  // starts empty whenever the active profile changes so a freshly-created
  // profile doesn't make the user delete its auto-generated "Profile N"
  // before typing. The placeholder shows the current internal name as a hint;
  // the user's keystrokes overwrite it via renameProfile.
  const [nameDraft, setNameDraft] = React.useState('');
  // Which SETTINGS TOPIC the left rail is showing: per-profile settings
  // ('profiles') or the device-wide pane ('global'). Within 'profiles' the
  // specific profile is the live active one (the horizontal tabs switch it), so
  // it needs no separate state. Seeded to 'profiles' on open so VIEWPORT shows first.
  const [section, setSection] = React.useState<'global' | 'profiles'>('profiles');

  // Subscribe to viewport state for the island's lifetime. init() wires the
  // cross-tab `storage` sync (idempotent) and applies the active profile;
  // refresh() loads from localStorage if the StatusBar script hasn't yet;
  // subscribe() replays the current state immediately.
  React.useEffect(() => {
    viewportClient.init();
    const cached: ViewportState | null = viewportClient.getCached();
    if (cached) setVp(cached);
    else void viewportClient.refresh();
    return viewportClient.subscribe(setVp);
  }, []);

  // Open on custom event from the gear button. Refresh color-mode + fullscreen
  // (viewport state already streams in via the subscription above) and open on
  // the Profiles topic so the dialog always lands on VIEWPORT.
  React.useEffect(() => {
    const onOpen = () => {
      setLinkSides(false);
      void fetchColorMode().then((m) => {
        setColorMode(m);
        setResolvedMode(resolveMode(m));
      });
      setIsFullscreen(!!document.fullscreenElement);
      setSection('profiles');
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

  // Derive the active profile + its values from the client state.
  const profiles: ViewportProfile[] = vp?.profiles ?? [defaultProfile()];
  const active: ViewportProfile =
    profiles.find((p) => p.id === vp?.activeProfileId) ?? profiles[0]!;
  const { zoom, shellZoom, appZoom, margins } = active;

  // Reset the name draft to empty whenever the active profile changes so the
  // input is blank for a "type a name" affordance — the internal name stays
  // as-is and shows through as the placeholder.
  React.useEffect(() => { setNameDraft(''); }, [active.id]);

  // ── Viewport mutations (all funnel through viewportClient) ──
  const applyZoom      = (n: number) => viewportClient.patchActive({ zoom: n });
  const applyShellZoom = (n: number) => viewportClient.patchActive({ shellZoom: n });
  const applyAppZoom   = (n: number) => viewportClient.patchActive({ appZoom: n });
  function applyMargin(side: keyof ViewportMargins, value: number) {
    if (linkSides) viewportClient.patchActive({ margins: { top: value, right: value, bottom: value, left: value } });
    else           viewportClient.patchActive({ margins: { [side]: value } });
  }
  const resetZoom      = () => applyZoom(1);
  const resetShellZoom = () => applyShellZoom(1);
  const resetAppZoom   = () => applyAppZoom(1);
  const resetMargins   = () => viewportClient.patchActive({ margins: { top: 0, right: 0, bottom: 0, left: 0 } });
  const resetAll       = () => viewportClient.patchActive({ zoom: 1, shellZoom: 1, appZoom: 1, margins: { top: 0, right: 0, bottom: 0, left: 0 } });

  // Dev-only: device-wide auto-reload-on-source-change. Defaults ON; flipping
  // it OFF makes lib/devReload suppress Vite full reloads so OS state survives
  // edits. Top-level state (not per-profile) — read from `vp`, written here.
  const autoReload     = vp?.autoReload ?? true;
  const setAutoReload  = (on: boolean) => viewportClient.setAutoReload(on);

  // ── Profile management ──
  const switchProfile = (id: string) => viewportClient.setActive(id);
  const addProfile    = () => viewportClient.addProfile();
  const deleteActive  = () => viewportClient.deleteProfile(active.id);
  // Persist only non-empty typed values — clearing the field keeps the
  // profile's existing internal name (which the placeholder reveals).
  function onNameInput(v: string) {
    setNameDraft(v);
    if (v.trim()) viewportClient.renameProfile(active.id, v);
  }

  // Selecting a profile tab switches the LIVE active profile (applies
  // instantly); the horizontal tab highlight follows `active.id` derived above.
  const selectProfile = (id: string) => switchProfile(id);
  const showGlobal = section === 'global';

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
      {/* Height is `80%`, NOT `80vh`: the shell applies a `transform: scale()`
          to <body> for non-default profiles (StatusBar.applyViewport), which
          makes <body> the containing block for this portaled fixed dialog. So
          `%` resolves against the AuraOS viewport (margins + zoom applied),
          whereas `vh` would ignore them and measure the raw browser viewport.
          With no transform (default profile) the containing block is the ICB,
          so `80%` still equals 80vh — consistent in both cases. */}
      <DialogContent className="max-w-3xl h-[80%] gap-0 p-0 flex flex-col">
        <DialogHeader className="shrink-0 border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[var(--color-green)] text-sm tracking-widest uppercase">
            <span aria-hidden="true">▦</span> VIEWPORT
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="p-0 flex-1 min-h-0">
          {/* Two-pane: a vertical TOPIC rail (left) drives `section` — Profiles
              or Global. The right pane is rendered MANUALLY (no TabsContent):
              under Profiles it leads with a HORIZONTAL profile tab bar, under
              Global it shows the device-wide settings. */}
          <Tabs
            orientation="vertical"
            value={section}
            onValueChange={(v) => setSection(v as 'global' | 'profiles')}
            className="flex flex-row items-stretch gap-0 h-full min-h-0"
          >
            <TabsList className={RAIL_LIST}>
              <div className="text-[0.6rem] tracking-[0.18em] text-[var(--text-muted)] uppercase px-3 pt-2 pb-1">// Settings</div>
              <TabsTrigger value="profiles" className={RAIL_TRIGGER} title="Per-profile viewport settings">
                <span className="flex items-center gap-2 truncate text-[0.7rem] tracking-wider">
                  <span aria-hidden="true">▦</span> PROFILES
                </span>
              </TabsTrigger>
              <TabsTrigger value="global" className={RAIL_TRIGGER} title="Device-wide settings (all profiles)">
                <span className="flex items-center gap-2 truncate text-[0.7rem] tracking-wider">
                  <span aria-hidden="true">⚙</span> GLOBAL
                </span>
              </TabsTrigger>
            </TabsList>

            {/* ── RIGHT PANE ── */}
            <div className={RIGHT_PANE}>
              {showGlobal ? (
                <>
                  <div>
                    <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase">// Global</div>
                    <p className="text-[0.6rem] text-[var(--text-muted)] mt-1">These apply to the whole device, across all profiles.</p>
                  </div>

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
                      <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
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
                      <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
                        {isFullscreen ? 'ON' : 'OFF'}
                      </span>
                    </div>
                  </section>

                  {/* DEV — SOURCE RELOAD (dev server only; HMR doesn't exist in prod) */}
                  {import.meta.env.DEV && (
                    <section>
                      <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// DEV — SOURCE RELOAD</div>
                      <div className="flex items-center gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Auto-reload</span>
                        <label className="flex items-center gap-2 text-[0.65rem] tracking-widest text-[var(--text-secondary)] uppercase cursor-pointer">
                          <Checkbox
                            checked={autoReload}
                            onCheckedChange={(v: boolean | 'indeterminate') => setAutoReload(v === true)}
                          />
                          ON SOURCE CHANGE
                        </label>
                        <span className="flex-1" />
                        <span className="font-mono text-[0.65rem] uppercase tracking-widest text-[var(--text-muted)] border border-[var(--border)] px-3 py-1">
                          {autoReload ? 'ON' : 'OFF'}
                        </span>
                      </div>
                    </section>
                  )}
                </>
              ) : (
                <>
                  {/* HORIZONTAL profile tab bar — selecting a tab switches the
                      live active profile; "+ NEW" copies the current one and
                      switches to it. The highlighted tab follows `active.id`. */}
                  <Tabs value={active.id} onValueChange={selectProfile}>
                    <TabsList className="flex-wrap">
                      {profiles.map((p) => (
                        <TabsTrigger key={p.id} value={p.id} title={`Switch to "${p.name}"`}>
                          {p.name || p.id}
                        </TabsTrigger>
                      ))}
                      <Button
                        variant="GHOST"
                        size="SM"
                        className="ml-1 self-center"
                        onClick={() => addProfile()}
                        title="Add a profile (copies the current one)"
                      >
                        + NEW
                      </Button>
                    </TabsList>
                  </Tabs>

                  <p className="text-[0.6rem] text-[var(--text-muted)]">These settings belong to this profile only.</p>

                  {/* Profile name + delete. */}
                  <div className="flex items-center gap-3">
                    <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16">Name</span>
                    <input
                      type="text"
                      value={nameDraft}
                      placeholder={active.name}
                      onChange={(e) => onNameInput(e.target.value)}
                      aria-label="Profile name"
                      className="flex-1 bg-transparent border border-[var(--border)] text-[var(--text-primary)] font-mono text-[0.7rem] tracking-wider px-2 py-1 outline-none focus:border-[var(--color-green)]"
                    />
                    <Button
                      variant="OUTLINE"
                      size="SM"
                      onClick={deleteActive}
                      disabled={profiles.length <= 1}
                      title={profiles.length <= 1 ? 'Keep at least one profile' : `Delete "${active.name}"`}
                    >
                      DELETE
                    </Button>
                  </div>

                  {/* ZOOM — three composable layers. "Everything" scales the whole
                      surface; "Shell" scales only the OS chrome (bars, window frames +
                      buttons); "Apps" scales only app content (iframes). Net app
                      content = Everything × Apps, independent of the Shell zoom. */}
                  <section>
                    <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// ZOOM</div>
                    <div className="space-y-2">
                      {/* Everything (main) */}
                      <div className="flex items-center gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-20">Everything</span>
                        <input
                          type="range"
                          min={ZOOM_MIN}
                          max={ZOOM_MAX}
                          step={ZOOM_STEP}
                          value={zoom}
                          onChange={(e) => applyZoom(parseFloat(e.target.value))}
                          className="flex-1 accent-[var(--color-green)]"
                        />
                        <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[4ch] text-right">{Math.round(zoom * 100)}%</span>
                        <Button variant="OUTLINE" size="SM" onClick={resetZoom}>RESET</Button>
                      </div>
                      {/* Shell (OS chrome only) */}
                      <div className="flex items-center gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-20">Shell</span>
                        <input
                          type="range"
                          min={ZOOM_MIN}
                          max={ZOOM_MAX}
                          step={ZOOM_STEP}
                          value={shellZoom}
                          onChange={(e) => applyShellZoom(parseFloat(e.target.value))}
                          className="flex-1 accent-[var(--color-green)]"
                        />
                        <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[4ch] text-right">{Math.round(shellZoom * 100)}%</span>
                        <Button variant="OUTLINE" size="SM" onClick={resetShellZoom}>RESET</Button>
                      </div>
                      {/* Apps (iframe content only) */}
                      <div className="flex items-center gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-20">Apps</span>
                        <input
                          type="range"
                          min={ZOOM_MIN}
                          max={ZOOM_MAX}
                          step={ZOOM_STEP}
                          value={appZoom}
                          onChange={(e) => applyAppZoom(parseFloat(e.target.value))}
                          className="flex-1 accent-[var(--color-green)]"
                        />
                        <span className="font-mono text-[0.7rem] text-[var(--color-green)] min-w-[4ch] text-right">{Math.round(appZoom * 100)}%</span>
                        <Button variant="OUTLINE" size="SM" onClick={resetAppZoom}>RESET</Button>
                      </div>
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
                            onCheckedChange={(v: boolean | 'indeterminate') => setLinkSides(v === true)}
                          />
                          LINK ALL SIDES
                        </label>
                        <span className="flex-1" />
                        <Button variant="OUTLINE" size="SM" onClick={resetMargins}>RESET MARGINS</Button>
                      </div>
                    </div>
                  </section>

                  {/* THEME — each profile keeps its own favourite light + dark palette.
                      Clicking a swatch sets the active profile's pick AND pushes the
                      new pair to os/theme (so the rest of the OS picks it up through
                      the existing CSS/iframe broadcast path). */}
                  <section>
                    <div className="text-[0.65rem] tracking-[0.18em] text-[var(--text-muted)] uppercase mb-2">// THEME</div>
                    <div className="space-y-2">
                      <div className="flex items-start gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16 pt-1">Dark</span>
                        <div className="flex-1 flex flex-wrap gap-1.5">
                          {ThemeManager.getThemesByTone('dark').map((t) => (
                            <Button
                              key={t.id}
                              variant={t.id === active.themeIdDark ? 'EXEC' : 'OUTLINE'}
                              size="SM"
                              onClick={() => viewportClient.patchActive({ themeIdDark: t.id })}
                              title={t.description ?? t.name}
                            >
                              {t.name}
                            </Button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <span className="text-[0.7rem] tracking-wider text-[var(--text-secondary)] w-16 pt-1">Light</span>
                        <div className="flex-1 flex flex-wrap gap-1.5">
                          {ThemeManager.getThemesByTone('light').map((t) => (
                            <Button
                              key={t.id}
                              variant={t.id === active.themeIdLight ? 'EXEC' : 'OUTLINE'}
                              size="SM"
                              onClick={() => viewportClient.patchActive({ themeIdLight: t.id })}
                              title={t.description ?? t.name}
                            >
                              {t.name}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                </>
              )}
            </div>
          </Tabs>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-[var(--border)] px-4 py-3 gap-2">
          {!showGlobal && <Button variant="GHOST" size="SM" onClick={resetAll}>RESET VIEWPORT</Button>}
          <DialogClose asChild>
            <Button variant="EXEC" size="SM">DONE</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ViewportSettingsDialog;
