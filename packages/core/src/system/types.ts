/**
 * The system bootstrap contract (Phase 6 K, D73/D76/D77/D78): a leaf file,
 * plain data and signatures only. `bootSystem()` (system/bootstrap.ts) is the
 * implementation; the server layer (the shell's `lib/bootHooks.ts`) composes
 * it with its hooks.
 */

/** The two build compositions of the one shell project (D76). */
export type Composition = 'server' | 'desktop';

/** Who started the kernel: the production server or the dev server plugin. */
export type BootEntry = 'server.mjs' | 'astro-dev';

/** Hooks of the server layer run in every composition; Web Shell hooks only in `desktop`. */
export type BootHookLayer = 'server' | 'webshell';

export interface BootHook {
  /** For the log and `status.json`. */
  name: string;
  layer: BootHookLayer;
  /**
   * `beforeApps`: after the KV and the notification service, before the app
   * manager starts anything (the base-image readiness the onboarding card
   * shows). `ready` (default): after `AppManager.init()`, detached.
   */
  phase?: 'beforeApps' | 'ready';
  /** Never fails the boot: an error is logged and recorded. */
  run(ctx: BootHookContext): void | Promise<void>;
  /** Kernel shutdown, before the kernel stops (bounded by the shutdown budget). */
  shutdown?(): void | Promise<void>;
}

export interface BootHookContext {
  dataDir: string;
  /** No OS state in the KV before this boot (onboarding welcomes only those). */
  freshInstall: boolean;
  composition: Composition;
}

/** The kernel's environment, all optional: the defaults are today's env variables. */
export interface BootOptions {
  dataDir?: string;
  entry: BootEntry;
  composition?: Composition;
  hooks?: BootHook[];
  /** The shell owns the system mode (5b G, D80); the kernel asks it. */
  developerMode?: () => boolean;
  systemMode?: () => string;
  /** The access mode the server layer enforces (`off|report|enforce`), for `status.json`. */
  accessMode?: () => string;
  /** Runs right after the identity, before anything else (the system-mode file migration, G). */
  early?: (dataDir: string) => void;
  /** The process-wide signal handling: `server.mjs` and the dev plugin install it once. */
  handleSignals?: boolean;
  /** Tests only: replaces the kernel steps 1–5 (the hooks, status and shutdown stay real). */
  kernel?: (ctx: BootHookContext) => Promise<void>;
}

/** One running app service as `status.json` reports it. */
export interface BootServiceStatus {
  state: string;
  readyAt?: string;
}

/** `/data/aura/boot/status.json` (v1). Written atomically by rename. */
export interface BootStatus {
  v: 1;
  bootstrapVersion: number;
  pid: number;
  systemId: string | null;
  identity: { ok: boolean; error?: string };
  entry: BootEntry;
  composition: Composition;
  /** Phase 6b: the locked release; null in Developer Mode. */
  release: { id: string; commit: string } | null;
  systemMode: string | null;
  startedAt: string;
  kernelReadyAt: string | null;
  /** Phase 6b U holds writes during release verification; always true in 6a. */
  acceptingWrites: boolean;
  acceptingWritesAt: string | null;
  appManagers: number;
  kv: { embedded: boolean; version: string | null };
  accessMode: string | null;
  services: Record<string, BootServiceStatus>;
  firstRequestAt: string | null;
  hooks: Record<string, { layer: BootHookLayer; ok: boolean; at: string; error?: string }>;
  /** D94 IC-5 fills it (6b); reserved. */
  infra: null;
  error?: string;
  stoppingAt?: string;
  stoppedAt?: string;
  stopReason?: string;
}

export type ShutdownReason = 'stop' | 'restart' | 'update';

export interface SystemHandle {
  /** Resolves when the kernel is ready (`kernelReadyAt`); rejects when the boot failed. */
  readonly ready: Promise<void>;
  isReady(): boolean;
  status(): BootStatus;
  /** Register a hook after the boot started; a `ready` hook on a ready system runs at once. */
  onReady(hook: BootHook): void;
  /** One kernel shutdown sequence (D77): container workloads keep running and are adopted next boot. */
  shutdown(reason?: ShutdownReason): Promise<void>;
  /** Soft restart: dispose the kernel part and run it again (the new module copy's code). */
  restartKernel(): Promise<void>;
  /** The middleware stamps the first request once. */
  noteFirstRequest(): void;
}
