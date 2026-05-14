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
