import { createActivityCreateHandler } from '@aura/app-sdk';

/**
 * Called by the OS when a new activity for this app is opened.
 *
 * When the OS dispatches a VIEW intent (e.g. from a host-intercepted popup),
 * `data.url` carries the destination. We forward it through the activity's
 * `path` as a `?url=` query param so the SSR page (`index.astro`) can seed
 * the engine iframe at the right URL from the first paint.
 *
 * No `data.url` → behave like a regular "open browser" launch (DEFAULT_HOME).
 */
export const POST = createActivityCreateHandler(({ activityId, data }) => {
  const shortId = activityId.split('#').pop() ?? '';
  const url = typeof data?.['url'] === 'string' ? data['url'] : null;
  if (url && /^https?:\/\//i.test(url)) {
    return {
      path:  `/?url=${encodeURIComponent(url)}`,
      title: titleForUrl(url, shortId),
    };
  }
  return { path: '/', title: `Browser ${shortId}` };
});

function titleForUrl(url: string, fallback: string): string {
  try {
    const host = new URL(url).host;
    return host || `Browser ${fallback}`;
  } catch {
    return `Browser ${fallback}`;
  }
}
