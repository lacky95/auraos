/**
 * Android-`Context`-equivalent for Aura apps: a typed view of the env-vars
 * + request headers that an app receives from the OS. Centralises the bits
 * every app used to reach for via `process.env['APP_ID']` / manual header
 * parsing.
 */

export interface AppContext {
  /** Reverse-domain app id, e.g. "com.aura.notepad". */
  appId: string;
  /** Per-process identity. For instanceMode='single' this equals `appId`. */
  instanceId: string;
  /** Port the app's astro is listening on (also reachable via `process.env.APP_PORT`). */
  appPort: number;
  /** Base URL of the shell — apps post notifications + provider data here. */
  osApiBase: string;
  /** Filesystem path the OS bound into the proot as `/data` for THIS instance. */
  dataDir: string;
  /** Static tag describing the sandbox stack (e.g. "[proot+ctnr]"). Set by ProotRunner. */
  layerTag: string;
}

/**
 * Snapshot of the OS env at process start. Safe to call once at module load.
 * Use this instead of reading `process.env['APP_ID']` directly so all the
 * key names live in one file.
 */
export function getAppContext(): AppContext {
  const appId      = process.env['APP_ID']             ?? 'unknown';
  const instanceId = process.env['APP_INSTANCE_ID']    ?? appId;
  const appPort    = Number(process.env['APP_PORT']    ?? 4001);
  const osApiBase  = process.env['OS_API_BASE']        ?? 'http://localhost:3000';
  const dataDir    = process.env['AURA_DATA_DIR']      ?? '/data';
  const layerTag   = process.env['AURA_LAYER_TAG']     ?? '';
  return { appId, instanceId, appPort, osApiBase, dataDir, layerTag };
}

/**
 * Identity headers the shell's proxy stamps on every proxied request. The
 * activity id is only set when the iframe URL carries `_aura_activity`; for
 * single-activity / non-activity apps it's `null`.
 *
 * Use from any Astro API route:
 *
 *   export const POST: APIRoute = ({ request }) => {
 *     const { activityId } = readIdentityHeaders(request);
 *     ...
 *   };
 */
export interface IdentityHeaders {
  appId: string | null;
  instanceId: string | null;
  activityId: string | null;
}

export function readIdentityHeaders(request: Request): IdentityHeaders {
  return {
    appId:      request.headers.get('x-aura-app-id'),
    instanceId: request.headers.get('x-aura-instance-id'),
    activityId: request.headers.get('x-aura-activity-id'),
  };
}

/**
 * The URL prefix the shell loads this iframe at — e.g.
 * `"/api/proxy/com.aura.docs-3"`. SPA frameworks (Next.js, SvelteKit, Nuxt,
 * Angular, Vue Router) need this as their `basePath` / `base` / router base
 * URL so client-side navigation URLs match what the SSR'd HTML contains.
 * Without it, the framework hydration sees a mismatch and blanks the page
 * — the gnarly "React 19 hydration wiped the DOM" symptom.
 *
 * The proxy publishes this value in three redundant places that stay in
 * sync; this helper picks whichever the current context has access to:
 *   1. `globalThis.AURA_APP_BASE_PATH` — set by an inline script the proxy
 *      injects BEFORE any app `<script>` runs. Safest browser source.
 *   2. `<meta name="aura-app-base-path">` — fallback for bundlers that
 *      isolated the global (rare).
 *   3. `process.env.APP_INSTANCE_ID` — Node / SSR. Reconstructs the prefix
 *      from the runner-provided instance id.
 *
 * Returns the empty string when nothing is available (running outside the
 * OS, e.g. local `astro dev` for the app alone) so framework consumers
 * can `?? '/'` if they want a leading slash, or pass it through unchanged
 * if they treat empty as "root".
 *
 * Example — Next.js dynamic basePath in next.config.mjs:
 *
 *   const basePath = globalThis.AURA_APP_BASE_PATH
 *     ?? (process.env.APP_INSTANCE_ID ? `/api/proxy/${process.env.APP_INSTANCE_ID}` : '');
 *   export default { basePath };
 *
 * Example — Vue Router:
 *
 *   import { getAppBasePath } from '@aura/app-sdk';
 *   const router = createRouter({ history: createWebHistory(getAppBasePath()) });
 */
export function getAppBasePath(): string {
  // Browser path — prefer the window global, fall back to the meta tag.
  // typeof checks satisfy both Node SSR and bundler tree-shaking.
  if (typeof document !== 'undefined') {
    const g = globalThis as { AURA_APP_BASE_PATH?: string };
    if (typeof g.AURA_APP_BASE_PATH === 'string') return g.AURA_APP_BASE_PATH;
    const meta = document.querySelector('meta[name="aura-app-base-path"]');
    const v = meta?.getAttribute('content');
    if (v) return v;
  }
  // SSR / Node — reconstruct from env. Falls through to '' when neither
  // ID is set so callers can apply their own default.
  if (typeof process !== 'undefined') {
    const id = process.env['APP_INSTANCE_ID'] ?? process.env['APP_ID'];
    if (id) return `/api/proxy/${id}`;
  }
  return '';
}
