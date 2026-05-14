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
  name: z.string().min(1).max(64),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(256).optional(),
  icon: z.string().optional(),
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
   * Activity policy: 'none' = each window has its own backend instance,
   * 'multi' = one backend instance can host multiple concurrent activities (UI screens, tabs).
   * Analogous to Android's per-app Activity stack.
   */
  activityMode: z.enum(['none', 'multi']).default('none'),
  /** Cap on concurrent activities per instance. 0 = unlimited. */
  maxActivitiesPerInstance: z.number().int().min(0).default(0),
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
  preferredLayout: z.enum(['fullscreen', 'tiling', 'windowed', 'any']).default('any'),
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
   * Optional content-provider declaration. Apps that expose structured data
   * to OTHER apps register paths here. The OS routes `/api/data/<authority>/...`
   * requests through this declaration and enforces permissions.
   */
  dataProvider: DataProviderSchema.optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
