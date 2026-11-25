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
/**
 * The owner's management routes (D50; before Phase 3 `requireAdmin`, then
 * the shared admin session): the owner (the desktop, Settings through D45,
 * the host operator's ticket) or the System Terminal by its own token, which
 * asks the owner's approval for each call. The handler decides which of
 * them acts directly (lib/approvals/admin.ts `ownerAction`). Every other app
 * is refused, in every mode.
 */
const OWNER_MANAGES = { systemApp: 'com.aura.terminal', guard: 'rule' } as const;

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

const STORAGE_ACCESS = why(
  'Only app <id> (and the owner), and only while the app declares storage.read / storage.write. The value is the caller\'s user\'s (D46), from the verified principal.');

// ── group baselines ─────────────────────────────────────────────────────────

const groups: RouteAccessManifest['groups'] = {
  activities:    rule(INSTANCE, 'activity'),
  admin:         rule(OWNER, 'system'),
  approvals:     rule(OWNER, 'session'),
  credentials:   rule(INSTANCE, 'system'),
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
  user:          rule(OWNER, 'system'),
};

// ── reusable refinements ────────────────────────────────────────────────────

/** The owner, or the System Terminal asking for the owner's approval (D29, D31). */
const TERMINAL_ASKS = rule(INSTANCE, 'app', { systemApp: 'com.aura.terminal' });

/** TerminalX's agent watch (D29): the owner, the System Terminal, an app holding the list grant. */
const TERMINAL_AGENTS = rule(APP_PERMISSION, 'app', { permissions: ['terminal.sessions.list'], guard: 'rule' });

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

/** Was `requireAdmin` in the route, then the shared admin session. */
const ownerManages = (note: string) => rule(INSTANCE, 'app', { ...OWNER_MANAGES, ...why(note) });

// ── per-route refinements ───────────────────────────────────────────────────

const routes: RouteAccessManifest['routes'] = {
  // Login and setup (Q27).
  '/api/admin/first-boot': {
    methods: {
      GET: rule(['public'], 'system'),
      POST: rule(OWNER, 'system', decide(1,
        'Starts the base image build. Decide whether setup needs an anonymous retry before the first owner exists; after setup it stays owner-only.')),
    },
    // The build transcript is not setup status.
    variants: [{ id: 'build-log', methods: ['GET'], match: { on: 'query', name: 'log' }, rule: rule(OWNER, 'system') }],
  },
  '/api/admin/access-report': { methods: { GET: ownerManages('The access report names apps and callers.') } },
  '/api/admin/contract-report': { methods: { GET: ownerManages('The app contract report (D48) names apps, their declarations and where they write: an owner view.') } },
  '/api/admin/onboarding': {
    methods: {
      GET: rule(OWNER, 'system', decide(1, 'Reports setupDoneAt. Decide whether the setup page reads it before login or uses first-boot status instead.')),
      POST: ownerManages('Resets onboarding and the first-boot card.'),
    },
  },
  // The owner's management routes in every mode (D50): grants, keys and the
  // audit trail, and changes to what code runs under an app id.
  '/api/admin/grants': {
    methods: on(['GET', 'POST', 'DELETE'], ownerManages('Privileged permission grants: the owner decides; a grant needs the password.')),
  },
  '/api/admin/api-keys': {
    methods: on(['GET', 'POST', 'DELETE'], ownerManages('API keys: the owner decides; creating one needs the password.')),
  },
  '/api/admin/audit': { methods: { GET: ownerManages('The audit trail: an owner view.') } },
  '/api/admin/manifest-edit': {
    methods: { POST: ownerManages('Edits an app\'s permissions and tools: the owner decides.') },
  },
  '/api/admin/notifications/release': {
    methods: { POST: ownerManages('Releases blocking system modals: the owner decides.') },
  },
  '/api/admin/dev/system-decision': {
    methods: { POST: ownerManages('A dev hook that raises a system decision: the owner decides.') },
  },
  '/api/admin/app-origin': {
    variants: [{
      id: 'reassign',
      methods: ['POST'],
      match: { on: 'body', field: 'mode', equals: 'reassign', read: true },
      rule: ownerManages('Gives an app another identity: the owner decides. Assigning a missing one needs nobody.'),
    }],
  },
  '/api/admin/clone-app': {
    variants: [{
      id: 'force',
      methods: ['POST'],
      match: { on: 'body', field: 'force', equals: true, read: true },
      rule: ownerManages('Overwriting an app replaces the code under its id: the owner decides. Decided on `force: true` alone, since the route checks the existing copy after the rule.'),
    }],
  },
  '/api/admin/scaffold': {
    variants: [{
      id: 'force',
      methods: ['POST'],
      match: { on: 'body', field: 'force', equals: true, read: true },
      rule: ownerManages('Overwriting an app replaces the code under its id: the owner decides. Decided on `force: true` alone, as clone-app.'),
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

  // D46: who the caller acts for. Reflects only the caller, like whoami, but
  // on target `system` so the owner reads it through Settings too (D45).
  '/api/user/me': {
    methods: { GET: rule(['own-instance', 'app-permission', 'owner'], 'system', why(
      'Any verified caller: its own user and the profile fields it may read (the registry filters per app). Anonymous callers get 401.')) },
  },
  '/api/user/me/permissions': {
    methods: { GET: rule(['own-instance', 'app-permission', 'owner'], 'system', why(
      'D48 `osClient.permissions`: any verified caller asks which permissions its own app holds; reflects only the caller.')) },
  },
  '/api/user/me/profile': {
    methods: { PATCH: rule(OWNER, 'system', why(
      'The user changes their own profile: the desktop login or Settings (D45). The handler refuses every app and agent.')) },
  },

  // Static candidates for the login page; everything else in `os` stays owner.
  '/api/os/theme.css': staticAsset,
  '/api/os/icons.svg': staticAsset,
  '/api/os/icons/[name].svg': staticAsset,

  // Reached only through the App Host gateway, which names the instance.
  '/api/os/app-runtime.js': { methods: on(['GET'], rule(['own-instance'], 'system')) },

  '/api/os/about': {
    methods: {
      GET: rule(OWNER, 'system', why(
        'Discloses host, git and session details: the owner (the About dialog, Settings through D45). SelfUpdater\'s health probe uses the public /api/auth/status.')),
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
    methods: {
      // D48 `osClient.context.get`: the app's own server, by its instance
      // token, and only the keys its manifest declares (the handler checks).
      GET: rule(['own-instance'], 'system', { credentials: ['instance-token'], ...why(
        'An app instance reads a Context key its manifest declares in context[], with its own instance token (lib/appContract.ts). Never a page, never the owner: the Context API discloses no secret otherwise. Phase 5 swaps the backend for per-app granted Context.') }),
      DELETE: rule(OWNER, 'system', { freshAuth: true, ...decide(5, 'Holds secrets and is never public. Settle with the Q31 migration of /api/os/context.') }),
    },
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
    methods: { POST: rule(OWNER, 'client-session', why(
      'The signed-in owner\'s desktop tab. The login and setup pages need none (AuthLayout has no ClientSession), and the desktop renders only for the signed-in owner (D6), so no tab registers before login.')) },
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

  // Credentials (D56, lib/credentials.ts). Asking needs the declared
  // permission; collecting is the requester's own approval; the value goes
  // only to the consuming app's server by its token, and only with the
  // owner's `credential.read:<NAME>` grant, which the handler checks.
  '/api/credentials/requests': {
    methods: { POST: rule(APP_PERMISSION, 'app', { permissions: ['credentials.request'] }) },
  },
  '/api/credentials/requests/[id]': { methods: { POST: rule(INSTANCE, 'system') } },
  '/api/credentials/[handle]': {
    methods: {
      GET: rule(['own-instance'], 'system', { credentials: ['instance-token'], ...why(
        'The consuming app\'s own server reads a credential it holds a handle to, with its instance token and the owner\'s credential.read:<NAME> grant for its user (lib/credentials.ts). Never a page, never another user\'s handle.') }),
    },
  },
  '/api/admin/credentials': { methods: { GET: ownerManages('The owner\'s personal vault (D56): names, consumers, last use; never a value.') } },
  '/api/admin/credentials/[name]': { methods: { DELETE: ownerManages('Revoking a secret or one app\'s access to it (D56), through the owner\'s approval.') } },

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
  '/api/apps/[id]/instances': {
    methods: { GET: rule(OWNER, 'app') },
    variants: [{
      // D29: TerminalX finds the Terminal instances whose sessions the owner let it list.
      id: 'terminal-instances',
      methods: ['GET'],
      match: { on: 'param', name: 'id', equals: 'com.aura.terminal' },
      rule: rule(APP_PERMISSION, 'app', { permissions: ['terminal.sessions.list'] }),
    }],
  },
  '/api/apps/events': {
    methods: {
      GET: rule(INSTANCE, 'system', why(
        'The owner gets the whole stream; an app instance its own per-caller view (lib/access/gatewayEvents.ts), on the gateway and off it.')),
    },
  },

  // OPEN_TERMINAL `background` and `sessionId` need the embed grants, and no
  // app names a system app or owner UI as the target: the route decides those
  // on the parsed intent (start.ts, server/terminal-embed.mjs,
  // lib/intentTarget.ts).
  '/api/intents/start': {
    methods: {
      POST: rule(INSTANCE, 'system', why(
        'The owner and any verified app instance: apps open each other through intents (TerminalX\'s OPEN_TERMINAL embed, D25; Aura Browser\'s VIEW of an App Host address, lib/appHostIntent.ts). An owner grant for a trusted terminal (D24) is Phase 5.')),
    },
    variants: [{
      // Types a line and presses Enter as the owner (5.16). Matched on any
      // action: the extra is refused however the intent names its target.
      // In every mode (the route refuses it too), so the gate reads the body
      // and the report counts the rule the gate settled, not both.
      id: 'terminal-command',
      methods: ['POST'],
      match: { on: 'body', field: 'extras.command', read: true },
      rule: rule(INSTANCE, 'app', { systemApp: 'com.aura.terminal', guard: 'rule' }),
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
  // Programmatic screen access (5.16): both grants; derived facts only (lib/terminalScreen.ts).
  '/api/terminal/sessions/screen': {
    methods: { GET: rule(APP_PERMISSION, 'app', { permissions: ['terminal.sessions.list', 'terminal.screen.read'] }) },
  },
  // TerminalX's agent watch: the sessions' agent events, which the list already shows.
  // New in Phase 3, so held to their rule in every mode (`guard: 'rule'`).
  '/api/terminal/sessions/events': { methods: { GET: TERMINAL_AGENTS } },
  // The agent hooks in the owner's home: an app installs or removes them only
  // with the owner's approval, which the route asks for and consumes (lib/terminalAgents.ts).
  '/api/terminal/agent-hooks': { methods: on(['GET', 'POST', 'DELETE'], TERMINAL_AGENTS) },
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
      // D46: per-user app storage (and `?shared=1`), enforced by the app's own
      // manifest declaration (Phase 3a's model: declared, not auto-granted, in enforce).
      {
        id: 'app-read',
        methods: ['GET', 'HEAD'],
        match: { on: 'namespace', namespace: 'app' },
        rule: rule(INSTANCE, 'app', { guard: 'app-callers', targetPermissions: ['storage.read'], ...STORAGE_ACCESS }),
      },
      {
        id: 'app-write',
        methods: ['POST', 'PUT', 'DELETE'],
        match: { on: 'namespace', namespace: 'app' },
        rule: rule(INSTANCE, 'app', { guard: 'app-callers', targetPermissions: ['storage.write'], ...STORAGE_ACCESS }),
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
