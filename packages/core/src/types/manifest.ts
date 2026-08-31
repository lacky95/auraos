import { z } from 'zod';

/**
 * Permission strings. Accepts built-in well-known values (storage.read, etc.) AND
 * dynamic content-provider permissions in the form `data:<authority>:<perm-name>`.
 * Validation is permissive (just a string) — semantic checks live in PermissionManager.
 */
export const BUILTIN_PERMISSIONS = [
  'storage.read',
  'storage.write',
  'network.internet',
  'network.local',
  'system.notifications',
  'system.clipboard',
  'system.overlay',
  'system.theme.broadcast',
  'ipc.broadcast',
  /**
   * Mount another app's source (and optionally its /data) into this app's
   * sandbox via `POST /api/instances/:id/mounts`. ENFORCED for real — see
   * `ENFORCED` in PermissionManager — an app without it gets a 403, it is NOT
   * auto-granted like the other MVP permissions.
   */
  'apps.mount',
] as const;

export const PermissionSchema = z.string();
export type Permission = z.infer<typeof PermissionSchema>;

const DataProviderEntrySchema = z.object({
  /** Path served by the app's Astro server, e.g. "/api/data/settings". Must start with /api/data/ . */
  path: z.string().regex(/^\/api\/data(\/|$)/, { message: 'Provider path must start with /api/data/' }),
  /** Required permission for GET/HEAD requests. Omit for public read. */
  readPermission: z.string().optional(),
  /** Required permission for PUT/POST/PATCH/DELETE requests. Omit for public write. */
  writePermission: z.string().optional(),
});

export const DataProviderSchema = z.object({
  /** Namespace under which this app's data is reachable via /api/data/<authority>/... — usually the appId. */
  authority: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/),
  providers: z.array(DataProviderEntrySchema).default([]),
});

export type DataProviderEntry = z.infer<typeof DataProviderEntrySchema>;
export type DataProvider      = z.infer<typeof DataProviderSchema>;

/**
 * Interface Registry — the transports the OS can currently describe.
 *
 * `stream` (Valkey streams) is deliberately absent: every kind listed here has
 * a transport that already exists, so declaring one is never a promise the OS
 * can't keep. Adding a kind later is an additive change to this enum.
 */
export const INTERFACE_KINDS = ['http', 'rest', 'mcp', 'ws', 'event', 'kv'] as const;
export const InterfaceKindSchema = z.enum(INTERFACE_KINDS);

/** Interface names are app-local; the globally unique ref is `<appId>/<name>`. */
const INTERFACE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Kinds whose `address` is a path on the providing app's own server. */
const INTERFACE_PATH_KINDS = new Set<string>(['http', 'rest', 'mcp', 'ws']);

export const ProvidedInterfaceSchema = z.object({
  /** App-local, kebab-case. Unique within the app (enforced on the manifest). */
  name: z.string().regex(INTERFACE_NAME_RE, {
    message: 'Interface name must be kebab-case: e.g. transcribe, mcp-tools',
  }),
  kind: InterfaceKindSchema,
  /**
   * Where it lives. Semantics are per-kind, and the OS NEVER rewrites this —
   * it only prefixes path kinds with the instance's proxy base when handing
   * out a live address:
   *   http|rest|mcp|ws → path on the app's own server, must start with '/'
   *   event            → OsEventBus topic (or glob), e.g. `whisper:transcript.*`
   *   kv               → KV namespace/key prefix, e.g. `app/com.aura.whisper/jobs`
   */
  address: z.string().min(1),
  /** Free-form contract version. Consumers may pin it; the OS never interprets it. */
  version: z.string().default('1'),
  description: z.string().optional(),
  /** Pointer to a schema doc (app-relative path or URL). Descriptive only. */
  schema: z.string().optional(),
  /**
   * Permission a consumer will be REQUIRED to hold once grants land. Advisory
   * today: surfaced in discovery and the Settings panel, never enforced.
   */
  permission: z.string().optional(),
}).refine(
  (i) => (INTERFACE_PATH_KINDS.has(i.kind) ? i.address.startsWith('/') : !i.address.startsWith('/')),
  {
    message: "http/rest/mcp/ws addresses must start with '/' (a path on the app's server); event/kv addresses must not",
    path: ['address'],
  },
);

const ConsumedInterfaceSchema = z.object({
  /** Name of the interface this app wants, matched against providers' `name`. */
  name: z.string().regex(INTERFACE_NAME_RE),
  kind: InterfaceKindSchema,
  /** Pin to one provider app. Omit to accept any app providing this kind + name. */
  appId: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/).optional(),
  /** Accepted contract version, exact compare. Omit to accept any — no ranges in v1. */
  version: z.string().optional(),
  /** false ⇒ the app degrades gracefully without it. Drives the panel's danger styling. */
  required: z.boolean().default(true),
  description: z.string().optional(),
});

export type InterfaceKind     = z.infer<typeof InterfaceKindSchema>;
export type ProvidedInterface = z.infer<typeof ProvidedInterfaceSchema>;
export type ConsumedInterface = z.infer<typeof ConsumedInterfaceSchema>;

export const AppManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, {
    message: 'App ID must be reverse-domain notation: com.example.app',
  }),
  /**
   * Component archetype — direct counterpart of Android's component model:
   *   'activity' (default) → user-facing app. Spawn lazily on launch, lifecycle
   *      includes onActivityCreate/onActivityDestroy, attaches to the UI shell.
   *   'service'            → headless backend. Spawn at OS init (and respawn on
   *      crash via the reconciler). Lifecycle truncates to onCreate/onStart/
   *      onResume — no activities, no shell slot, no "+ activity" affordance.
   *      activityMode MUST be 'none' (Zod refine below).
   */
  componentType: z.enum(['activity', 'service']).default('activity'),
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(256).optional(),
  /**
   * Short letter glyph (1-3 uppercase characters) used by launcher, dock,
   * and Process Manager when no real icon exists. The shell scales the
   * font-size based on length so 1-char ("C"), 2-char ("CT"), and 3-char
   * ("SET") glyphs all fit the same 48×48 tile.
   * Falls back to `name.charAt(0).toUpperCase()` when omitted.
   */
  icon: z.string().min(1).max(3).optional(),
  entrypoint: z.string().default('entrypoint.sh'),
  serverPort: z.number().int().min(1024).max(65535).optional(),
  /**
   * Which runtime the OS spawns this app under.
   *   'astro' (default) → the historical path. The OS synthesises an
   *                       `astro dev` entrypoint if the app doesn't ship one,
   *                       and `auraAppIntegration()` adds identity headers
   *                       and the `/api/lifecycle/health` route. The shell
   *                       proxy injects `<base href>`, rewrites href/src,
   *                       and stamps OS meta tags + relays.
   *   'raw'             → no Astro wrapper. The runner spawns
   *                       `manifest.entrypoint` directly; the app is
   *                       responsible for binding to `$APP_PORT` (or
   *                       `serverPort` when set) and serving the lifecycle
   *                       endpoints. The shell proxy switches its inject
   *                       defaults to pass-through (overridable per app via
   *                       the `proxy` block below).
   */
  runtime: z.enum(['astro', 'raw']).default('astro'),
  /**
   * Per-app overrides for the shell proxy's HTML/JS rewriting and injection
   * behaviour. Defaults are resolved at proxy-read time via
   * `resolveProxyConfig(manifest)` and vary by `runtime` (Astro apps default
   * to the today-behaviour; raw apps default to a pure pass-through). Any
   * field set here wins over the default.
   *
   * - `rewriteHtml`:
   *     'astro'    → rewrite href/src/action/etc., inject <base href>. Default for runtime:'astro'.
   *     'absolute' → rewrite attributes but skip the <base href>. For SPAs that emit basePath-prefixed
   *                  absolute URLs and don't want a <base> tag fighting their hydration.
   *     'none'     → no HTML rewriting, no <base href>. Default for runtime:'raw'.
   * - `preservePrefix`: when true, the proxy forwards `/api/proxy/<id>/<path>` to upstream as
   *     `/api/proxy/<id>/<path>` instead of stripping its prefix. Needed by Next.js apps with
   *     basePath so the upstream sees the URL it expects without 308-redirect round-trips.
   * - `injectMeta`, `injectConsoleRelay`, `injectKeyForwarder`, `injectIdentityScript`: each toggles
   *     the named injection in the proxy's HTML response pass. Defaults on; opt out per app.
   */
  proxy: z.object({
    rewriteHtml:          z.enum(['astro', 'absolute', 'none']).optional(),
    preservePrefix:       z.boolean().optional(),
    injectMeta:           z.boolean().optional(),
    injectConsoleRelay:   z.boolean().optional(),
    injectKeyForwarder:   z.boolean().optional(),
    injectIdentityScript: z.boolean().optional(),
    /**
     * Service apps (componentType='service') are normally restricted to
     * /api/* and /_aura_* — the proxy 403s every other path with
     * "service-has-no-ui" so a stray iframe src= can't accidentally render
     * a headless backend as a window. Set to true when a service legitimately
     * serves a non-/api/ protocol surface that external tools speak directly
     * — e.g. com.aura.registry serves /v2/ for OCI Distribution clients
     * (`oras`, `docker push`, Aura's own Nexus). The service still has no UI;
     * this just opens the protocol path through the proxy.
     */
    exposeAllPaths:       z.boolean().optional(),
  }).optional(),
  permissions: z.array(PermissionSchema).default([]),
  tools: z.array(z.string()).default([]),
  rootfsMode: z.enum(['shared', 'isolated']).default('shared'),
  category: z.enum(['system', 'productivity', 'media', 'communication', 'utility', 'game', 'developer']).default('utility'),
  /** Instance policy: 'single' = at most one running BACKEND process, 'multi' = multiple concurrent processes allowed. */
  instanceMode: z.enum(['single', 'multi']).default('single'),
  /** Optional hard cap on concurrent instances when instanceMode='multi'. 0 = unlimited. */
  maxInstances: z.number().int().min(0).default(0),
  /**
   * Number of pre-spawned, idle instances the AppManager keeps in a "warm pool".
   * When the user clicks Launch, an already-resumed instance from the pool is
   * handed over (sub-100ms) instead of paying the full astro-dev cold-start
   * (~3s+ per app). The AppManager spawns a refill in the background.
   * 0 = no pool (default, behaviour unchanged). Capped at 8 to prevent
   * runaway RAM use from a misconfigured manifest.
   */
  warmPool: z.number().int().min(0).max(8).default(0),
  /**
   * Activity policy: 'none' = each window has its own backend instance,
   * 'multi' = one backend instance can host multiple concurrent activities (UI screens, tabs).
   * Analogous to Android's per-app Activity stack.
   */
  activityMode: z.enum(['none', 'multi']).default('none'),
  /** Cap on concurrent activities per instance. 0 = unlimited. */
  maxActivitiesPerInstance: z.number().int().min(0).default(0),
  /**
   * When true, the AppManager starts this app at OS init — before any user
   * launch — so its content providers / services are available immediately.
   * Default false: app spawns lazily on first launch.
   *
   * Differs from componentType='service' in that an autoStart app can still
   * have a UI activity (e.g. Settings). componentType='service' is for
   * headless backends; autoStart is for "needs to be ready before someone
   * clicks anything".
   */
  autoStart: z.boolean().default(false),
  /**
   * Mark an app as critical OS infrastructure (e.g. the local OCI registry).
   * Critical apps cannot be disabled via Settings / `aura app disable` —
   * AppManager.setEnabled(id, false) throws — because disabling them would
   * break dependent functionality (Nexus install/publish, in the registry
   * case). They're still subject to normal lifecycle / stop / restart;
   * `critical: true` only guards the explicit user-facing disable path.
   *
   * Default false. Apps the user installs themselves should never set this;
   * it's reserved for OS-supplied apps that other parts of the system
   * implicitly depend on.
   */
  critical: z.boolean().default(false),
  /**
   * Sandbox this app inside PRoot. Default true. Set false ONLY for apps
   * that use native modules whose syscalls PRoot's ptrace-based emulation
   * can't translate — Tailwind 4 (Oxide), node-pty in some configurations,
   * etc. — where the app errors out with EFAULT on file opens.
   *
   * Cost of opting out: app sees the container's full filesystem (no
   * `--bind` jail), and the AURA_LAYER_TAG prompt drops to `[ctnr]`.
   * Process-group kill, port allocation, identity verification all still
   * work — they're independent of the sandbox.
   */
  useProot: z.boolean().default(true),
  /**
   * Which sandbox backend hosts this app's instances:
   *   'proot'     → ptrace sandbox inside the AuraOS container (default).
   *                 Cheap to spawn but weak isolation; useProot still gates
   *                 whether the PRoot wrapping is applied.
   *   'container' → real kernel-namespace container (rootless docker)
   *                 spawned as a sibling of the AuraOS container, sharing
   *                 the host filesystem via SLICED bind mounts (only the
   *                 app's own apps/<id> + workspace shared dirs are visible).
   *                 Real PID/net/mount namespaces — `cd /workspace/apps`
   *                 inside the sandbox shows ONLY the app's own folder.
   *
   * The two backends share the same manifest semantics (tools[], lifecycle,
   * activities, content providers, two-dir cap allowlist) — only the spawn
   * primitive differs. Apps migrate between them with no source change.
   */
  sandbox: z.enum(['proot', 'container']).default('proot'),
  /**
   * What happens when the user clicks the app icon while at least one instance is already running.
   * Only meaningful for apps where BOTH instanceMode='multi' AND activityMode='multi'.
   * 'new-instance' → always spawn a new backend process (activities opened explicitly via "+ NEW WINDOW")
   * 'new-activity' → attach a new activity to the first existing instance
   */
  defaultLaunch: z.enum(['new-instance', 'new-activity']).default('new-instance'),
  /**
   * Service-Charakter: wenn true, läuft die Backend-Instance weiter wenn die letzte Activity geschlossen wird.
   * Beispiel: Music Player im Hintergrund. Nutzer muss explizit APP CLOSE drücken um Backend zu beenden.
   */
  backgroundService: z.boolean().default(false),
  viewConfig: z.object({
    defaultWidth: z.number().int().min(320).default(800),
    defaultHeight: z.number().int().min(240).default(600),
    resizable: z.boolean().default(true),
  }).default({}),
  lifecycleBasePath: z.string().default('/api/lifecycle'),
  /**
   * The app's preferred layout-strategy id. Free-form string so third-party
   * layout packs declared via `intentFilters`-style discovery (Phase 6 of
   * the workspace plan) can be picked. `'any'` means "no preference — the
   * workspace's current strategy stands". The shell validates the value
   * against `layoutRegistry.has(id)` at consumption time and falls back to
   * the workspace default on miss.
   *
   * The previous enum (`'fullscreen' | 'tiling' | 'windowed' | 'any'`) is
   * still accepted byte-identical — those ids are seeded in the default
   * registry.
   */
  preferredLayout: z.string().default('any'),
  /**
   * Per-app keymap action declarations. Each entry surfaces a remappable
   * shortcut in the OS Settings → Keyboard panel and becomes a registry
   * action with id `app.<manifest.id>.<entry.id>`. Apps register handlers
   * at runtime via `osClient.keymap.on(entry.id, handler)`.
   *
   * Apps cannot self-claim OS-scope ids — Zod pins `scope` to `'app'`. The
   * `defaultCombo` is canonicalised by the KeymapRegistry on load.
   */
  keymapActions: z.array(z.object({
    id:           z.string().regex(/^[a-z][a-z0-9.-]*$/, { message: "keymapActions[].id must be kebab/dot-case lowercase" }),
    label:        z.string().min(1).max(64),
    description:  z.string().optional(),
    category:     z.string().default('App'),
    defaultCombo: z.string().nullable().default(null),
    scope:        z.enum(['app']).default('app'),
  })).default([]),
  theme: z.object({
    mode: z.enum(['os-components', 'custom']).default('os-components'),
    accentColor: z.string().optional(),
  }).default({}),
  /**
   * How the app participates in the OS theming pipeline (Theme Manager v2).
   *   'inherit'  → default. Proxy auto-injects `<link rel="stylesheet" href="/api/os/theme.css">`.
   *                App uses `var(--aura-color-*)`; light/dark + theme flow through automatically.
   *   'themed'   → app supplies its own palettes but adapts to the OS's (framework, themeId, mode).
   *                Proxy injects framework + theme-id + color-mode `<meta>` tags; no theme.css link.
   *                App reads the meta tags and picks a matching stylesheet; falls back to its default.
   *   'override' → app owns its palette entirely. Proxy injects only color-mode meta as a hint.
   *                Use sparingly — photo editors, accessibility tools, brand-locked experiences.
   *                ProcessManager surfaces a chip so users see why this app looks different.
   */
  themeStrategy: z.enum(['inherit', 'themed', 'override']).default('inherit'),
  /**
   * Optional content-provider declaration. Apps that expose structured data
   * to OTHER apps register paths here. The OS routes `/api/data/<authority>/...`
   * requests through this declaration and enforces permissions.
   */
  dataProvider: DataProviderSchema.optional(),
  /**
   * Android `<intent-filter>` equivalent. Each entry declares ONE filter that
   * makes this app a candidate handler for matching intents. The OS picks
   * the highest-scored candidate (mime specificity beats wildcard; priority
   * breaks ties) and routes via `startIntent`. Apps without filters can
   * still be launched directly via `start()` + `openActivity()`.
   */
  intentFilters: z.array(z.object({
    /** Canonical action, namespaced. e.g. `aura.intent.action.VIEW`. */
    action:     z.string().min(1),
    /** Optional category labels (intersected w/ intent's). e.g. `aura.intent.category.DEFAULT`. */
    category:   z.array(z.string()).default([]),
    /** Acceptable MIME types. `image/*` and `*\/*` count as wildcards in scoring. */
    dataMime:   z.array(z.string()).default([]),
    /** Acceptable URI schemes, e.g. `aura`, `http`, `https`. */
    dataScheme: z.array(z.string()).default([]),
    /** Manual tie-breaker — higher wins. Default 0. */
    priority:   z.number().int().default(0),
  })).default([]),

  /**
   * Interfaces this app OFFERS to others — the Interface Registry's catalog
   * layer. Declared here means "this app CAN provide it": the entry survives
   * the app being stopped (the manifest on disk is the source of truth), which
   * is what lets a consumer discover a provider that isn't running yet.
   * Materialised as a live, dialable address whenever an instance is up.
   */
  provides: z.array(ProvidedInterfaceSchema).default([]),
  /**
   * Interfaces this app NEEDS. Purely declarative — the OS never injects
   * anything. It drives the resolution report (satisfied / unmet), which is
   * how you find out WHY a composition doesn't work.
   */
  consumes: z.array(ConsumedInterfaceSchema).default([]),
  /**
   * Optional Nexus publish metadata. Drives `aura nexus publish` — none of
   * these are runtime fields, they just steer the publisher when an author
   * runs the command without flags.
   *   • `repo`     — `github.com/<user>/<repo>` for git publish.
   *   • `registry` — `ghcr.io/<user>/<repo>` for OCI publish.
   *   • `channels` — channel labels the publisher will tag against (in
   *                  addition to `<version>` and `latest`).
   *   • `ignore`  — extra paths excluded from the publish tarball/work-tree.
   *                  Defaults strip the usual build artefacts.
   */
  publish: z.object({
    repo:     z.string().optional(),
    registry: z.string().optional(),
    channels: z.array(z.string()).default(['stable']),
    ignore:   z.array(z.string()).default([
      'node_modules', '.next', 'dist', '.astro', '.turbo', '.cache',
    ]),
  }).optional(),
  /**
   * Optional storefront metadata. Surfaces in the Nexus app store's browse +
   * detail views. On OCI publish these fields are embedded into the artifact's
   * manifest annotations (`app.aura.*` + OCI standard keys) so the store can
   * read them back from `oras manifest fetch` without pulling the bundle.
   * None are runtime fields — the OS ignores them at spawn time.
   *   • `publisher`       — author/vendor label ("Aura Labs").
   *   • `homepage`        — project/marketing URL.
   *   • `license`         — SPDX id or short label ("MIT", "Proprietary").
   *   • `tags`            — free-form search keywords.
   *   • `longDescription` — multi-paragraph body for the detail page. Plain text.
   *   • `screenshots`     — ABSOLUTE https URLs only (v1 does not host images;
   *                          point at git-raw URLs or a CDN).
   */
  store: z.object({
    publisher:       z.string().max(64).optional(),
    homepage:        z.string().url().optional(),
    license:         z.string().max(32).optional(),
    tags:            z.array(z.string().max(24)).max(16).default([]),
    longDescription: z.string().max(4096).optional(),
    screenshots:     z.array(z.string().url()).max(8).default([]),
  }).optional(),
  /**
   * Cross-app dependencies. Declared by author, enforced at install time
   * (the Nexus installer warns / refuses if a required dep is missing).
   * v1: the installer warns + lists missing deps; v2 auto-installs them
   * recursively. `version` is a semver range parsed by the resolver.
   */
  dependencies: z.array(z.object({
    id:      z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/),
    version: z.string(),
  })).default([]),
  /**
   * Sibling RUNTIME services this app brings up as its own environment —
   * a declarative form of the "spawn a foreign Docker image as a sibling
   * container and proxy it" pattern (com.aura.whisper, com.aura.hermes).
   *
   * Each entry is one Docker image the app runs alongside itself on the
   * shared `aura-net` network. The @aura/app-sdk `createSidecars(...)` helper
   * consumes this array to ensure/teardown the containers and reverse-proxy
   * one of them as the app's UI — so a bring-your-own-runtime app no longer
   * hand-rolls `docker run`, naming, DNS, volumes, health, and teardown.
   *
   * Requires `sandbox: 'container'` and `tools` including `"docker"` (the
   * OS only bind-mounts the host docker socket for those apps). Sibling
   * containers are named `aura-<instanceId>--<service.name>` and labelled
   * `aura.parent=<instanceId>` so the OS can reap them (see AppManager).
   */
  services: z.array(z.object({
    /** Service id; becomes the container suffix `aura-<instanceId>--<name>`. */
    name:  z.string().regex(/^[a-z][a-z0-9-]*$/, { message: 'service.name must be kebab-case lowercase' }),
    /** Docker image reference to run (e.g. `nousresearch/hermes-agent:latest`). */
    image: z.string().min(1),
    /** Command/args appended after the image (overrides/sets the image CMD). */
    command: z.array(z.string()).default([]),
    /** Pre-pull the image at install time (Nexus) instead of first boot. */
    prePull: z.boolean().default(false),
    /** Port inside the service to reverse-proxy / health-check. */
    port: z.number().int().min(1).max(65535).optional(),
    /** When true, this service's `port` is what the app window renders. */
    proxyDashboard: z.boolean().default(false),
    /** Extra env passed to the service container (`-e KEY=VALUE`). */
    env: z.record(z.string(), z.string()).default({}),
    /** Named volumes mounted into the service; volume = `aura-<appId>-<name>`. */
    volumes: z.array(z.object({
      name:   z.string().regex(/^[a-z][a-z0-9-]*$/),
      target: z.string().min(1),
    })).default([]),
    /** DNS servers for the service container (app containers get none by default). */
    dns: z.array(z.string()).default([]),
    /** Docker restart policy for the service. */
    restart: z.enum(['no', 'on-failure', 'always', 'unless-stopped']).default('unless-stopped'),
    /** Optional readiness probe used to gate `proxyDashboard` traffic. */
    readiness: z.object({
      path:      z.string().default('/'),
      timeoutMs: z.number().int().min(1000).default(600_000),
    }).optional(),
  })).default([]),
}).refine(
  (m) => m.componentType !== 'service' || m.activityMode === 'none',
  { message: "componentType: 'service' requires activityMode: 'none' — services cannot host activities", path: ['componentType'] },
).refine(
  // The registry's unique ref is `<appId>/<name>`, so a duplicate name inside
  // one app would make resolution ambiguous with no way to express which was
  // meant. Caught here rather than at registration, where it would be silent.
  (m) => new Set(m.provides.map((p) => p.name)).size === m.provides.length,
  { message: 'provides[].name must be unique within an app', path: ['provides'] },
);

export type AppManifest = z.infer<typeof AppManifestSchema>;

/**
 * Resolved proxy configuration for a single app. All fields are concrete —
 * no `undefined` — because `resolveProxyConfig` fills defaults that vary by
 * `manifest.runtime`. The shell proxy reads from this struct rather than
 * the raw manifest so the conditional rewriting logic stays uniform across
 * Astro and raw apps.
 */
export interface ProxyConfig {
  rewriteHtml:          'astro' | 'absolute' | 'none';
  preservePrefix:       boolean;
  injectMeta:           boolean;
  injectConsoleRelay:   boolean;
  injectKeyForwarder:   boolean;
  injectIdentityScript: boolean;
  exposeAllPaths:       boolean;
}

/**
 * Pick the proxy behaviour for an app, defaulting based on `runtime`:
 *   - astro apps keep today's full inject + HTML-rewriting profile.
 *   - raw apps get a near pass-through default (no `<base>`, no attribute
 *     rewriting). Meta / relay / key forwarder still inject so raw apps
 *     can participate in the console + keymap pipeline if they want — opt
 *     out per app by setting the flag to false.
 *
 * Any field set on `manifest.proxy` wins over the default.
 */
export function resolveProxyConfig(manifest: AppManifest): ProxyConfig {
  const isRaw = manifest.runtime === 'raw';
  const p = manifest.proxy ?? {};
  return {
    rewriteHtml:          p.rewriteHtml          ?? (isRaw ? 'none' : 'astro'),
    preservePrefix:       p.preservePrefix       ?? false,
    injectMeta:           p.injectMeta           ?? true,
    injectConsoleRelay:   p.injectConsoleRelay   ?? true,
    injectKeyForwarder:   p.injectKeyForwarder   ?? true,
    injectIdentityScript: p.injectIdentityScript ?? true,
    exposeAllPaths:       p.exposeAllPaths       ?? false,
  };
}

/**
 * Build the upstream path the AppManager hits for a given lifecycle hook.
 *
 * For an Astro app (or any raw app with `proxy.preservePrefix: false`) this is
 * just `/api/lifecycle/<hook>`. For raw apps whose framework uses a `basePath`
 * matching the proxy prefix (Next.js, Remix, …), the framework only mounts
 * routes under that prefix — a bare `/api/lifecycle/health` request 404s.
 * We prepend the proxy prefix so the URL the runner builds is one the app's
 * router actually serves.
 *
 * The `host:port` portion is the caller's concern; this helper only computes
 * the path component so the same URL works whether the runner is calling
 * localhost (PRoot) or a docker hostname (Container).
 */
export function lifecyclePath(manifest: AppManifest, instanceId: string, hook: string): string {
  const prefix = manifest.proxy?.preservePrefix
    ? `/api/proxy/${instanceId}/api/lifecycle`
    : '/api/lifecycle';
  return `${prefix}/${hook}`;
}
