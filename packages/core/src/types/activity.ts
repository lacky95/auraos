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
  /**
   * Android back-stack equivalent. When set, this activity was launched on
   * top of another one in the same instance, and `goBack()` should close
   * this activity AND refocus its parent. Activities opened at the top level
   * (from the launcher, the dock, intents without a parent context) leave
   * this field unset — their close is a plain dismiss.
   *
   * Today task affinity is per-instance — `taskId === parentInstanceId`. If
   * we later allow stacked activities to migrate across instances (Android
   * `taskAffinity`), `taskId` becomes the source of truth instead.
   */
  stackParentId?: string;
  /** Stable task identifier. Defaults to `parentInstanceId`. */
  taskId: string;
  /**
   * In-activity back stack — the prior `{ path, title }` pairs the iframe
   * visited, in push order. Populated by `AppManager.navigateActivity()`
   * (the "replace-current with history" launch mode); popped by `goBack()`
   * before falling through to the close-activity / Nav-mode chain.
   *
   * Storing the title alongside the path lets the OS-rendered breadcrumb
   * trail show meaningful labels (e.g. "Settings › Theme") without an extra
   * round-trip to the app. Apps drive this via `osClient.activity.navigate(
   * path, { title })`.
   */
  history?: Array<{ path: string; title?: string }>;
  /**
   * Whether the OS chrome renders the breadcrumb trail + back button in the
   * window title bar.
   *
   *   'os'  (default) — Shell renders `← Title1 › Title2 › Current` from
   *                     `path/title + history`. Clicking a prior crumb pops
   *                     back to that level. Apps get this for free without
   *                     shipping any per-page chrome.
   *   'off'           — No OS-rendered trail. Use for apps that ship their
   *                     own header (media player, photo editor, anything
   *                     that wants its own typography). The back-stack
   *                     itself still works via OS Back / `osClient.activity.
   *                     back()` — only the visual is suppressed.
   *
   * Set per-activity via the `onActivityCreate` return (mirrors the
   * `minimizable` pattern), or at runtime via
   * `osClient.activity.setBreadcrumb('off')`.
   */
  breadcrumb?: 'os' | 'off';
}
