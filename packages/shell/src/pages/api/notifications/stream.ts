import type { APIRoute } from 'astro';
// Namespace import, as in the other notification routes.
import * as core from '@aura/core';
import { authenticate } from '../../../lib/auth.js';
import { viewerFor } from '../../../lib/clientSession.js';

/**
 * Live notification feed (SSE) with catch-up.
 *
 *   GET /api/notifications/stream            live only
 *   GET … with `Last-Event-ID: <id>` or `?since=<id>`
 *                                            first every event after <id>
 *                                            (from the `notif:events` stream), then live
 *
 * Every message is a default SSE `message` with `id: <stream id>`:
 *
 *   data: {"type":"notification:<event>","eventId","event","id","state","notification"}
 *
 * `notification` is the item's CURRENT full state (null if it is gone). It
 * is not a snapshot from when the event happened, so during catch-up several
 * events for one item all carry its latest state.
 *
 *   data: {"type":"reset","eventId"}
 *
 * is sent when <id> is unknown or older than the trimmed stream. The client
 * must reload with `GET /api/notifications` and continue from `eventId`.
 *
 * Unlike the app firehose (`/api/apps/events`), this feed carries content.
 * The notification events are deliberately NOT on that firehose.
 *
 * Read access (phase 5) — the same rules as GET /api/notifications, for
 * catch-up AND live events:
 *   - a verified app / API key: its OWN items plus what a
 *     `notifications.read` grant covers;
 *   - a shell screen (`?cs=<client session>`; EventSource can't send
 *     headers): every item in the view of its lock state, re-checked per
 *     event — while locked, private items arrive redacted and secret items
 *     are skipped entirely;
 *   - anonymous WITHOUT a client session: nothing (the stream stays open
 *     with heartbeats only);
 *   - admin sessions: everything.
 * An invalid credential → 401.
 */
const EVENT_NAMES = [
  'created', 'updated', 'displayed', 'seen', 'resolved', 'removed', 'interacted',
] as const;
type EventName = typeof EVENT_NAMES[number];
interface BusPayload { eventId: string; id: string; state: string }
interface Ev extends BusPayload { event: EventName }

const STREAM_ID = /^\d{1,20}-\d{1,20}$/;

/** Compare stream ids `<ms>-<seq>`. */
function cmp(a: string, b: string): number {
  const [am = '0', as = '0'] = a.split('-');
  const [bm = '0', bs = '0'] = b.split('-');
  const d = BigInt(am) - BigInt(bm);
  if (d !== 0n) return d < 0n ? -1 : 1;
  const e = BigInt(as) - BigInt(bs);
  return e === 0n ? 0 : e < 0n ? -1 : 1;
}

let nextStreamNo = 1;

export const GET: APIRoute = async ({ request, url }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const since = (request.headers.get('last-event-id') ?? url.searchParams.get('since') ?? '').trim();
  const svc = core.getNotificationService();
  // Access is resolved per event (cached for a second), so a lock / unlock
  // of the screen applies to the very next event.
  let accessAt = 0;
  let access: Promise<core.Access> | null = null;
  const currentAccess = (): Promise<core.Access> => {
    if (!access || Date.now() - accessAt > 1_000) {
      accessAt = Date.now();
      access = viewerFor(request, principal, { url }).then((v) => svc.accessFor(v));
    }
    return access;
  };
  const bus = core.OsEventBus as unknown as {
    on(type: string, fn: (ev: BusPayload) => void): void;
    off(type: string, fn: (ev: BusPayload) => void): void;
  };
  const encoder = new TextEncoder();
  const streamNo = nextStreamNo++;
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(s)); } catch { closed = true; cleanup(); }
      };
      // Commit headers immediately (see api/apps/events.ts).
      write(`: ok notifications#${streamNo}\n\n`);

      // Subscribe FIRST and buffer, so nothing between the catch-up read
      // and going live is lost. Events ≤ the last sent id are dropped.
      let catchingUp = true;
      const pending: Ev[] = [];
      let lastSent = '';
      let chain: Promise<void> = Promise.resolve();

      const sendEvent = async (ev: Ev) => {
        if (lastSent && cmp(ev.eventId, lastSent) <= 0) return;
        lastSent = ev.eventId;
        let notification: unknown = null;
        try {
          notification = await svc.viewById(ev.id, await currentAccess());
        } catch { return; }
        // Not readable for this viewer (or gone): skip the event entirely.
        if (!notification) return;
        write(`id: ${ev.eventId}\ndata: ${JSON.stringify({ type: `notification:${ev.event}`, ...ev, notification })}\n\n`);
      };
      const enqueue = (ev: Ev) => { chain = chain.then(() => sendEvent(ev)).catch(() => {}); };

      const handlers = EVENT_NAMES.map((event) => {
        const fn = (p: BusPayload) => {
          const ev: Ev = { eventId: p.eventId, id: p.id, state: p.state, event };
          if (catchingUp) pending.push(ev); else enqueue(ev);
        };
        bus.on(`notification:${event}`, fn);
        return [`notification:${event}`, fn] as const;
      });

      const heartbeat = setInterval(() => write(': hb\n\n'), 10_000);
      cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        for (const [type, fn] of handlers) bus.off(type, fn);
      };

      const sendReset = async () => {
        const bounds = await svc.events.eventBounds();
        const at = bounds?.last ?? '0-0';
        lastSent = at;
        write(`id: ${at}\ndata: ${JSON.stringify({ type: 'reset', eventId: at })}\n\n`);
      };

      void (async () => {
        try {
          if (since) {
            if (!STREAM_ID.test(since)) {
              await sendReset();
            } else {
              let cursor = since;
              for (;;) {
                const { events, reset } = await svc.events.eventsSince(cursor);
                if (reset) { await sendReset(); break; }
                for (const e of events) await sendEvent(e as Ev);
                if (events.length < 1000) break;
                cursor = events[events.length - 1]!.eventId;
              }
            }
          }
        } catch (err) {
          write(`: catch-up failed: ${(err as Error).message}\n\n`);
        } finally {
          catchingUp = false;
          for (const ev of pending.splice(0)) enqueue(ev);
        }
      })();
    },
    cancel() {
      cleanup();
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
