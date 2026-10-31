/**
 * Virtual-keyboard UI state, shared by the overlay script and the React island.
 *
 * Pinned on `window` like other shell singletons: the overlay's <script> and
 * the AuraKeyboard island are separate module instances.
 *
 * Persisted in the OS KV under `os/virtual-keyboard/*`: mode, layout,
 * dockBehavior, floatRect, attachedViewId, autoFit, suppressNative. The open flag is NOT persisted —
 * every page load starts with the keyboard closed.
 */
import { atom, type WritableAtom } from 'nanostores';
import { getKvValue, setKv, subscribeKv } from '../kvClient.ts';

export type KbMode = 'docked' | 'floating' | 'activity';
export type KbDockBehavior = 'push' | 'overlay';
export interface KbRect { left: number; top: number; width: number; height: number }

export interface KbState {
  $open:           WritableAtom<boolean>;
  $mode:           WritableAtom<KbMode>;
  $layout:         WritableAtom<string>;
  $dockBehavior:   WritableAtom<KbDockBehavior>;
  $floatRect:      WritableAtom<KbRect | null>;
  $attachedViewId: WritableAtom<string | null>;
  /** Swap a wide layout for `compact` when the keyboard is too narrow for it. */
  $autoFit:        WritableAtom<boolean>;
  /** Keep the device's own on-screen keyboard away from text fields (touch screens). */
  $suppressNative: WritableAtom<boolean>;
  /** True while the user drags/resizes; incoming KV updates for floatRect are ignored. */
  $dragging:       WritableAtom<boolean>;
}

const NS = 'os';
const KEY = (k: string) => `virtual-keyboard/${k}`;
const MODES: KbMode[] = ['docked', 'floating', 'activity'];
/** Tags this tab's floatRect writes so their KV echo is not applied back. */
const TAB = Math.random().toString(36).slice(2, 10);

function atoms(): KbState {
  return {
    $open:           atom(false),
    $mode:           atom<KbMode>('docked'),
    $layout:         atom('full'),
    $dockBehavior:   atom<KbDockBehavior>('push'),
    $floatRect:      atom<KbRect | null>(null),
    $attachedViewId: atom<string | null>(null),
    $autoFit:        atom(true),
    $suppressNative: atom(true),
    $dragging:       atom(false),
  };
}

function create(): KbState {
  const s = atoms();

  const apply = (field: string, v: unknown): void => {
    if (field === 'mode' && MODES.includes(v as KbMode)) s.$mode.set(v as KbMode);
    else if (field === 'layout' && typeof v === 'string' && v) s.$layout.set(v);
    else if (field === 'dockBehavior' && (v === 'push' || v === 'overlay')) s.$dockBehavior.set(v);
    else if (field === 'floatRect' && isRect(v)) {
      // Our own write coming back, or the user is mid-gesture: keep the local rect.
      if ((v as { by?: string }).by === TAB || s.$dragging.get()) return;
      s.$floatRect.set({ left: v.left, top: v.top, width: v.width, height: v.height });
    }
    else if (field === 'attachedViewId' && (typeof v === 'string' || v === null)) s.$attachedViewId.set(v);
    else if (field === 'autoFit' && typeof v === 'boolean') s.$autoFit.set(v);
    else if (field === 'suppressNative' && typeof v === 'boolean') s.$suppressNative.set(v);
  };

  // Hydrate, then write back on change (debounced). `hydrated` keeps the
  // initial defaults from overwriting stored values before the read lands.
  let hydrated = false;
  const fields = ['mode', 'layout', 'dockBehavior', 'floatRect', 'attachedViewId', 'autoFit', 'suppressNative'] as const;
  void Promise.all(fields.map(async (f) => {
    try { const v = await getKvValue(NS, KEY(f)); if (v !== null) apply(f, v); } catch { /* KV down — defaults */ }
  })).finally(() => { hydrated = true; });

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const persist = (field: string, v: unknown): void => {
    if (!hydrated) return;
    clearTimeout(timers.get(field));
    timers.set(field, setTimeout(() => { void setKv(NS, KEY(field), v).catch(() => undefined); }, 250));
  };
  s.$mode.listen((v) => persist('mode', v));
  s.$layout.listen((v) => persist('layout', v));
  s.$dockBehavior.listen((v) => persist('dockBehavior', v));
  // floatRect changes on every pointer move; write it once, when the gesture ends.
  const saveRect = () => { const v = s.$floatRect.get(); persist('floatRect', v ? { ...v, by: TAB } : null); };
  s.$floatRect.listen(() => { if (!s.$dragging.get()) saveRect(); });
  s.$dragging.listen((d) => { if (!d) saveRect(); });
  s.$attachedViewId.listen((v) => persist('attachedViewId', v));
  s.$autoFit.listen((v) => persist('autoFit', v));
  s.$suppressNative.listen((v) => persist('suppressNative', v));

  // Cross-tab / cross-device sync.
  subscribeKv({ namespace: NS }, (ev) => {
    if (!ev.key.startsWith('virtual-keyboard/')) return;
    apply(ev.key.slice('virtual-keyboard/'.length), ev.value);
  });
  return s;
}

function isRect(v: unknown): v is KbRect {
  const r = v as KbRect | null;
  return !!r && [r.left, r.top, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n));
}

let ssrState: KbState | null = null;

export function kbState(): KbState {
  // Server render (island SSR): plain defaults, no KV, no window.
  if (typeof window === 'undefined') return (ssrState ??= atoms());
  const w = window as unknown as { __auraKbState?: KbState };
  return (w.__auraKbState ??= create());
}
