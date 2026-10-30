/**
 * AuraInputManager — routes virtual-keyboard input to the right place.
 *
 * AuraOS owns the keyboard; Activities receive the input. Every key goes
 * through `send()`, which picks a target and delivers an `aura.key.synthetic`
 * message (see components/shell/keyboard/PROTOCOL.md):
 *   • app iframe → postMessage into the frame, handled by the receiver the
 *     proxy injects into every app document (lib/keyboard/receiverScript.ts);
 *   • shell input (launcher search, dialogs) → postMessage to the shell
 *     window itself, handled by the same receiver installed in OSLayout.
 *
 * Target choice, in order:
 *   1. a pinned activity (`setTargetActivity`, used by activity-attached mode);
 *   2. the focused shell text field (not inside the keyboard);
 *   3. the focused iframe;
 *   4. whichever was used last: an iframe the user clicked in
 *      (`aura.pointerdown` from the proxy) or a shell field that had focus;
 *   5. nothing — the key is dropped rather than sprayed into the page.
 *
 * Singleton on `window`: the overlay script and the React island are
 * separate module instances.
 */

export interface AuraKeyboardInput {
  action: 'keydown' | 'keyup' | 'text';
  key?: string;
  code?: string;
  text?: string;
  /** Legacy keyCode, still read by xterm.js and Guacamole. */
  keyCode?: number;
  repeat?: boolean;
  modifiers?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
}

export type InputTarget =
  | { kind: 'iframe'; frame: HTMLIFrameElement; label: string }
  | { kind: 'shell'; element: HTMLElement; label: string };

export interface AuraInputManager {
  send(input: AuraKeyboardInput): Promise<boolean>;
  /** Press a key combo: modifier downs, key down/up, modifier ups. */
  press(key: KeySpec, modifiers?: AuraKeyboardInput['modifiers']): Promise<boolean>;
  setTargetActivity(viewId: string | null): void;
  getTargetActivity(): string | null;
  releaseAllKeys(): Promise<void>;
  resolveTarget(): InputTarget | null;
  subscribe(cb: (t: InputTarget | null) => void): () => void;
}

export interface KeySpec { key: string; code: string; keyCode?: number }

const MSG = 'aura.key.synthetic';
const KEYBOARD_ROOT = '#virtual-keyboard';

export const MODIFIER_KEYS: Record<'ctrl' | 'alt' | 'shift' | 'meta', KeySpec> = {
  ctrl:  { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt:   { key: 'Alt',     code: 'AltLeft',     keyCode: 18 },
  shift: { key: 'Shift',   code: 'ShiftLeft',   keyCode: 16 },
  meta:  { key: 'Meta',    code: 'MetaLeft',    keyCode: 91 },
};

function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly
      && /^(text|search|email|url|tel|password|number|)$/i.test(el.type);
  }
  return false;
}

const inKeyboard = (el: Element | null) => !!el?.closest(KEYBOARD_ROOT);

function frameLabel(frame: HTMLIFrameElement): string {
  if (frame.id === 'focus-frame') {
    return document.getElementById('focus-title')?.textContent?.trim() || 'focused app';
  }
  const slot = frame.closest<HTMLElement>('.app-slot');
  const title = slot?.querySelector('.slot-title')?.textContent?.replace(/\s+/g, ' ').trim();
  return title || frame.title || 'app';
}

function shellLabel(el: HTMLElement): string {
  return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.id || 'shell field';
}

function create(): AuraInputManager {
  let pinnedViewId: string | null = null;
  let lastFrame: HTMLIFrameElement | null = null;
  let lastFrameAt = 0;
  let lastShell: HTMLElement | null = null;
  let lastShellAt = 0;
  const held = new Map<string, { target: InputTarget; input: AuraKeyboardInput }>();
  const subs = new Set<(t: InputTarget | null) => void>();
  let lastNotified: Element | null | undefined;

  const notify = () => {
    const t = resolveTarget();
    const el = t ? (t.kind === 'iframe' ? t.frame : t.element) : null;
    if (el === lastNotified) return;
    lastNotified = el;
    for (const cb of subs) { try { cb(t); } catch { /* keep going */ } }
  };

  const noteFrame = (f: HTMLIFrameElement) => { lastFrame = f; lastFrameAt = performance.now(); notify(); };

  // A click inside an app iframe never reaches the shell DOM; the proxy's
  // focus-on-click script tells us with `aura.pointerdown`.
  window.addEventListener('message', (ev) => {
    if ((ev.data as { type?: string } | null)?.type !== 'aura.pointerdown') return;
    for (const f of document.querySelectorAll('iframe')) {
      if (f.contentWindow === ev.source) { noteFrame(f); return; }
    }
  });
  document.addEventListener('focusin', (ev) => {
    const t = ev.target as Element | null;
    if (t instanceof HTMLIFrameElement) { noteFrame(t); return; }
    if (isEditable(t) && !inKeyboard(t)) { lastShell = t; lastShellAt = performance.now(); notify(); }
  }, true);
  // Focus moving into an iframe blurs the shell window; activeElement is then the iframe.
  window.addEventListener('blur', () => setTimeout(() => {
    const a = document.activeElement;
    if (a instanceof HTMLIFrameElement) noteFrame(a);
  }, 0));

  function pinnedFrame(): HTMLIFrameElement | null {
    if (!pinnedViewId) return null;
    return document.querySelector<HTMLIFrameElement>(
      `.app-slot[data-view-id="${CSS.escape(pinnedViewId)}"] iframe`);
  }

  function resolveTarget(): InputTarget | null {
    const pinned = pinnedFrame();
    if (pinned) return { kind: 'iframe', frame: pinned, label: frameLabel(pinned) };

    const a = document.activeElement;
    if (isEditable(a) && !inKeyboard(a)) return { kind: 'shell', element: a, label: shellLabel(a) };
    if (a instanceof HTMLIFrameElement && a.isConnected) return { kind: 'iframe', frame: a, label: frameLabel(a) };

    const frameOk = !!lastFrame?.isConnected && lastFrame.offsetParent !== null;
    const shellOk = !!lastShell?.isConnected && lastShell.offsetParent !== null && isEditable(lastShell);
    if (frameOk && (!shellOk || lastFrameAt >= lastShellAt)) {
      return { kind: 'iframe', frame: lastFrame!, label: frameLabel(lastFrame!) };
    }
    if (shellOk) return { kind: 'shell', element: lastShell!, label: shellLabel(lastShell!) };
    return null;
  }

  function deliver(t: InputTarget, input: AuraKeyboardInput): boolean {
    const m = input.modifiers ?? {};
    const msg = {
      type: MSG, action: input.action,
      key: input.key, code: input.code, keyCode: input.keyCode, text: input.text,
      repeat: !!input.repeat, ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift, meta: !!m.meta,
    };
    try {
      if (t.kind === 'iframe') {
        const w = t.frame.contentWindow;
        if (!w) return false;
        // Switching to another window: give it focus first, so its page has a
        // focused document (the receiver then restores its input field).
        if (document.activeElement !== t.frame) {
          try { t.frame.focus({ preventScroll: true }); } catch { /* gone */ }
        }
        w.postMessage(msg, '*');
        return true;
      }
      if (document.activeElement !== t.element) t.element.focus({ preventScroll: true });
      window.postMessage(msg, location.origin);
      return true;
    } catch {
      return false;
    }
  }

  async function send(input: AuraKeyboardInput): Promise<boolean> {
    const id = input.code || input.key || '';
    // A keyup goes where its keydown went, even if the target changed since.
    if (input.action === 'keyup' && held.has(id)) {
      const h = held.get(id)!;
      held.delete(id);
      return deliver(h.target, input);
    }
    const t = resolveTarget();
    notify();
    if (!t) return false;
    if (input.action === 'keydown' && id) held.set(id, { target: t, input });
    return deliver(t, input);
  }

  async function press(key: KeySpec, modifiers: AuraKeyboardInput['modifiers'] = {}): Promise<boolean> {
    const mods = (['ctrl', 'alt', 'shift', 'meta'] as const).filter((m) => modifiers[m]);
    for (const m of mods) await send({ action: 'keydown', ...MODIFIER_KEYS[m], modifiers });
    const ok = await send({ action: 'keydown', ...key, modifiers });
    await send({ action: 'keyup', ...key, modifiers });
    for (const m of mods.reverse()) await send({ action: 'keyup', ...MODIFIER_KEYS[m], modifiers });
    return ok;
  }

  async function releaseAllKeys(): Promise<void> {
    const all = [...held.entries()];
    held.clear();
    for (const [, h] of all) deliver(h.target, { ...h.input, action: 'keyup', repeat: false });
  }

  return {
    send,
    press,
    setTargetActivity(viewId) { pinnedViewId = viewId; notify(); },
    getTargetActivity: () => pinnedViewId,
    releaseAllKeys,
    resolveTarget,
    subscribe(cb) { subs.add(cb); cb(resolveTarget()); return () => subs.delete(cb); },
  };
}

const SSR_STUB: AuraInputManager = {
  send: async () => false,
  press: async () => false,
  setTargetActivity: () => undefined,
  getTargetActivity: () => null,
  releaseAllKeys: async () => undefined,
  resolveTarget: () => null,
  subscribe: () => () => undefined,
};

export function inputManager(): AuraInputManager {
  if (typeof window === 'undefined') return SSR_STUB;
  const w = window as unknown as { __auraInputManager?: AuraInputManager };
  return (w.__auraInputManager ??= create());
}
