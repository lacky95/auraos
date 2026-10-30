/**
 * Open requests that survive a component that is not there yet.
 *
 * The top-bar dialogs (viewport settings, About) are React islands hydrated
 * when the browser is idle (`client:idle`), so React stays off the boot path.
 * A click that comes before that must not be lost: `requestOpen` remembers it
 * until a listener takes it, and `onOpenRequest` takes one that is already
 * waiting when it registers. Also works as a plain window CustomEvent for
 * anything that still listens the old way.
 */
const KEY = '__auraPendingOpen';

function pending(): Set<string> {
  const w = window as unknown as Record<string, Set<string> | undefined>;
  return (w[KEY] ??= new Set<string>());
}

export function requestOpen(name: string): void {
  pending().add(name);
  window.dispatchEvent(new CustomEvent(name));
}

/** Listen for `name`; runs `fn` at once when a request is already waiting. */
export function onOpenRequest(name: string, fn: () => void): () => void {
  const handler = () => { pending().delete(name); fn(); };
  window.addEventListener(name, handler);
  if (pending().has(name)) handler();
  return () => window.removeEventListener(name, handler);
}
