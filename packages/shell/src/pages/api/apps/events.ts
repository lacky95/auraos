import type { APIRoute } from 'astro';
import { OsEventBus } from '@aura/core';

export const GET: APIRoute = () => {
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

      const send = (data: unknown) =>
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

      const onStateChanged  = (ev: unknown) => send({ type: 'app:stateChanged', ...(ev as object) });
      const onCrashed       = (ev: unknown) => send({ type: 'app:crashed',      ...(ev as object) });
      const onInstalled     = (ev: unknown) => send({ type: 'app:installed',    ...(ev as object) });
      const onRemoved       = (ev: unknown) => send({ type: 'app:removed',      ...(ev as object) });
      const onActOpened     = (ev: unknown) => send({ type: 'activity:opened',  ...(ev as object) });
      const onActClosed     = (ev: unknown) => send({ type: 'activity:closed',  ...(ev as object) });
      const onThemeChanged  = (ev: unknown) => send({ type: 'theme:changed',    ...(ev as object) });
      const onNotification  = (ev: unknown) => send({ type: 'notification',     ...(ev as object) });

      OsEventBus.on('app:stateChanged',   onStateChanged);
      OsEventBus.on('app:crashed',        onCrashed);
      OsEventBus.on('app:installed',      onInstalled);
      OsEventBus.on('app:removed',        onRemoved);
      OsEventBus.on('activity:opened',    onActOpened);
      OsEventBus.on('activity:closed',    onActClosed);
      OsEventBus.on('theme:changed',      onThemeChanged);
      OsEventBus.on('notification',       onNotification);

      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(': heartbeat\n\n')), 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        OsEventBus.off('app:stateChanged',   onStateChanged);
        OsEventBus.off('app:crashed',        onCrashed);
        OsEventBus.off('app:installed',      onInstalled);
        OsEventBus.off('app:removed',        onRemoved);
        OsEventBus.off('activity:opened',    onActOpened);
        OsEventBus.off('activity:closed',    onActClosed);
        OsEventBus.off('theme:changed',      onThemeChanged);
        OsEventBus.off('notification',       onNotification);
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
