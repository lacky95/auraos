/**
 * Work that has to wait for a request's outcome. A guard that lets a call
 * through registers it here; the middleware runs it once with the final
 * status (the route's response, or 500 when the route threw), so what is
 * recorded is what happened, not what was about to.
 *
 * Per request, kept on the `Request` itself so nothing outlives it. A hook
 * never reaches the response and never throws into the middleware.
 */

type Hook = (status: number) => void | Promise<void>;

const hooks = new WeakMap<Request, Hook[]>();

/** Run `hook` with this request's final status. */
export function afterResponse(request: Request, hook: Hook): void {
  const list = hooks.get(request);
  if (list) list.push(hook);
  else hooks.set(request, [hook]);
}

/** The middleware's one call: run this request's hooks, once, without waiting for them. */
export function runAfterResponse(request: Request, status: number): void {
  const list = hooks.get(request);
  if (!list) return;
  hooks.delete(request);
  for (const hook of list) {
    try {
      void Promise.resolve(hook(status)).catch((err: unknown) => {
        console.warn(`[after-response] hook failed: ${(err as Error)?.message ?? err}`);
      });
    } catch (err) {
      console.warn(`[after-response] hook failed: ${(err as Error)?.message ?? err}`);
    }
  }
}
