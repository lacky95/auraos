/**
 * An Activity is a single UI screen of an app (analogous to Android's Activity).
 *
 * Apps with `manifest.activityMode='multi'` can host multiple concurrent activities
 * on a single backend instance. Each activity has its own activityId; the OS propagates
 * it via the `X-Aura-Activity-Id` header on every proxied request.
 *
 * Apps MAY implement these optional lifecycle hooks:
 *   POST /api/lifecycle/onActivityCreate                 — body: { activityId, data? }
 *                                                          may return { path, title, metadata }
 *   POST /api/lifecycle/onActivityDestroy/[activityId]
 *
 * If the hook returns a `path`, the OS opens the iframe at that path inside the proxy.
 * Apps without the hook get activities transparently — iframe defaults to `/`.
 */
export interface AppActivity {
  /** Format: `${parentInstanceId}#a${counter}`, e.g. "com.aura.notepad#a3". */
  activityId: string;
  parentInstanceId: string;
  appId: string;
  /**
   * Initial path inside the app the iframe is pointed at (relative, leading slash optional).
   * Returned by `onActivityCreate`; defaults to `/` if the app doesn't return one.
   */
  path: string;
  createdAt: Date;
  lastTransitionAt: Date;
  /** Optional metadata returned by the app (e.g. tab title). */
  title?: string;
  metadata?: Record<string, unknown>;
  /**
   * Whether the user is allowed to minimize this activity. Default: false
   * (activity windows can only be closed). The app declares this via the
   * `onActivityCreate` hook returning `{ minimizable: true }`. The OS shell
   * additionally requires `manifest.backgroundService=true` before showing
   * the minimize button — minimizing a non-background app is pointless,
   * since the backend dies as soon as no window is visible.
   */
  minimizable?: boolean;
}
