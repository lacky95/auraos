import type { APIRoute } from 'astro';
import { OsEventBus, compileTopicMatcher, parseTopicsParam } from '@aura/core';

/**
 * SSE feed of OS events. Without `?topics=` it's a firehose (back-compat
 * with existing consumers). With `?topics=app:*,activity:*` etc. only the
 * matching events are written to the stream — equivalent to Android
 * `<intent-filter>` registration on a BroadcastReceiver, so consumers stop
 * paying for event types they don't care about.
 */
export const GET: APIRoute = ({ url }) => {
  const topics = parseTopicsParam(url.searchParams.get('topics'));
  // null → firehose (no filter); [] is technically impossible here because
  // parseTopicsParam collapses empty lists to null. A populated array →
  // matcher; any other event is silently dropped before the JSON encode.
  const accepts = topics ? compileTopicMatcher(topics) : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
          cleanup();
        }
      };

      const send = (type: string, ev: unknown) => {
        if (accepts && !accepts(type)) return;
        safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type, ...(ev as object) })}\n\n`));
      };

      const onStateChanged  = (ev: unknown) => send('app:stateChanged', ev);
      const onCrashed       = (ev: unknown) => send('app:crashed',      ev);
      const onInstalled     = (ev: unknown) => send('app:installed',    ev);
      const onRemoved       = (ev: unknown) => send('app:removed',      ev);
      const onActOpened     = (ev: unknown) => send('activity:opened',  ev);
      const onActClosed     = (ev: unknown) => send('activity:closed',  ev);
      const onActFocus      = (ev: unknown) => send('activity:focus',   ev);
      const onThemeChanged  = (ev: unknown) => send('theme:changed',    ev);
      const onModeChanged   = (ev: unknown) => send('mode:changed',     ev);
      const onNotification  = (ev: unknown) => send('notification',     ev);
      const onWsChanged     = (ev: unknown) => send('workspaces:changed',  ev);
      const onWsActivated   = (ev: unknown) => send('workspace:activated', ev);
      const onKvChanged     = (ev: unknown) => send('kv:changed',          ev);

      OsEventBus.on('app:stateChanged',   onStateChanged);
      OsEventBus.on('app:crashed',        onCrashed);
      OsEventBus.on('app:installed',      onInstalled);
      OsEventBus.on('app:removed',        onRemoved);
      OsEventBus.on('activity:opened',    onActOpened);
      OsEventBus.on('activity:closed',    onActClosed);
      OsEventBus.on('activity:focus',     onActFocus);
      OsEventBus.on('theme:changed',      onThemeChanged);
      OsEventBus.on('mode:changed',       onModeChanged);
      OsEventBus.on('notification',       onNotification);
      OsEventBus.on('workspaces:changed',  onWsChanged);
      OsEventBus.on('workspace:activated', onWsActivated);
      OsEventBus.on('kv:changed',          onKvChanged);

      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(': heartbeat\n\n')), 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        OsEventBus.off('app:stateChanged',   onStateChanged);
        OsEventBus.off('app:crashed',        onCrashed);
        OsEventBus.off('app:installed',      onInstalled);
        OsEventBus.off('app:removed',        onRemoved);
        OsEventBus.off('activity:opened',    onActOpened);
        OsEventBus.off('activity:closed',    onActClosed);
        OsEventBus.off('activity:focus',     onActFocus);
        OsEventBus.off('theme:changed',      onThemeChanged);
        OsEventBus.off('mode:changed',       onModeChanged);
        OsEventBus.off('notification',       onNotification);
        OsEventBus.off('workspaces:changed',  onWsChanged);
        OsEventBus.off('workspace:activated', onWsActivated);
        OsEventBus.off('kv:changed',          onKvChanged);
      };

      (this as unknown as { _cleanup: () => void })._cleanup = cleanup;
    },
    cancel() {
      (this as unknown as { _cleanup?: () => void })._cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
