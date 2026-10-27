// DOM test harness (phase 6): a happy-dom Window installed as the globals the
// shell's runtime-rendered components use (document, HTMLElement, CSS.escape,
// localStorage, requestAnimationFrame, …). Import this module FIRST, then
// import the component modules dynamically, so their top-level code sees it.
//
//   import { dom, resetDom } from './dom.ts';
//   const { renderNotificationCard } = await import('../src/components/shell/notifications/NotificationCard.ts');
import { after } from 'node:test';
import { Window } from 'happy-dom';

export const dom = new Window({ url: 'http://aura-shell.test/', width: 1280, height: 800 });

const g = globalThis as Record<string, unknown>;
const KEYS = [
  'window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'HTMLIFrameElement', 'HTMLSelectElement', 'HTMLOptionElement', 'SVGElement', 'SVGSVGElement', 'DocumentFragment', 'Text',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'AnimationEvent',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'localStorage', 'sessionStorage', 'CSS', 'DOMRect', 'matchMedia',
] as const;
for (const k of KEYS) {
  const v = (dom as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  Object.defineProperty(g, k, { value: typeof v === 'function' && /^[a-z]/.test(k) ? (v as (...a: unknown[]) => unknown).bind(dom) : v, configurable: true, writable: true });
}
// `window` itself must be the happy-dom window (components read window.__aura…).
Object.defineProperty(g, 'window', { value: dom, configurable: true, writable: true });

// The window keeps the event loop alive (its own timers / tasks): close it
// when the file's tests are done, or the test process never exits.
after(async () => { await dom.happyDOM.close(); });

/** Empty <body>, cleared storage. Call at the start of every test. */
export function resetDom(html = ''): void {
  dom.document.body.innerHTML = html;
  try { dom.localStorage.clear(); } catch { /* ignore */ }
}

/** Let queued microtasks + one animation frame run. */
export async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => dom.requestAnimationFrame(() => r(undefined)));
}

/** Give `el` a layout box (happy-dom has no layout engine). */
export function setRect(el: Element, r: { left: number; top: number; width: number; height: number }): void {
  (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
    x: r.left, y: r.top, left: r.left, top: r.top, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, toJSON() { return this; },
  });
}
