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
  shortcuts: z.array(z.object({
    name: z.string(),
    action: z.string(),
    icon: z.string().optional(),
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
}).refine(
  (m) => m.componentType !== 'service' || m.activityMode === 'none',
  { message: "componentType: 'service' requires activityMode: 'none' — services cannot host activities", path: ['componentType'] },
);

export type AppManifest = z.infer<typeof AppManifestSchema>;
