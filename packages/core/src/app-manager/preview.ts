/**
 * Preview instances (Track P, `aura dev patch preview`): a patch workspace
 * run as a separate instance of its app, with its own App Host slot, on a
 * copy of the app's data. Nothing is installed. AppManager `startPreview` /
 * `stopPreview` / `reapIdlePreviews`; the shell route is
 * `/api/apps/<id>/preview`.
 */

/** A preview with no window for this long is stopped (and its data copy removed). */
export const PREVIEW_IDLE_MS = 30 * 60_000;

const PREFIX = 'Preview · ';

/** The window title of a preview's activity: always marked "Preview". */
export function previewTitle(title: string | undefined, appName: string): string {
  const t = title ?? appName;
  return t.startsWith(PREFIX) ? t : `${PREFIX}${t}`;
}
