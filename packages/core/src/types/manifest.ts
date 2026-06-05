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
   * Cross-app dependencies. Declared by author, enforced at install time
   * (the Nexus installer warns / refuses if a required dep is missing).
   * v1: the installer warns + lists missing deps; v2 auto-installs them
   * recursively. `version` is a semver range parsed by the resolver.
   */
  dependencies: z.array(z.object({
    id:      z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/),
    version: z.string(),
  })).default([]),
}).refine(
  (m) => m.componentType !== 'service' || m.activityMode === 'none',
  { message: "componentType: 'service' requires activityMode: 'none' — services cannot host activities", path: ['componentType'] },
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
