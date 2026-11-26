import type { AccessSurface } from './types.ts';

/**
 * Ways into the shell that aren't Astro API routes. Data only: see types.ts.
 *
 * An entry with `attach` names the call in `attachShellServers`; one with
 * `page` names an Astro page. test/route-access-manifest.test.ts fails when
 * either gains something this list doesn't classify. The `.mjs` surfaces ask
 * their rule through one helper, server/access-bridge.mjs `surfaceGate`,
 * which refuses in `enforce` what it denies.
 */

const decide = (phase: number, note: string) => ({ ambiguous: true, decision: { phase, note } }) as const;

/**
 * I.2 (D82): a member's own instance of an app it holds `app.use` for
 * (decide.ts `memberPermissions`). The surface names the instance once it is
 * known, so a member never reaches another user's.
 */
const MEMBER_USES_APP = ['app.use:<installationId>'] as const;

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
      memberPermissions: MEMBER_USES_APP,
      ...decide(2, 'Claims the request before Astro and streams it to the app with no check. Needs the login handoff, then per-host enforcement. I.2: a member\'s session only to its own instance, decided again on the slot\'s instance.'),
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
      networkCaller: true,
      memberPermissions: MEMBER_USES_APP,
      note: 'As /api/proxy (D28): the owner, a member to its own instance with app.use (I.2), and a tokenless app container by its network address. Upgrades skip the middleware, so surfaceGate checks them on the chosen instance; the target lookup carries the internal label.',
    },
  },
  {
    id: 'exec-bridge',
    kind: 'websocket',
    source: 'packages/shell/server/exec-bridge.mjs',
    paths: ['/api/instances/{id}/session (upgrade)'],
    attach: 'attachExecBridge',
    rule: {
      allow: ['own-instance', 'owner'],
      target: 'instance',
      guard: 'rule',
      note: 'Phase 5 stream X: jump and exec through the shell (D74). The owner (login, host operator, or a trusted owner agent such as the System Terminal, D29) or the instance itself by its own token; the user is the verified principal\'s (its `u` claim), never a header. Decided at the upgrade in every access mode (surfaceGate `everyMode`: it executes as root in the app container). A sidecar target is the owner\'s only; session.opened/closed are audited.',
    },
  },
  {
    id: 'sse-mux',
    kind: 'websocket',
    source: 'packages/shell/server/sse-mux.mjs',
    paths: ['{label}--{desktop host}/_aura/os/sse-mux'],
    attach: 'attachAppHosts',
    rule: {
      allow: ['owner'],
      target: 'proxy-upstream',
      memberPermissions: MEMBER_USES_APP,
      note: 'The owner, through the app whose App Host session the router verified (surfaceGate at the upgrade). Each stream is then a gateway call checked on its own, and the event streams end when the sign-in is revoked (lib/streamSession.ts).',
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
      note: 'The desktop: the owner\'s login, decided at the handshake (surfaceGate). Apps never reach it (D40, exact Origin). The `cs` client session only selects the lock-screen filter.',
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
      note: 'kv:changed with values from every namespace: only to a socket whose caller this rule allows (the owner), decided at the handshake; others get no kv:changed.',
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
      memberPermissions: MEMBER_USES_APP,
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
      memberPermissions: MEMBER_USES_APP,
      networkCaller: true,
      note: 'The /api/proxy route rule decides (C6: the same rule): the owner, and an app container by its network address (D28), except to an owner agent\'s MCP (the Terminal, aurashelld), which only the owner and the System Terminal reach (H2). Caller-scoped grants and the private Terminal ingress are Phase 5.',
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
    id: 'page-setup',
    kind: 'page',
    source: 'packages/shell/src/pages/setup.astro',
    paths: ['/setup'],
    page: '/setup',
    // Acting on it needs a one-time host code (D8).
    rule: { allow: ['public'], target: 'system' },
  },
  {
    id: 'page-login',
    kind: 'page',
    source: 'packages/shell/src/pages/login.astro',
    paths: ['/login'],
    page: '/login',
    rule: { allow: ['public'], target: 'session' },
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
      ...decide(1, 'The login page needs its bundles. Keep secrets and per-user data out of them.'),
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
      note: 'The owner only: the server.emit wrapper asks surfaceGate before Vite serves source, so enforcement covers `astro dev` too.',
    },
  },
];
