import type { AccessSurface } from './types.ts';

/**
 * Ways into the shell that aren't Astro API routes. Data only: see types.ts.
 *
 * An entry with `attach` names the call in `attachShellServers`; one with
 * `page` names an Astro page. test/route-access-manifest.test.ts fails when
 * either gains something this list doesn't classify.
 */

const decide = (phase: number, note: string) => ({ ambiguous: true, decision: { phase, note } }) as const;

export const SURFACE_MANIFEST: readonly AccessSurface[] = [
  {
    id: 'shell-listener',
    kind: 'listener',
    source: 'packages/shell/server.mjs',
    paths: ['*'],
    rule: {
      allow: [],
      target: 'system',
      ...decide(1, 'Serves nothing itself: requests go to the surfaces here and the API routes. It binds 0.0.0.0, so forwarded headers count only from a configured trusted proxy (5.11).'),
    },
  },
  {
    id: 'app-hosts',
    kind: 'host-router',
    source: 'packages/shell/server/app-hosts.mjs',
    paths: ['{name}--{desktop host}/*'],
    attach: 'attachAppHosts',
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      ...decide(2, 'Claims the request before Astro and streams it to the app with no check. Needs the login handoff, then per-host enforcement.'),
    },
  },
  {
    id: 'ws-proxy',
    kind: 'websocket',
    source: 'packages/shell/server/attach.mjs',
    paths: ['/api/proxy/{id}/{path} (upgrade)'],
    attach: 'attachWsProxy',
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      ...decide(3, 'Upgrades never reach Astro middleware, so this needs its own check. It resolves targets through an anonymous loopback GET /api/apps.'),
    },
  },
  {
    id: 'sse-mux',
    kind: 'websocket',
    source: 'packages/shell/server/sse-mux.mjs',
    paths: ['/_aura/sse-mux'],
    attach: 'attachShellSseMux',
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      ...decide(3, 'Reopens any same-origin path over loopback with the socket\'s cookie and authorization. Loopback must not count as trusted, and each stream is authorized as its own request.'),
    },
  },
  {
    id: 'socketio-os-events',
    kind: 'websocket',
    source: 'packages/shell/server/attach.mjs',
    paths: ['/os-events'],
    attach: 'attachSio',
    rule: {
      allow: ['owner'],
      target: 'system',
      ...decide(3, 'Anonymous, any origin, firehose by default. The `cs` client session only selects the lock-screen filter and is not a credential. Needs handshake auth and per-topic filtering.'),
    },
  },
  {
    id: 'socketio-kv',
    kind: 'websocket',
    source: 'packages/shell/server/attach.mjs',
    paths: ['/os-events (kv:changed)'],
    attach: 'attachSio',
    rule: {
      allow: ['owner'],
      target: 'kv-entry',
      ...decide(3, 'Relays kv:changed WITH values for every namespace, including private app/<id> buckets, bypassing the KV route\'s same-app check. Must apply the KV rules per event.'),
    },
  },
  {
    id: 'terminal-pty',
    kind: 'app-upstream',
    source: 'apps/com.aura.terminal (through ws-proxy)',
    paths: ['/api/proxy/com.aura.terminal/ws', '/api/proxy/{instanceId}/ws'],
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      ...decide(5, 'A shell on the owner\'s home, and every /ws connection creates state. The D29 table applies: System Terminal full, TerminalX embed only, other apps none until granted.'),
    },
  },
  {
    id: 'app-mcp',
    kind: 'app-upstream',
    source: 'manifest provides[] kind http/mcp (through /api/proxy)',
    paths: ['/api/proxy/{id}/{mcp address}'],
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      ...decide(5, 'Existing MCP URLs must keep working in Open (5.17). The private Terminal ingress identifies callers by socket, and Terminal MCP read and control need separate grants.'),
    },
  },
  {
    id: 'page-index',
    kind: 'page',
    source: 'packages/shell/src/pages/index.astro',
    paths: ['/'],
    page: '/',
    rule: {
      allow: ['owner'],
      target: 'system',
      ...decide(1, 'The desktop SSR includes installed apps and workspace state. An anonymous visitor must get the login or setup page here instead.'),
    },
  },
  {
    id: 'page-launcher',
    kind: 'page',
    source: 'packages/shell/src/pages/launcher.astro',
    paths: ['/launcher'],
    page: '/launcher',
    rule: { allow: ['owner'], target: 'system' },
  },
  {
    id: 'page-dev-notification-controls',
    kind: 'page',
    source: 'packages/shell/src/pages/dev/notification-controls.astro',
    paths: ['/dev/notification-controls'],
    page: '/dev/notification-controls',
    // Answers 404 outside the dev server.
    rule: { allow: ['owner'], target: 'system' },
  },
  {
    id: 'shell-static-assets',
    kind: 'static',
    source: 'packages/shell/public, astro build client output',
    paths: ['/_astro/*', '/favicon.ico'],
    rule: {
      allow: ['public', 'owner'],
      target: 'system',
      ...decide(1, 'The login page needs its bundles. Keep secrets and per-user data out of them. A /_astro request with an app Referer is redirected into that app\'s proxy path, which has its own rule.'),
    },
  },
  {
    id: 'vite-dev-server',
    kind: 'dev-server',
    source: 'packages/shell/astro.config.mjs (astro dev)',
    paths: ['/@vite/*', '/@fs/*', '/@id/*', '/src/*', '/node_modules/*'],
    rule: {
      allow: ['owner'],
      target: 'system',
      ...decide(3, 'Under `astro dev`, Vite serves source and files outside Astro\'s routes and middleware. Decide whether enforcement covers it or Normal Mode must use the production build.'),
    },
  },
];
