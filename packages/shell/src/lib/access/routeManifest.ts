import { ROUTE_METHODS } from './types.ts';
import type { AccessLevel, AccessRule, AccessTarget, RouteAccessManifest, RouteMethod } from './types.ts';

/**
 * Who may call each `/api` route (Q27, Q28). Data only: see types.ts.
 *
 * A route's effective rule is its method entry here, else the baseline of its
 * group; a route with neither is refused in `enforce` (deny by default). The
 * policy is Open (D26): verified callers keep today's workflows, anonymous
 * ones lose them. `public` is for health, setup, login and their static
 * assets, and nothing else. test/route-access-manifest.test.ts holds that
 * allowlist and fails on any route or method this file doesn't account for.
 *
 * `decision` marks a rule that needs an answer before it can be enforced. The
 * phase is the one that has to give it: 1 identity, 2 App Hosts, 5 runtime
 * boundaries. A rule whose question was answered carries the answer as its
 * `note`. `guard` marks the check a route made itself before Phase 3, which
 * the middleware now applies in every access mode (D36).
 */

const rule = (
  allow: readonly AccessLevel[],
  target: AccessTarget,
  extra: Omit<AccessRule, 'allow' | 'target'> = {},
): AccessRule => ({ allow, target, ...extra });

const decide = (phase: number, note: string) => ({ ambiguous: true, decision: { phase, note } }) as const;
const why = (note: string) => ({ note }) as const;

const on = (methods: readonly RouteMethod[], r: AccessRule): Partial<Record<RouteMethod, AccessRule>> =>
  Object.fromEntries(methods.map((m) => [m, r]));

const OWNER = ['owner'] as const;
const INSTANCE = ['own-instance', 'owner'] as const;
const APP_PERMISSION = ['app-permission', 'owner'] as const;
/** `app-permission` without permissions: any verified app instance or API key (Open, D26). */
const VERIFIED = ['app-permission', 'owner'] as const;
/** Before Phase 3 `requireAdmin`: only the shared admin session (`aura admin login`), in every mode. */
const ADMIN_SESSION = { credentials: ['admin-session'], guard: 'rule' } as const;

// ── shared open questions ───────────────────────────────────────────────────

const SYSTEM_APP_CALLER = why(
  'The owner: the desktop, the CLI and agents through a trusted owner agent (D29), and apps only as the owner through a trusted UI (D45). Other apps get no system setting.');

const STATIC_CANDIDATE = decide(1,
  'Public only if the login or setup page needs it. <link>, <img> and <use> send no bearer token, so otherwise it needs a session cookie or App Host handoff.');

const SIDECAR_OWNER_PATH = why(
  'Only the instance itself, by its own token (was sidecarGate, every mode). No owner path in the alpha: the owner reaches sidecars through the app (`aura exec`, `aura jump`).');

const SIDECAR_READ = why(
  'The instance itself and the owner (`aura get sidecars` from the trusted Terminal, D29). Anonymous callers no longer.');

const NOTIFICATION_READ = why(
  'The owner (the desktop login, whose client session keeps its lock view; the owner through Settings, D45), and any verified app or API key: own items, others only with the notifications.read grant the route checks.');

const NOTIFICATION_USER_OP = why(
  'The owner, whose screen must be unlocked (the route checks its client session), and verified senders on their own items. Anonymous callers no longer.');

const CUSTOM_INTERFACE_WRITE = why(
  'The owner, or an app holding system.kv.os.interfaces.write (was checkCustomWrite on the Referer; now the verified app, in every mode). Undeclared stops counting in enforce.');

const DATA_ACCESS = why(
  'The owner reaches any provider (the desktop, the CLI); an app needs the provider entry\'s permission unless it is the provider. Was the Referer check; now the verified app, in every mode. Auto-grants stop counting in enforce.');

const CONTEXT_Q31 = decide(5,
  'Holds secrets and is never public. The Settings app manages it from an app context today; Q31 gives other apps only keys approved per instance.');


const PROXY_ACCESS = why(
  'D28: the owner, and a tokenless call from an app container (Claude Code\'s MCP URLs, the Terminal\'s session calls, the agent hooks), known by its network address. The SDK never sends a token on this path, and a gateway call stays refused. Caller-scoped grants are Phase 5.');

// ── group baselines ─────────────────────────────────────────────────────────

const groups: RouteAccessManifest['groups'] = {
  activities:    rule(INSTANCE, 'activity'),
  admin:         rule(OWNER, 'system'),
  approvals:     rule(OWNER, 'session'),
  apps:          rule(OWNER, 'app'),
  auth:          rule(OWNER, 'session'),
  data:          rule(['app-permission'], 'data-provider'),
  flights:       rule(OWNER, 'system'),
  hosts:         rule(OWNER, 'system'),
  instances:     rule(INSTANCE, 'instance'),
  intents:       rule(INSTANCE, 'app'),
  interfaces:    rule(['own-instance'], 'interface'),
  kv:            rule([], 'kv-entry'),    // deny until refined
  nexus:         rule(OWNER, 'system'),
  notifications: rule(APP_PERMISSION, 'notification', { permissions: ['system.notifications'] }),
  os:            rule(OWNER, 'system'),
  proxy:         rule(OWNER, 'proxy-upstream'),
  scopes:        rule(OWNER, 'system'),
  // The owner's System Terminal, for apps the owner granted (D25, D29).
  terminal:      rule(APP_PERMISSION, 'app', { permissions: ['terminal.embed'] }),
};

// ── reusable refinements ────────────────────────────────────────────────────

/** The owner, or the System Terminal asking for the owner's approval (D29, D31). */
const TERMINAL_ASKS = rule(INSTANCE, 'app', { systemApp: 'com.aura.terminal' });

const staticAsset = { methods: on(['GET'], rule(['public', 'owner'], 'system', STATIC_CANDIDATE)) };

/** Was sidecarGate: the instance's own token, its app's permissions, in every mode. */
const sidecar = (permissions: readonly string[]) =>
  rule(['own-instance'], 'sidecar', {
    targetPermissions: permissions, credentials: ['instance-token'], guard: 'rule', ...SIDECAR_OWNER_PATH,
  });

const notificationRead = rule(VERIFIED, 'notification', NOTIFICATION_READ);
const notificationUserOp = rule(VERIFIED, 'notification', NOTIFICATION_USER_OP);

const customInterfaceWrite = rule(APP_PERMISSION, 'interface', {
  permissions: ['system.kv.os.interfaces.write'],
  guard: 'app-callers',
  ...CUSTOM_INTERFACE_WRITE,
});

const dataRead = rule(APP_PERMISSION, 'data-provider', {
  permissions: ['data:<authority>:<readPermission>'], guard: 'app-callers', ...DATA_ACCESS,
});
const dataWrite = rule(APP_PERMISSION, 'data-provider', {
  permissions: ['data:<authority>:<writePermission>'], guard: 'app-callers', ...DATA_ACCESS,
});

/** Was `requireAdmin` in the route. */
const adminSession = (note: string) => rule(OWNER, 'system', { ...ADMIN_SESSION, ...why(note) });

// ── per-route refinements ───────────────────────────────────────────────────

const routes: RouteAccessManifest['routes'] = {
  // Login and setup (Q27).
  '/api/admin/session': {
    methods: {
      POST: rule(['public'], 'session'),
      GET: adminSession('Reports the admin session it is called with.'),
      DELETE: adminSession('Locks the admin session it is called with.'),
    },
  },
  '/api/admin/first-boot': {
    methods: {
      GET: rule(['public'], 'system'),
      POST: rule(OWNER, 'system', decide(1,
        'Starts the base image build. Decide whether setup needs an anonymous retry before the first owner exists; after setup it stays owner-only.')),
    },
    // The build transcript is not setup status.
    variants: [{ id: 'build-log', methods: ['GET'], match: { on: 'query', name: 'log' }, rule: rule(OWNER, 'system') }],
  },
  '/api/admin/access-report': { methods: { GET: adminSession('The access report names apps and callers.') } },
  '/api/admin/onboarding': {
    methods: {
      GET: rule(OWNER, 'system', decide(1, 'Reports setupDoneAt. Decide whether the setup page reads it before login or uses first-boot status instead.')),
      POST: adminSession('Resets onboarding and the first-boot card.'),
    },
  },
  // The operator credential's routes stay on the admin session in every mode
  // (until the Phase 4 ledger): grants, keys and the audit trail, and changes
  // to what code runs under an app id.
  '/api/admin/grants': {
    methods: on(['GET', 'POST', 'DELETE'], adminSession('Privileged permission grants: operator only.')),
  },
  '/api/admin/api-keys': {
    methods: on(['GET', 'POST', 'DELETE'], adminSession('API keys: operator only.')),
  },
  '/api/admin/audit': { methods: { GET: adminSession('The audit trail: operator only.') } },
  '/api/admin/manifest-edit': {
    methods: { POST: adminSession('Edits an app\'s permissions and tools: operator only.') },
  },
  '/api/admin/notifications/release': {
    methods: { POST: adminSession('Releases blocking system modals: operator only.') },
  },
  '/api/admin/dev/system-decision': {
    methods: { POST: adminSession('A dev hook that raises a system decision: operator only.') },
  },
  '/api/admin/app-origin': {
    variants: [{
      id: 'reassign',
      methods: ['POST'],
      match: { on: 'body', field: 'mode', equals: 'reassign', read: true },
      rule: adminSession('Gives an app another identity: operator only. Assigning a missing one needs no admin.'),
    }],
  },
  '/api/admin/clone-app': {
    variants: [{
      id: 'force',
      methods: ['POST'],
      match: { on: 'body', field: 'force', equals: true, read: true },
      rule: adminSession('Overwriting an app replaces the code under its id: operator only. Decided on `force: true` alone, since the route checks the existing copy after the rule.'),
    }],
  },
  '/api/admin/scaffold': {
    variants: [{
      id: 'force',
      methods: ['POST'],
      match: { on: 'body', field: 'force', equals: true, read: true },
      rule: adminSession('Overwriting an app replaces the code under its id: operator only. Decided on `force: true` alone, as clone-app.'),
    }],
  },
  // D29: the owner's trusted terminal acts for the owner, so `aura enable|disable app` works from it.
  '/api/admin/apps/enabled': {
    methods: on(['GET', 'POST'], rule(OWNER, 'system', why('The owner: the desktop, Settings (D45) and `aura enable|disable app` from the trusted Terminal (D29).'))),
  },

  // Owner login (D6, D37), always on.
  // `setup` also takes the reset path: both need a one-time host code (D8).
  '/api/app-hosts/handoff': { methods: { POST: rule(OWNER, 'session') } },
  '/api/auth/status': { methods: { GET: rule(['public'], 'system') } },
  '/api/auth/setup': { methods: { POST: rule(['public'], 'system') } },
  '/api/auth/login': { methods: { POST: rule(['public'], 'session') } },
  '/api/auth/logout': {
    methods: { POST: rule(OWNER, 'session', why(
      'The signed-in owner. An expired session needs no logout: its cookie is worthless, and the next sign-in replaces it.')) },
  },
  '/api/auth/session': {
    methods: { GET: rule(OWNER, 'session', why(
      'The signed-in owner. A visitor without a session gets 401 in enforce, which says the same as authenticated:false.')) },
  },
  // Settings → Users & Identities. A password is typed only into the shell's
  // own dialog, so those two stay on target `session`, which no app reaches
  // for the owner (gatewayCaller.ts). Settings reads the account and signs out
  // other sessions through the gateway (D45, OWNER_UI_APPS).
  '/api/auth/password-policy': {
    methods: { GET: rule(['public'], 'system'), PUT: rule(OWNER, 'session') },
  },
  '/api/auth/password': { methods: { POST: rule(OWNER, 'session') } },
  '/api/auth/account': { methods: { GET: rule(OWNER, 'system') } },
  '/api/auth/sessions/revoke-others': { methods: { POST: rule(OWNER, 'system') } },
  '/api/auth/whoami': {
    methods: { GET: rule(['own-instance', 'app-permission', 'owner'], 'session', why(
      'Reflects only the caller: any verified one, API keys too. An anonymous caller gets 401 in enforce, which `aura whoami` reports as rejected.')) },
  },

  // Static candidates for the login page; everything else in `os` stays owner.
  '/api/os/theme.css': staticAsset,
  '/api/os/icons.svg': staticAsset,
  '/api/os/icons/[name].svg': staticAsset,

  // Reached only through the App Host gateway, which names the instance.
  '/api/os/app-runtime.js': { methods: on(['GET'], rule(['own-instance'], 'system')) },

  '/api/os/about': {
    methods: {
      GET: rule(OWNER, 'system', decide(1,
        'No health route exists. SelfUpdater probes this route anonymously, and it discloses host, git and session details. Add a minimal public health route and repoint the probe before enforcement.')),
    },
  },
  '/api/os/context': {
    methods: {
      GET: rule(OWNER, 'system', CONTEXT_Q31),
      // Writes need a fresh owner approval (5.10), which the handler consumes.
      ...on(['POST', 'PUT'], rule(OWNER, 'system', { freshAuth: true, ...CONTEXT_Q31 })),
    },
  },
  '/api/os/context/[key]': {
    methods: { DELETE: rule(OWNER, 'system', { freshAuth: true, ...decide(5, 'Holds secrets and is never public. Settle with the Q31 migration of /api/os/context.') }) },
  },
  '/api/os/volumes': { methods: on(['GET', 'POST'], rule(OWNER, 'system', SYSTEM_APP_CALLER)) },
  '/api/os/volumes/[name]': { methods: { DELETE: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  // The non-secret theme catalogue, read by the SDK's listThemes().
  '/api/os/themes': { methods: { GET: rule(INSTANCE, 'system') } },
  '/api/os/layouts': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/keymap': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/ui/command': {
    methods: { POST: rule(OWNER, 'system', why('Drives the browser UI: the owner, and agents through a trusted owner agent (the Terminal, the shell MCP, D29). Other apps none.')) },
  },
  '/api/os/lock': { methods: { POST: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/unlock': {
    methods: { POST: rule(OWNER, 'system', why('The signed-in owner unlocks a screen; unlocking is not authentication, so the login is what counts.')) },
  },
  '/api/os/clients': {
    methods: { POST: rule(OWNER, 'client-session', decide(1, 'A tab registers before it may have logged in. Decide whether the login page needs a client session.')) },
  },
  '/api/os/clients/[sid]/[action]': { methods: { POST: rule(OWNER, 'client-session') } },

  // Owner approvals (5.10). The group baseline is the owner's own desktop
  // (target `session`, which no app reaches for the owner). The handlers do
  // the rest: a requester polls only its own request, only the owner's shell
  // document (or the host operator's code) decides, the requester consumes.
  '/api/approvals': {
    methods: {
      GET: rule(OWNER, 'session'),
      POST: rule(APP_PERMISSION, 'app', { permissions: ['user.confirm'] }),
    },
  },
  '/api/approvals/[id]': { methods: { GET: rule(INSTANCE, 'system') } },
  '/api/approvals/[id]/[decision]': { methods: { POST: rule(INSTANCE, 'session') } },
  '/api/approvals/blocked/[appId]': { methods: { DELETE: rule(OWNER, 'session') } },

  // Instances: the URL names the target, so the check is on that instance.
  // `targetPermissions` here were the routes' own hasPermission checks: every mode.
  '/api/instances/[instanceId]/ports': {
    methods: { POST: rule(INSTANCE, 'instance', { targetPermissions: ['apps.port'], guard: 'target-permissions' }) },
    variants: [
      {
        id: 'into',
        methods: ['POST'],
        match: { on: 'body', field: 'kind', equals: 'into', read: true },
        rule: rule(INSTANCE, 'instance-pair', {
          targetPermissions: ['apps.port'],
          guard: 'target-permissions',
          ...why('The target instance itself or the owner, and the target app holds apps.port. The source app\'s consent is a Zero Trust grant (Phase 5).'),
        }),
      },
      {
        id: 'host',
        methods: ['POST'],
        match: { on: 'body', field: 'kind', equals: 'host', read: true },
        rule: rule(OWNER, 'instance', {
          targetPermissions: ['apps.port'],
          guard: 'target-permissions',
          ...why('Publishing on the host (bindAddr may be 0.0.0.0) is the owner\'s call: `aura port expose` from the trusted Terminal.'),
        }),
      },
    ],
  },
  '/api/instances/[instanceId]/ports/[portId]': {
    methods: { DELETE: rule(INSTANCE, 'instance', { targetPermissions: ['apps.port'], guard: 'target-permissions' }) },
  },
  '/api/instances/[instanceId]/mounts': {
    methods: { POST: rule(INSTANCE, 'instance-pair', { targetPermissions: ['apps.mount'], guard: 'target-permissions' }) },
    variants: [{
      id: 'read-write',
      methods: ['POST'],
      match: { on: 'body', field: 'mode', equals: 'rw', read: true },
      rule: rule(OWNER, 'instance-pair', {
        targetPermissions: ['apps.mount'],
        guard: 'target-permissions',
        ...why('Q30: write access to another app\'s files is the owner\'s call (`aura mount add --wr` from the trusted Terminal); an app asking for it gets an approval once stream B\'s flow covers mounts.'),
      }),
    }],
  },
  '/api/instances/[instanceId]/mounts/[mountId]': {
    methods: { DELETE: rule(INSTANCE, 'instance', { targetPermissions: ['apps.mount'], guard: 'target-permissions' }) },
  },
  '/api/instances/[instanceId]/sidecars': {
    methods: {
      GET: rule(INSTANCE, 'instance', SIDECAR_READ),
      POST: sidecar(['sidecars.spawn']),
    },
    variants: [
      { id: 'managed-view', methods: ['GET'], match: { on: 'query', name: 'view', equals: 'managed' }, rule: sidecar(['sidecars.spawn']) },
      { id: 'with-tools', methods: ['POST'], match: { on: 'body', field: 'tools', read: true }, rule: sidecar(['sidecars.spawn', 'sidecars.tools']) },
    ],
  },
  '/api/instances/[instanceId]/sidecars/[name]': {
    methods: on(['GET', 'DELETE'], sidecar(['sidecars.spawn'])),
  },
  '/api/instances/[instanceId]/sidecars/[name]/exec': {
    methods: { POST: sidecar(['sidecars.spawn']) },
  },
  '/api/instances/[instanceId]/sidecars/[name]/logs': {
    methods: { GET: sidecar(['sidecars.spawn']) },
  },
  '/api/instances/[instanceId]/sidecars/[name]/mounts': {
    methods: {
      GET: sidecar(['sidecars.spawn']),
      POST: sidecar(['sidecars.mounts', 'apps.mount']),
    },
  },
  '/api/instances/[instanceId]/sidecars/[name]/mounts/[mountId]': {
    methods: { DELETE: sidecar(['sidecars.mounts', 'apps.mount']) },
  },
  '/api/instances/[instanceId]/sidecars/[name]/tools': {
    methods: {
      GET: rule(INSTANCE, 'sidecar', SIDECAR_READ),
      POST: sidecar(['sidecars.tools']),
      DELETE: sidecar(['sidecars.tools']),
    },
  },

  // Apps.
  '/api/apps': {
    methods: {
      GET: rule(OWNER, 'app', why(
        'The owner (the CLI through the trusted Terminal). The WS proxy\'s and App Host router\'s loopback lookups carry the internal label (observer.ts INTERNAL_CALLS), which the gate lets through as the shell.')),
    },
  },
  '/api/apps/events': {
    methods: {
      GET: rule(INSTANCE, 'system', why(
        'The owner gets the whole stream; an app instance its own per-caller view (lib/access/gatewayEvents.ts), on the gateway and off it.')),
    },
  },

  '/api/intents/start': {
    methods: {
      POST: rule(INSTANCE, 'system', decide(5,
        'An app may send intents. OPEN_TERMINAL: `command` is held to the Terminal (D29); `background` needs the owner\'s terminal.embed grant and `sessionId` a session the app was granted, checked in the route for every verified app caller (server/terminal-embed.mjs). Still open: an owner grant for a trusted terminal (D24).')),
    },
    variants: [{
      // Types a line and presses Enter as the owner (5.16). Matched on any
      // action: the extra is refused however the intent names its target.
      id: 'terminal-command',
      methods: ['POST'],
      match: { on: 'body', field: 'extras.command', read: true },
      rule: rule(INSTANCE, 'app', { systemApp: 'com.aura.terminal' }),
    }],
  },

  '/api/scopes': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },

  // Each route also checks the one session against its own grant (server/terminal-embed.mjs).
  '/api/terminal/embed': {
    methods: { POST: rule(APP_PERMISSION, 'app', { permissions: ['terminal.embed'] }) },
  },
  // The owner, from the Shell's own dialog (the route checks the exact Origin and owner session).
  '/api/terminal/share': { methods: { POST: rule(OWNER, 'system') } },
  // The System Terminal reports an ended session; the route checks it is the session's own instance.
  '/api/terminal/sessions/ended': {
    methods: { POST: rule(INSTANCE, 'app', { systemApp: 'com.aura.terminal' }) },
  },
  '/api/terminal/sessions': {
    methods: {
      GET: rule(APP_PERMISSION, 'app', { permissions: ['terminal.sessions.list'] }),
      DELETE: rule(APP_PERMISSION, 'app', { permissions: ['terminal.embed'] }),
    },
  },

  // Installing code (D31): the owner (through Nexus), or a Terminal agent or
  // the CLI in the System Terminal, which asks and waits. The handler installs
  // only with the owner's approval of the exact artifact, scope and
  // permissions, consumed once (lib/approvals/nexus.ts).
  '/api/nexus/install': { methods: { POST: TERMINAL_ASKS } },
  '/api/nexus/update/[id]': { methods: { POST: TERMINAL_ASKS } },

  '/api/nexus/assets/[source]/[appId]/[digest]': {
    methods: {
      GET: rule(OWNER, 'system', decide(2, 'Loaded by <img>, which sends no bearer token. Needs a cookie or App Host handoff for the owner.')),
    },
  },

  // Notifications: what a caller sees depends on who it is (see the routes).
  '/api/notifications': {
    methods: {
      GET: notificationRead,
      POST: rule(APP_PERMISSION, 'notification', { permissions: ['system.notifications'] }),
      DELETE: notificationUserOp,
    },
  },
  '/api/notifications/[id]': {
    methods: { GET: notificationRead, PATCH: notificationUserOp, DELETE: notificationUserOp },
  },
  '/api/notifications/[id]/[action]': { methods: { POST: notificationUserOp } },
  '/api/notifications/history': { methods: { DELETE: notificationUserOp } },
  '/api/notifications/stream': { methods: { GET: notificationRead } },

  // Interfaces: identity is self-asserted today (see lib/access/identify.ts).
  '/api/interfaces': {
    methods: {
      GET: rule(VERIFIED, 'interface', {
        networkCaller: true,
        ...why('The registry lists what apps declare: the owner, any verified app, and a tokenless `curl` from an app container (D28, the documented Terminal tour). Anonymous no longer.'),
      }),
      POST: rule(['own-instance'], 'interface', { guard: 'rule', ...why('Registers for the calling instance itself, verified (was a self-asserted hint, every mode).') }),
    },
  },
  '/api/interfaces/[name]': {
    methods: { DELETE: rule(['own-instance'], 'interface', { guard: 'rule', ...why('Unregisters the calling instance\'s own entry, verified (was a self-asserted hint, every mode).') }) },
  },
  '/api/interfaces/custom': { methods: { POST: customInterfaceWrite } },
  '/api/interfaces/custom/[name]': { methods: { PUT: customInterfaceWrite, DELETE: customInterfaceWrite } },

  // Catch-alls: `ALL` handlers, so every method is listed.
  '/api/kv/[...path]': {
    // The route's own checks applied to app callers (an app named by its
    // Referer, which no longer counts): `guard: 'app-callers'`, every mode.
    methods: on(ROUTE_METHODS, rule([], 'kv-entry', { guard: 'app-callers' })),
    variants: [
      {
        id: 'os-read',
        methods: ['GET', 'HEAD'],
        match: { on: 'namespace', namespace: 'os' },
        rule: rule(INSTANCE, 'kv-entry', why(
          'The owner and any app instance (theme, keymap, workspaces). Secrets live under /api/os/context, never here; the os event view is a key allowlist (gatewayEvents.ts).')),
      },
      {
        id: 'os-write',
        methods: ['POST', 'PUT', 'DELETE'],
        match: { on: 'namespace', namespace: 'os' },
        rule: rule(APP_PERMISSION, 'kv-entry', {
          permissions: ['system.kv.os.<topic>.write'],
          guard: 'app-callers',
          ...why('The owner (also through Settings, D45, and the trusted owner agents, D29), or an app holding system.kv.os.<topic>.write. A caller without a credential is no longer `system` in enforce.'),
        }),
      },
      {
        id: 'app-entry',
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        match: { on: 'namespace', namespace: 'app' },
        rule: rule(INSTANCE, 'app', { guard: 'app-callers' }),
      },
    ],
  },
  '/api/data/[authority]/[...path]': {
    methods: {
      ...on(['GET', 'HEAD'], dataRead),
      ...on(['POST', 'PUT', 'PATCH', 'DELETE'], dataWrite),
      ...on(['OPTIONS', 'OTHER'], rule([], 'data-provider', why(
        'Denied: no provider needs them (none in the access reports), and the handler would forward them under the write permission.'))),
    },
  },
  '/api/proxy/[id]/[...path]': {
    methods: on(ROUTE_METHODS, rule(OWNER, 'proxy-upstream', { networkCaller: true, ...PROXY_ACCESS })),
  },
};

export const ROUTE_ACCESS_MANIFEST: RouteAccessManifest = {
  groups,
  routes,
  nonRoutes: {},
};
