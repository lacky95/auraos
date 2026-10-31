/**
 * AuraKeyboard — the one virtual keyboard of the shell (React island inside
 * KeyboardOverlay.astro).
 *
 * simple-keyboard renders the keys; this component owns layers, sticky
 * modifiers and the header (target, layout, mode, dock behaviour, close).
 * Every key goes through AuraInputManager, never straight into the DOM.
 *
 * The simple-keyboard instance is created once and kept for the lifetime of
 * the page: opening/closing only toggles the overlay's visibility, and
 * layout changes go through `setOptions`.
 *
 * Focus: simple-keyboard is set to preventDefault on mousedown and the header
 * does the same, so tapping the keyboard never takes focus from the app.
 */
import * as React from 'react';
import SimpleKeyboard from 'simple-keyboard';
import 'simple-keyboard/build/css/index.css';
import { Icon } from '@aura/ui';
import { kbState, type KbMode } from '../../../lib/keyboard/kbState.ts';
import { inputManager, MODIFIER_KEYS, type InputTarget } from '../../../lib/keyboard/AuraInputManager.ts';
import { useStore } from '../../../lib/keyboard/useStore.ts';
import { runGesture, moveRect, resizeRect, rectToLocal, localViewport, type Edge } from '../../../lib/keyboard/floatGesture.ts';
import { getKvValue, subscribeKv } from '../../../lib/kvClient.ts';
import {
  LAYOUTS, KEYS, MODIFIER_TOKENS, layoutById, displayFor, keyForChar, parseCombo, type LayoutDef,
} from './layouts.ts';

type Mod = 'ctrl' | 'alt' | 'meta' | 'shift';
type Sticky = 'off' | 'once' | 'lock';
type Layer = 'default' | 'numbers' | 'altgr';

/** Layouts that are too wide for a narrow keyboard; auto-fit swaps them for `compact`. */
const WIDE = new Set(['full', 'qwerty', 'terminal', 'editor', 'remote', 'custom']);
const FIT_MIN_WIDTH = 560;

const stop = (e: React.SyntheticEvent) => e.preventDefault();

/** Floating keyboard resizes from the bottom-right corner only (user choice). */
const EDGES: Edge[] = ['se'];
const EDGE_CURSOR: Record<Edge, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

export default function AuraKeyboard(): React.JSX.Element {
  const st = kbState();
  const im = inputManager();
  const open = useStore(st.$open);
  const mode = useStore(st.$mode);
  const layoutId = useStore(st.$layout);
  const dockBehavior = useStore(st.$dockBehavior);
  const autoFit = useStore(st.$autoFit);
  const deviceKb = useStore(st.$deviceKeyboard);

  const rootRef = React.useRef<HTMLDivElement>(null);
  const keysRef = React.useRef<HTMLDivElement>(null);
  const kbRef = React.useRef<SimpleKeyboard | null>(null);

  const [layer, setLayer] = React.useState<Layer>('default');
  const [shift, setShift] = React.useState<Sticky>('off');
  const [mods, setMods] = React.useState<Record<Mod, Sticky>>({ ctrl: 'off', alt: 'off', meta: 'off', shift: 'off' });
  const [target, setTarget] = React.useState<InputTarget | null>(null);
  const [custom, setCustom] = React.useState<LayoutDef | null>(null);
  const [narrow, setNarrow] = React.useState(false);

  // Refs mirror state for the simple-keyboard callbacks (created once).
  const live = React.useRef({ layer, shift, mods, layout: {} as LayoutDef });
  const down = React.useRef<string | null>(null);

  const effectiveId = autoFit && narrow && WIDE.has(layoutId) ? 'compact' : layoutId;
  const layout = React.useMemo(() => layoutById(effectiveId, custom), [effectiveId, custom]);
  const hasShiftLayer = !!layout['shift'];
  const layoutName =
    layer === 'numbers' && layout['numbers'] ? 'numbers'
    : layer === 'altgr' && layout['altgr'] ? 'altgr'
    : shift !== 'off' && hasShiftLayer ? 'shift'
    : 'default';
  live.current = { layer, shift, mods, layout };

  // ── Target label ─────────────────────────────────────────────────────
  React.useEffect(() => im.subscribe(setTarget), [im]);

  // ── Custom layout from KV (`os/virtual-keyboard/customLayout`) ───────
  React.useEffect(() => {
    const take = (v: unknown) => {
      const l = v as LayoutDef | null;
      setCustom(l && Array.isArray(l['default']) ? l : null);
    };
    void getKvValue('os', 'virtual-keyboard/customLayout').then(take).catch(() => undefined);
    return subscribeKv({ namespace: 'os', key: 'virtual-keyboard/customLayout' }, (ev) => take(ev.value));
  }, []);

  // ── Size-aware layout ────────────────────────────────────────────────
  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setNarrow(w < FIT_MIN_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Modifier helpers ─────────────────────────────────────────────────
  const activeMods = () => {
    const m = live.current.mods;
    const shiftOn = live.current.shift !== 'off' && !!live.current.layout['shift'];
    return { ctrl: m.ctrl !== 'off', alt: m.alt !== 'off', meta: m.meta !== 'off', shift: m.shift !== 'off' || shiftOn };
  };

  const setMod = (m: Mod, next: Sticky) => {
    const prev = live.current.mods[m];
    if (prev === next) return;
    if (prev === 'off') void im.send({ action: 'keydown', ...MODIFIER_KEYS[m], modifiers: { ...activeMods(), [m]: true } });
    if (next === 'off') void im.send({ action: 'keyup', ...MODIFIER_KEYS[m], modifiers: { ...activeMods(), [m]: false } });
    const mods2 = { ...live.current.mods, [m]: next };
    live.current.mods = mods2;
    setMods(mods2);
  };

  /** After a normal key: one-shot modifiers and shift fall back to off. */
  const releaseOnce = () => {
    for (const m of ['ctrl', 'alt', 'meta', 'shift'] as Mod[]) if (live.current.mods[m] === 'once') setMod(m, 'off');
    if (live.current.shift === 'once') { live.current.shift = 'off'; setShift('off'); }
  };

  const cycle = (s: Sticky): Sticky => (s === 'off' ? 'once' : s === 'once' ? 'lock' : 'off');

  // ── Key handling ─────────────────────────────────────────────────────
  const onKeyPress = (button: string) => {
    const repeat = down.current === button;
    down.current = button;
    const L = live.current;

    // Local controls (no input sent).
    if (button === '{numbers}') { setLayer('numbers'); return; }
    if (button === '{abc}') { setLayer('default'); return; }
    if (button === '{altgr}') { setLayer((l) => (l === 'altgr' ? 'default' : 'altgr')); return; }
    if ((button === '{shift}' || button === '{lock}') && L.layout['shift']) {
      if (repeat) return;
      const next: Sticky = button === '{lock}' ? (L.shift === 'lock' ? 'off' : 'lock') : (L.shift === 'off' ? 'once' : 'off');
      live.current.shift = next;
      setShift(next);
      return;
    }
    const modTok = MODIFIER_TOKENS[button as keyof typeof MODIFIER_TOKENS];
    if (modTok) { if (!repeat) setMod(modTok, cycle(L.mods[modTok])); return; }

    const combo = parseCombo(button);
    if (combo) {
      if (repeat) return;
      const m = activeMods();
      void im.press(combo.key, {
        ctrl: m.ctrl || !!combo.mods.ctrl, alt: m.alt || !!combo.mods.alt,
        shift: m.shift || !!combo.mods.shift, meta: m.meta || !!combo.mods.meta,
      });
      down.current = null; // already released
      releaseOnce();
      return;
    }

    const spec = KEYS[button] ?? (button.length >= 1 && !button.startsWith('{') ? keyForChar(button) : null);
    if (!spec) return;
    void im.send({ action: 'keydown', ...spec, repeat, modifiers: activeMods() });
  };

  const onKeyReleased = (button: string) => {
    if (down.current !== button) return;
    down.current = null;
    const spec = KEYS[button] ?? (!button.startsWith('{') ? keyForChar(button) : null);
    if (!spec) return;
    void im.send({ action: 'keyup', ...spec, modifiers: activeMods() });
    releaseOnce();
  };
  const handlers = React.useRef({ onKeyPress, onKeyReleased });
  handlers.current = { onKeyPress, onKeyReleased };

  // ── simple-keyboard: create once, destroy on unmount ─────────────────
  React.useEffect(() => {
    const el = keysRef.current;
    if (!el) return;
    const kb = new SimpleKeyboard(el, {
      layout,
      layoutName,
      display: displayFor(layout),
      mergeDisplay: true,
      theme: 'hg-theme-default aura-kb-theme',
      useButtonTag: true,
      clickOnMouseDown: true,
      preventMouseDownDefault: true,
      stopMouseDownPropagation: true,
      physicalKeyboardHighlight: false,
      onKeyPress: (b: string) => handlers.current.onKeyPress(b),
      onKeyReleased: (b: string) => handlers.current.onKeyReleased(b),
    });
    kbRef.current = kb;
    return () => { kb.destroy(); kbRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout / layer / modifier highlight changes reuse the same instance.
  React.useEffect(() => {
    const themes: Array<{ class: string; buttons: string }> = [];
    const lit = (cls: string, buttons: string[]) => { if (buttons.length) themes.push({ class: cls, buttons: buttons.join(' ') }); };
    const tok = (m: Mod) => `{${m}}`;
    lit('aura-kb-on', (['ctrl', 'alt', 'meta', 'shift'] as Mod[]).filter((m) => mods[m] === 'once').map(tok)
      .concat(shift === 'once' ? ['{shift}'] : []).concat(layer === 'altgr' ? ['{altgr}'] : []));
    lit('aura-kb-lock', (['ctrl', 'alt', 'meta', 'shift'] as Mod[]).filter((m) => mods[m] === 'lock').map(tok)
      .concat(shift === 'lock' ? ['{lock}'] : []));
    kbRef.current?.setOptions({ layout, layoutName, display: displayFor(layout), buttonTheme: themes });
  }, [layout, layoutName, mods, shift, layer]);

  // Closing the keyboard releases everything it holds.
  React.useEffect(() => {
    if (open) return;
    for (const m of ['ctrl', 'alt', 'meta', 'shift'] as Mod[]) if (live.current.mods[m] !== 'off') setMod(m, 'off');
    void im.releaseAllKeys();
    down.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── Floating: move by the header, resize from any edge or corner ─────
  // runGesture captures the pointer (drags keep working over app windows)
  // and works in body-local px (correct under shell zoom / margins).
  // The rect is saved once, when the gesture ends ($dragging → false).
  const startGesture = (e: React.PointerEvent<HTMLElement>, edge: Edge | null) => {
    if (st.$mode.get() !== 'floating') return;
    if (!edge && (e.target as HTMLElement).closest('button')) return;
    const box = rootRef.current?.closest<HTMLElement>('#virtual-keyboard');
    if (!box) return;
    // Start from what is on screen (the stored rect may have been clamped).
    const start = rectToLocal(box.getBoundingClientRect());
    const bounds = localViewport();
    runGesture(
      e.currentTarget,
      e.nativeEvent,
      (dx, dy) => {
        if (!st.$dragging.get()) st.$dragging.set(true);
        st.$floatRect.set(edge ? resizeRect(start, edge, dx, dy, bounds) : moveRect(start, dx, dy, bounds));
      },
      () => { if (st.$dragging.get()) st.$dragging.set(false); },
      { threshold: edge ? 0 : 4, cursor: edge ? EDGE_CURSOR[edge] : 'grabbing' },
    );
  };

  // ── Header actions ───────────────────────────────────────────────────
  const setMode = (m: KbMode) => {
    if (m === 'activity') {
      const t = im.resolveTarget();
      const viewId = t?.kind === 'iframe' ? t.frame.closest<HTMLElement>('.app-slot')?.dataset['viewId'] : undefined;
      if (!viewId) return; // nothing to attach to
      st.$attachedViewId.set(viewId);
    } else {
      st.$attachedViewId.set(null);
    }
    st.$mode.set(m);
  };

  const canAttach = target?.kind === 'iframe' && !!target.frame.closest('.app-slot');
  const layoutOptions = custom ? [...LAYOUTS, { id: 'custom', label: 'Custom', layout: custom }] : LAYOUTS;

  return (
    <div ref={rootRef} className="aura-kb" data-mode={mode}>
      <div className="aura-kb-head" onMouseDown={stop} onPointerDown={(e) => startGesture(e, null)}>
        <span className="aura-kb-target" title={target ? `Typing into ${target.label}` : 'No target'}>
          <Icon name={target ? (target.kind === 'iframe' ? 'app-window' : 'text-cursor-input') : 'circle-off'} />
          <span>{target ? target.label : 'Click an app or field'}</span>
        </span>

        <span className="aura-kb-group" role="group" aria-label="Layout">
          {layoutOptions.map((l) => (
            <button key={l.id} type="button" className="aura-kb-chip" aria-pressed={layoutId === l.id}
              onMouseDown={stop} onClick={() => { st.$layout.set(l.id); setLayer('default'); }}>{l.label}</button>
          ))}
          <button type="button" className="aura-kb-chip" aria-pressed={autoFit} onMouseDown={stop}
            title="Switch to the compact layout when the keyboard is narrow"
            onClick={() => st.$autoFit.set(!autoFit)}>Fit</button>
        </span>

        <span className="aura-kb-group" role="group" aria-label="Position">
          <button type="button" className="aura-kb-icon" aria-pressed={mode === 'docked'} title="Docked"
            onMouseDown={stop} onClick={() => setMode('docked')}><Icon name="panel-bottom" /></button>
          <button type="button" className="aura-kb-icon" aria-pressed={mode === 'floating'} title="Floating"
            onMouseDown={stop} onClick={() => setMode('floating')}><Icon name="move" /></button>
          <button type="button" className="aura-kb-icon" aria-pressed={mode === 'activity'} disabled={!canAttach && mode !== 'activity'}
            title={canAttach ? `Attach to ${target!.label}` : 'Attach to a window (click an app first)'}
            onMouseDown={stop} onClick={() => setMode('activity')}><Icon name="pin" /></button>
          {mode === 'docked' ? (
            <button type="button" className="aura-kb-chip" onMouseDown={stop}
              title={dockBehavior === 'push' ? 'Windows make room for the keyboard — switch to overlay' : 'Keyboard covers the windows — switch to push'}
              onClick={() => st.$dockBehavior.set(dockBehavior === 'push' ? 'overlay' : 'push')}>
              {dockBehavior === 'push' ? 'Push' : 'Overlay'}
            </button>
          ) : null}
        </span>

        <button type="button" className="aura-kb-chip" onMouseDown={stop}
          title={{
            auto: "Device keyboard: hidden on touch devices (iPad, tablets). Click to always hide it.",
            hide: "Device keyboard: always hidden. Click to always show it.",
            show: "Device keyboard: always shown. Click for automatic.",
          }[deviceKb]}
          onClick={() => st.$deviceKeyboard.set(deviceKb === 'auto' ? 'hide' : deviceKb === 'hide' ? 'show' : 'auto')}>
          <Icon name={deviceKb === 'show' ? 'smartphone' : 'keyboard-off'} />&nbsp;{deviceKb === 'auto' ? 'Auto' : deviceKb === 'hide' ? 'Hidden' : 'Shown'}
        </button>

        <button type="button" className="aura-kb-icon" title="Close keyboard" aria-label="Close keyboard"
          onMouseDown={stop} onClick={() => st.$open.set(false)}><Icon name="x" /></button>
      </div>

      <div ref={keysRef} className="aura-kb-keys" onMouseDown={stop} />

      {mode === 'floating' ? EDGES.map((edge) => (
        <span key={edge} className="aura-kb-handle" data-edge={edge} aria-hidden="true"
          onMouseDown={stop} onPointerDown={(e) => startGesture(e, edge)} />
      )) : null}
    </div>
  );
}
