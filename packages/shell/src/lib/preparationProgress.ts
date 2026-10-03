/** JSON compatibility for existing callers; opt-in streaming for long CLI
 * preparation requests. Disconnecting a viewer does not interrupt repair. */
export function withPreparationProgress(request: Request, work: (onLine: (line: string) => void) => Promise<Response>): Promise<Response> | Response {
  if (!request.headers.get('accept')?.includes('text/event-stream')) return work(() => undefined);
  const encoder = new TextEncoder();
  let connected = true;
  let heartbeat: ReturnType<typeof setInterval>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (!connected) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
        catch { connected = false; }
      };
      send({ type: 'progress', line: 'Preparing app…' });
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), 10000);
      void work(line => send({ type: 'progress', line })).then(async response => {
        send({ type: 'result', status: response.status, body: await response.json() });
      }).catch(error => {
        send({ type: 'result', status: 500, body: { ok: false, error: String(error) } });
      }).finally(() => {
        clearInterval(heartbeat);
        if (connected) { connected = false; controller.close(); }
      });
    },
    cancel() { connected = false; clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
