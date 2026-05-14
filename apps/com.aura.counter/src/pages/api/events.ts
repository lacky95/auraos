import type { APIRoute } from 'astro';
import { state, snapshot } from '../../state.js';

export const GET: APIRoute = () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); } catch { closed = true; cleanup(); }
      };
      const send = () => safeEnqueue(encoder.encode(`data: ${JSON.stringify(snapshot())}\n\n`));

      state.listeners.add(send);
      send();
      const heartbeat = setInterval(() => safeEnqueue(encoder.encode(': hb\n\n')), 15_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        state.listeners.delete(send);
      };
      (this as unknown as { _cleanup: () => void })._cleanup = cleanup;
    },
    cancel() { (this as unknown as { _cleanup?: () => void })._cleanup?.(); },
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
