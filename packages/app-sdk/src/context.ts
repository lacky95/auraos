/**
 * Android-`Context`-equivalent for Aura apps: a typed view of the env-vars
 * + request headers that an app receives from the OS. Centralises the bits
 * every app used to reach for via `process.env['APP_ID']` / manual header
 * parsing.
 *
 * It is also the SDK's ONE place that says who this app is: `ownAppId()` and
 * `ownInstanceId()` (env on a server or in a sidecar that inherits the
 * identity, the runtime bootstrap in a page), and the identity response
 * headers (`identityResponseHeaders()`) every runtime stamps.
 */
import { appHostRuntime, osEnv } from './os-auth.js';

/** This app's id: `APP_ID` (sidecars: `AURA_APP_ID`) on a server, the runtime bootstrap in a page. Null outside AuraOS. */
export function ownAppId(): string | null {
  const env = osEnv();
  return env['APP_ID'] || env['AURA_APP_ID'] || appHostRuntime()?.appId || null;
}

/**
 * This instance's id: `APP_INSTANCE_ID` (sidecars: `AURA_INSTANCE_ID`) on a
 * server, the runtime bootstrap in a page. Null outside AuraOS.
 */
export function ownInstanceId(): string | null {
  const env = osEnv();
  return env['APP_INSTANCE_ID'] || env['AURA_INSTANCE_ID'] || appHostRuntime()?.instanceId || null;
}

/**
 * `X-Aura-App-Id` / `X-Aura-Instance-Id` for a response this app sends: the
 * identity the shell (App Host router, machine path) and the reconciler check
 * against the instance they expect (port-squat protection). Server side; {}
 * outside AuraOS. The shell sets the request-side headers itself; an app never
 * sends them on a request.
 */
export function identityResponseHeaders(): Record<string, string> {
  const env = osEnv();
  const out: Record<string, string> = {};
  if (env['APP_ID']) out['X-Aura-App-Id'] = env['APP_ID'];
  if (env['APP_INSTANCE_ID']) out['X-Aura-Instance-Id'] = env['APP_INSTANCE_ID'];
  return out;
}

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
  const appId      = ownAppId()                        ?? 'unknown';
  const instanceId = ownInstanceId()                   ?? appId;
  const appPort    = Number(process.env['APP_PORT']    ?? 4001);
  const osApiBase  = process.env['OS_API_BASE']        ?? 'http://localhost:3000';
  const dataDir    = process.env['AURA_DATA_DIR']      ?? '/data';
  const layerTag   = process.env['AURA_LAYER_TAG']     ?? '';
  return { appId, instanceId, appPort, osApiBase, dataDir, layerTag };
}

/**
 * Identity headers the shell stamps on every request it forwards to the app,
 * from its App Host or the machine path (`/api/proxy/<id>`). The activity id
 * is only set when the window URL carries `_aura_activity`; for
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
