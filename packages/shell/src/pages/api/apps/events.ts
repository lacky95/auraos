import type { APIRoute } from 'astro';
import { OsEventBus, compileTopicMatcher, getAppManager, parseTopicsParam, createLogger } from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { gatewayEventView, principalEventView, type GatewayEventView } from '../../../lib/access/gatewayEvents.ts';
import { authenticate } from '../../../lib/auth.ts';
import { followSession, streamSessionOf } from '../../../lib/streamSession.ts';
import { isSystemTerminal } from '../../../../server/terminal-embed.mjs';

const log = createLogger('sse');
let nextStreamId = 1;

/**
 * SSE feed of OS events. Without `?topics=` it's a firehose (back-compat
 * with existing consumers). With `?topics=app:*,activity:*` etc. only the
 * matching events are written to the stream — equivalent to Android
 * `<intent-filter>` registration on a BroadcastReceiver, so consumers stop
 * paying for event types they don't care about.
 *
 * An app instance gets its own filtered view (lib/access/gatewayEvents.ts):
 * an App Host caller, and an instance that presents its own token (the SDK's
 * server side, sidecars). The System Terminal's own instance keeps the whole
 * stream: it is the owner's terminal (D29), where `aura events` and
 * `aura ps -w` run. A stream opened on a sign-in (the desktop's login, an App
 * Host frame, an admin session) ends when that sign-in is revoked or expires
 * (lib/streamSession.ts).
 */
export const GET: APIRoute = async ({ url, request }) => {
  const mgr = getAppManager();
  const gateway = gatewayEventView(request, { getInstance: (id) => mgr.getInstance(id) });
  if (gateway === 'invalid') {
    return new Response(JSON.stringify({ error: 'gateway-identity-invalid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  let view: GatewayEventView | null = gateway;
  let principal: AccessPrincipal | null = null;
  if (!view) {
    const p = await authenticate(request);
    if (p instanceof Response) return p;
    principal = p;
    view = await principalEventView(p, { getInstance: (id) => mgr.getInstance(id) }, isSystemTerminal);
  }
  const session = streamSessionOf(request, principal);
  const topics = parseTopicsParam(url.searchParams.get('topics'));
  // null → firehose (no filter); [] is technically impossible here because
  // parseTopicsParam collapses empty lists to null. A populated array →
  // matcher; any other event is silently dropped before the JSON encode.
  const accepts = topics ? compileTopicMatcher(topics) : null;

  const encoder = new TextEncoder();
  const streamId = nextStreamId++;
  const t0 = Date.now();
  log.info('open', `#${streamId}`, 'topics=', topics ?? '*');

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      // Flush headers immediately. Without an initial chunk, Node's HTTP
      // adapter holds the response open with no bytes on the wire — the
      // browser then reports "can't establish a connection" and retries
      // every few seconds because it never saw the 200 + headers. One
      // SSE comment line is enough to commit the response.
      controller.enqueue(encoder.encode(`: ok ${streamId}\n\n`));

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
        if (view && !view.allows(type, ev)) return;
        safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type, ...(ev as object) })}\n\n`));
      };

      const onStateChanged  = (ev: unknown) => send('app:stateChanged', ev);
      const onCrashed       = (ev: unknown) => send('app:crashed',      ev);
      const onSidecars      = (ev: unknown) => send('app:sidecarsChanged', ev);
      const onInstalled     = (ev: unknown) => send('app:installed',    ev);
      const onRemoved       = (ev: unknown) => send('app:removed',      ev);
      const onActOpened     = (ev: unknown) => send('activity:opened',  ev);
      const onActClosed     = (ev: unknown) => send('activity:closed',  ev);
      const onActFocus      = (ev: unknown) => send('activity:focus',   ev);
      const onActNavigated  = (ev: unknown) => send('activity:navigated', ev);
      const onActBreadcrumb = (ev: unknown) => send('activity:breadcrumbChanged', ev);
      // Free-flight activities: apps follow their flights (SDK FlightHandle).
      const FLIGHT_EVENTS = ['activity:flightChanged', 'activity:flightClosing', 'activity:flightKept', 'activity:flightAction'] as const;
      const onFlight = FLIGHT_EVENTS.map((t) => [t, (ev: unknown) => send(t, ev)] as const);
      const onThemeChanged  = (ev: unknown) => send('theme:changed',    ev);
      const onModeChanged   = (ev: unknown) => send('mode:changed',     ev);
      // Phase 5: the legacy content-carrying 'notification' relay is gone (it leaked
      // every notification, secret ones included, to every app). Notifications are
      // read through /api/notifications (own items, or a notifications.read grant).
      const onUiCommand     = (ev: unknown) => send('ui:command',       ev);
      const onWsChanged     = (ev: unknown) => send('workspaces:changed',  ev);
      const onWsActivated   = (ev: unknown) => send('workspace:activated', ev);
      const onKvChanged     = (ev: unknown) => send('kv:changed',          ev);
      const onRestarting    = (ev: unknown) => send('app:restarting',      ev);
      const onRestarted     = (ev: unknown) => send('app:restarted',       ev);
      const onRestartFailed = (ev: unknown) => send('app:restartFailed',   ev);

      OsEventBus.on('app:stateChanged',   onStateChanged);
      OsEventBus.on('app:crashed',        onCrashed);
      OsEventBus.on('app:sidecarsChanged', onSidecars);
      OsEventBus.on('app:installed',      onInstalled);
      OsEventBus.on('app:removed',        onRemoved);
      OsEventBus.on('activity:opened',    onActOpened);
      OsEventBus.on('activity:closed',    onActClosed);
      OsEventBus.on('activity:focus',     onActFocus);
      OsEventBus.on('activity:navigated', onActNavigated);
      OsEventBus.on('activity:breadcrumbChanged', onActBreadcrumb);
      for (const [t, fn] of onFlight) (OsEventBus as unknown as { on(e: string, f: (ev: unknown) => void): void }).on(t, fn);
      OsEventBus.on('theme:changed',      onThemeChanged);
      OsEventBus.on('mode:changed',       onModeChanged);
      OsEventBus.on('ui:command',         onUiCommand);
      OsEventBus.on('workspaces:changed',  onWsChanged);
      OsEventBus.on('workspace:activated', onWsActivated);
      OsEventBus.on('kv:changed',          onKvChanged);
      OsEventBus.on('app:restarting',      onRestarting);
      OsEventBus.on('app:restarted',       onRestarted);
      OsEventBus.on('app:restartFailed',   onRestartFailed);

      const end = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try { controller.close(); } catch { /* already closed */ }
      };
      // The sign-in this stream was opened on: revoked or expired ends it.
      const following = session ? followSession(session, end) : null;

      // 10s keeps idle connections from being killed by reverse proxies
      // (Nginx default 60s, Cloudflare 100s) without flooding the wire.
      const heartbeat = setInterval(() => {
        if (view && !view.live()) { end(); return; }
        following?.recheck();
        safeEnqueue(encoder.encode(': hb\n\n'));
      }, 10_000);

      const cleanup = () => {
        log.info('close', `#${streamId}`, 'dur=', `${Date.now() - t0}ms`);
        following?.stop();
        clearInterval(heartbeat);
        OsEventBus.off('app:stateChanged',   onStateChanged);
        OsEventBus.off('app:crashed',        onCrashed);
        OsEventBus.off('app:sidecarsChanged', onSidecars);
        OsEventBus.off('app:installed',      onInstalled);
        OsEventBus.off('app:removed',        onRemoved);
        OsEventBus.off('activity:opened',    onActOpened);
        OsEventBus.off('activity:closed',    onActClosed);
        OsEventBus.off('activity:focus',     onActFocus);
        OsEventBus.off('activity:navigated', onActNavigated);
        for (const [t, fn] of onFlight) (OsEventBus as unknown as { off(e: string, f: (ev: unknown) => void): void }).off(t, fn);
        OsEventBus.off('activity:breadcrumbChanged', onActBreadcrumb);
        OsEventBus.off('theme:changed',      onThemeChanged);
        OsEventBus.off('mode:changed',       onModeChanged);
        OsEventBus.off('ui:command',         onUiCommand);
        OsEventBus.off('workspaces:changed',  onWsChanged);
        OsEventBus.off('workspace:activated', onWsActivated);
        OsEventBus.off('kv:changed',          onKvChanged);
        OsEventBus.off('app:restarting',      onRestarting);
        OsEventBus.off('app:restarted',       onRestarted);
        OsEventBus.off('app:restartFailed',   onRestartFailed);
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
