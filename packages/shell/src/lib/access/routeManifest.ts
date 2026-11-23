import { ROUTE_METHODS } from './types.ts';
import type { AccessLevel, AccessRule, AccessTarget, RouteAccessManifest, RouteMethod } from './types.ts';

/**
 * Who may call each `/api` route (Q27, Q28). Data only: see types.ts.
 *
 * A route's effective rule is its method entry here, else the baseline of its
 * group. `public` is for health, setup, login and their static assets, and
 * nothing else. test/route-access-manifest.test.ts holds that allowlist and
 * fails on any route or method this file doesn't account for.
 *
 * `decision` marks a rule that needs an answer before it can be enforced. The
 * phase is the one that has to give it: 1 identity, 2 App Hosts, 3 enforcement,
 * 5 runtime boundaries.
 */

const rule = (
  allow: readonly AccessLevel[],
  target: AccessTarget,
  extra: Omit<AccessRule, 'allow' | 'target'> = {},
): AccessRule => ({ allow, target, ...extra });

const decide = (phase: number, note: string) => ({ ambiguous: true, decision: { phase, note } }) as const;

const on = (methods: readonly RouteMethod[], r: AccessRule): Partial<Record<RouteMethod, AccessRule>> =>
  Object.fromEntries(methods.map((m) => [m, r]));

const OWNER = ['owner'] as const;
const INSTANCE = ['own-instance', 'owner'] as const;
const APP_PERMISSION = ['app-permission', 'owner'] as const;

// ── shared open questions ───────────────────────────────────────────────────

const SYSTEM_APP_CALLER = decide(3,
  'Apps or the SDK call this from an app context. Use the Phase 1 report to decide whether they act for the owner or need an instance rule.');

const STATIC_CANDIDATE = decide(1,
  'Public only if the login or setup page needs it. <link>, <img> and <use> send no bearer token, so otherwise it needs a session cookie or App Host handoff.');

const SIDECAR_OWNER_PATH = decide(3,
  'Today only the instance token passes this gate; no owner path exists. Decide how `aura` reaches it for the owner without borrowing an instance token.');

const SIDECAR_TOKENLESS_READ = decide(3,
  'Answers without a token today. Decide whether the tokenless read stays for `aura get sidecars` once the CLI has an owner identity.');

const NOTIFICATION_READ = decide(3,
  'Own items need no permission, granted readers need notifications.read, and a shell screen reads a lock-state view through a client session that is not a credential. Map these three callers onto principals.');

const NOTIFICATION_USER_OP = decide(3,
  'A user operation gated by an unlocked client session (not a credential), while senders act on their own items by token. Decide the principal for the desktop path.');

const CUSTOM_INTERFACE_WRITE = decide(3,
  'A caller without a Referer passes checkCustomWrite today, and this permission auto-grants. Enforcement needs a verified caller and the permission added to ENFORCED_PERMISSIONS.');

const DATA_ACCESS = decide(3,
  'A missing Referer counts as `system`, and data:* permissions auto-grant today. Decide whether the owner bypasses provider permissions and move callers to instance tokens.');

const PROXY_ACCESS = decide(2,
  'Owner-only as proposed, but iframes cannot send a bearer token and apps call each other (including MCP) through this path. Replace with the App Host login handoff and caller-scoped grants; GET can cold-start an app.');

// ── group baselines ─────────────────────────────────────────────────────────

const groups: RouteAccessManifest['groups'] = {
  activities:    rule(INSTANCE, 'activity'),
  admin:         rule(OWNER, 'system'),
  apps:          rule(OWNER, 'app'),
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
};

// ── reusable refinements ────────────────────────────────────────────────────

const staticAsset = { methods: on(['GET'], rule(['public', 'owner'], 'system', STATIC_CANDIDATE)) };

const sidecar = (permissions: readonly string[], extra: Omit<AccessRule, 'allow' | 'target'> = {}) =>
  rule(INSTANCE, 'sidecar', { targetPermissions: permissions, ...extra });

const notificationRead = rule(APP_PERMISSION, 'notification', { permissions: ['notifications.read'], ...NOTIFICATION_READ });
const notificationUserOp = rule(APP_PERMISSION, 'notification', NOTIFICATION_USER_OP);

const customInterfaceWrite = rule(APP_PERMISSION, 'interface', {
  permissions: ['system.kv.os.interfaces.write'],
  ...CUSTOM_INTERFACE_WRITE,
});

const dataRead = rule(['app-permission'], 'data-provider', { permissions: ['data:<authority>:<readPermission>'], ...DATA_ACCESS });
const dataWrite = rule(['app-permission'], 'data-provider', { permissions: ['data:<authority>:<writePermission>'], ...DATA_ACCESS });

// ── per-route refinements ───────────────────────────────────────────────────

const routes: RouteAccessManifest['routes'] = {
  // Login and setup (Q27).
  '/api/admin/session': {
    methods: { POST: rule(['public'], 'session') },
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
  '/api/admin/onboarding': {
    methods: {
      GET: rule(OWNER, 'system', decide(1, 'Reports setupDoneAt. Decide whether the setup page reads it before login or uses first-boot status instead.')),
    },
  },

  // Static candidates for the login page; everything else in `os` stays owner.
  '/api/os/theme.css': staticAsset,
  '/api/os/icons.svg': staticAsset,
  '/api/os/icons/[name].svg': staticAsset,
  '/api/os/keyboard.js': {
    methods: on(['GET'], rule(OWNER, 'system', decide(2,
      'Owner for now. Loaded by App Host documents, not by login. Phase 2 makes it public only if a cross-origin <script> cannot carry the login handoff.'))),
  },

  '/api/os/about': {
    methods: {
      GET: rule(OWNER, 'system', decide(1,
        'No health route exists. SelfUpdater probes this route anonymously, and it discloses host, git and session details. Add a minimal public health route and repoint the probe before enforcement.')),
    },
  },
  '/api/os/context': {
    methods: on(['GET', 'POST', 'PUT'], rule(OWNER, 'system', decide(5,
      'Holds secrets and is never public. The Settings app manages it from an app context today; Q31 gives other apps only keys approved per instance.'))),
  },
  '/api/os/context/[key]': {
    methods: { DELETE: rule(OWNER, 'system', decide(5, 'Holds secrets and is never public. Settle with the Q31 migration of /api/os/context.')) },
  },
  '/api/os/volumes': { methods: on(['GET', 'POST'], rule(OWNER, 'system', SYSTEM_APP_CALLER)) },
  '/api/os/volumes/[name]': { methods: { DELETE: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/themes': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/layouts': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/keymap': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/ui/command': {
    methods: { POST: rule(OWNER, 'system', decide(3, 'Drives the browser UI and is never public. Agents call it from the Terminal; settle with the D29 caller table.')) },
  },
  '/api/os/lock': { methods: { POST: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },
  '/api/os/unlock': {
    methods: { POST: rule(OWNER, 'system', decide(3, 'Never public. The lock screen has no PIN today, so unlocking must not count as authentication.')) },
  },
  '/api/os/clients': {
    methods: { POST: rule(OWNER, 'client-session', decide(1, 'A tab registers before it may have logged in. Decide whether the login page needs a client session.')) },
  },
  '/api/os/clients/[sid]/[action]': { methods: { POST: rule(OWNER, 'client-session') } },

  // Instances: the URL names the target, so the check is on that instance.
  '/api/instances/[instanceId]/ports': {
    methods: { POST: rule(INSTANCE, 'instance', { targetPermissions: ['apps.port'] }) },
    variants: [
      {
        id: 'into',
        methods: ['POST'],
        match: { on: 'body', field: 'kind', equals: 'into' },
        rule: rule(INSTANCE, 'instance-pair', {
          targetPermissions: ['apps.port'],
          ...decide(3, 'Only the target app is checked today, so any app with apps.port can pull in another app\'s port. Decide what the SOURCE app must consent to.'),
        }),
      },
      {
        id: 'host',
        methods: ['POST'],
        match: { on: 'body', field: 'kind', equals: 'host' },
        rule: rule(INSTANCE, 'instance', {
          targetPermissions: ['apps.port'],
          ...decide(3, 'bindAddr can be 0.0.0.0, which publishes an app beyond this machine. Decide whether a non-loopback bind needs the owner.'),
        }),
      },
    ],
  },
  '/api/instances/[instanceId]/ports/[portId]': {
    methods: { DELETE: rule(INSTANCE, 'instance', { targetPermissions: ['apps.port'] }) },
  },
  '/api/instances/[instanceId]/mounts': {
    methods: { POST: rule(INSTANCE, 'instance-pair', { targetPermissions: ['apps.mount'] }) },
    variants: [{
      id: 'read-write',
      methods: ['POST'],
      match: { on: 'body', field: 'mode', equals: 'rw' },
      rule: rule(INSTANCE, 'instance-pair', {
        targetPermissions: ['apps.mount'],
        ...decide(3, 'Q30: write access needs approval, and read-only mounts are limited to shared paths. The approval flow lands with enforcement.'),
      }),
    }],
  },
  '/api/instances/[instanceId]/mounts/[mountId]': {
    methods: { DELETE: rule(INSTANCE, 'instance', { targetPermissions: ['apps.mount'] }) },
  },
  '/api/instances/[instanceId]/sidecars': {
    methods: {
      GET: rule(INSTANCE, 'instance', SIDECAR_TOKENLESS_READ),
      POST: sidecar(['sidecars.spawn'], SIDECAR_OWNER_PATH),
    },
    variants: [
      { id: 'managed-view', methods: ['GET'], match: { on: 'query', name: 'view', equals: 'managed' }, rule: sidecar(['sidecars.spawn']) },
      { id: 'with-tools', methods: ['POST'], match: { on: 'body', field: 'tools' }, rule: sidecar(['sidecars.spawn', 'sidecars.tools'], SIDECAR_OWNER_PATH) },
    ],
  },
  '/api/instances/[instanceId]/sidecars/[name]': {
    methods: on(['GET', 'DELETE'], sidecar(['sidecars.spawn'])),
  },
  '/api/instances/[instanceId]/sidecars/[name]/exec': {
    methods: { POST: sidecar(['sidecars.spawn'], SIDECAR_OWNER_PATH) },
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
      GET: rule(INSTANCE, 'sidecar', SIDECAR_TOKENLESS_READ),
      POST: sidecar(['sidecars.tools']),
      DELETE: sidecar(['sidecars.tools']),
    },
  },

  // Apps.
  '/api/apps': {
    methods: {
      GET: rule(OWNER, 'app', decide(3,
        'The WS proxy, App Host router and apps all read this. The first two call over loopback with no identity, so they need an internal credential or a direct lookup before enforcement.')),
    },
  },
  '/api/apps/events': {
    methods: {
      GET: rule(OWNER, 'system', decide(3,
        'A firehose that includes kv:changed values from every namespace. SDK subscribers use it from apps, so they need a filtered per-caller view.')),
    },
  },

  '/api/intents/start': {
    methods: {
      POST: rule(INSTANCE, 'app', decide(5,
        'An intent can start any app, and OPEN_TERMINAL carries a `command` extra. Apply the D29 caller table to which apps may send it.')),
    },
  },

  '/api/scopes': { methods: { GET: rule(OWNER, 'system', SYSTEM_APP_CALLER) } },

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

  // Interfaces: identity is self-asserted today (see interfaces/identify.ts).
  '/api/interfaces': {
    methods: {
      GET: rule(['own-instance'], 'interface', decide(3,
        'Open to everyone today. The Settings panel and `curl` from the Terminal read it too, so decide whether the owner is added.')),
    },
  },
  '/api/interfaces/custom': { methods: { POST: customInterfaceWrite } },
  '/api/interfaces/custom/[name]': { methods: { PUT: customInterfaceWrite, DELETE: customInterfaceWrite } },

  // Catch-alls: `ALL` handlers, so every method is listed.
  '/api/kv/[...path]': {
    methods: on(ROUTE_METHODS, rule([], 'kv-entry')),
    variants: [
      {
        id: 'os-read',
        methods: ['GET', 'HEAD'],
        match: { on: 'namespace', namespace: 'os' },
        rule: rule(INSTANCE, 'kv-entry', decide(3,
          'Every instance could read every os.* key. Check the keys for anything an app should not see before enforcing.')),
      },
      {
        id: 'os-write',
        methods: ['POST', 'PUT', 'DELETE'],
        match: { on: 'namespace', namespace: 'os' },
        rule: rule(APP_PERMISSION, 'kv-entry', {
          permissions: ['system.kv.os.<topic>.write'],
          ...decide(3, 'This permission auto-grants today and a missing Referer counts as `system`. Enforcement needs a verified caller and these keys in ENFORCED_PERMISSIONS.'),
        }),
      },
      {
        id: 'app-entry',
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
        match: { on: 'namespace', namespace: 'app' },
        rule: rule(INSTANCE, 'app'),
      },
    ],
  },
  '/api/data/[authority]/[...path]': {
    methods: {
      ...on(['GET', 'HEAD'], dataRead),
      ...on(['POST', 'PUT', 'PATCH', 'DELETE'], dataWrite),
      ...on(['OPTIONS', 'OTHER'], rule([], 'data-provider', decide(3,
        'The handler forwards these upstream under the write permission. Denied here until a provider is shown to need them.'))),
    },
  },
  '/api/proxy/[id]/[...path]': {
    methods: on(ROUTE_METHODS, rule(OWNER, 'proxy-upstream', PROXY_ACCESS)),
  },
};

export const ROUTE_ACCESS_MANIFEST: RouteAccessManifest = {
  groups,
  routes,
  nonRoutes: {
    '/api/interfaces/identify': 'Helper imported by the interfaces routes. Astro registers it, and with no handler it answers 404.',
  },
};
