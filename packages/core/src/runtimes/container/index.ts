/**
 * The `container` runtime module (ARI §4.1, 5b CR): one Docker container per
 * instance (app-manager/ContainerRunner). Always installed and never
 * disabled, so it is the default (Q18) and what an app falls to only when the
 * owner decides. The reference provider of ARI (D100).
 *
 * This file adapts the runner to the contract (draft "minimal-change note"):
 * the capability groups (`adoption`, `sessions`, `workloads`, `tools`,
 * `usage`) are written against the provider-neutral interfaces of `ari.ts`
 * and delegate to today's mechanism, so nothing in the spawn path moves and
 * golden argv is unchanged. Container names, PIDs and engine handles stay in
 * here: a survivor's `ref` is opaque to the kernel. The Docker mechanics of
 * mounts, port expose, sidecar create/exec, logs and builds move behind the
 * pending groups in 5b-2 stream D.
 *
 * The runner is handed in by the composition point (AppManager today,
 * `bootSystem()` in Phase 6): this module imports no app-manager code at
 * runtime (D97: no `runtimes → app-manager` edge).
 */
import type { ContainerRunner } from '../../app-manager/ContainerRunner.js';
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import {
  runnerEndpoint, type RuntimeAdoption, type RuntimeHealthCheck, type RuntimeModule, type RuntimeSessions, type RuntimeSurvivor, type RuntimeWorkloads,
} from '../ari.js';
import { hostToolsGroup, toolsEnforcement, toolsFeatureOverrides, type ToolsMode } from '../hostTools.js';

/** The runner surface the module adapts: the SandboxRunner contract plus the container's own groups. */
export type ContainerRunnerSurface = SandboxRunner & Partial<Pick<ContainerRunner, 'openSessions' | 'endSession' | 'canPropagateMounts'>>;

type OrphanRecord = NonNullable<Awaited<ReturnType<NonNullable<SandboxRunner['listOrphanRecords']>>>>[number] & { user?: string };

export interface ContainerRuntimeDeps {
  /** The host's tools mode (tool-provision `currentToolsMode`); absent: not reported. */
  toolsMode?: () => ToolsMode;
}

export function containerRuntime(runner: ContainerRunnerSurface, deps: ContainerRuntimeDeps = {}): RuntimeModule {
  const toolsMode = () => deps.toolsMode?.() ?? null;
  // Each group exactly when the runner declares its capability (static for the container runner).
  const caps = runner.capabilities({});
  // The last scan's records by instance: `adopt` hands exactly what was listed back to the runner.
  let listed = new Map<string, OrphanRecord>();
  return {
    descriptor: {
      id: 'container',
      version: '1.1.0',
      ari: 1,
      title: 'Container',
      description: 'Each instance in its own Docker container: kernel namespaces, enforced read-only binds, sidecars, '
        + 'cross-app mounts and port expose. Instances survive a shell restart. The default.',
      builtIn: true,
      alwaysEnabled: true,
      settingsSchema: { type: 'object', properties: {} },
      settingsVersion: 1,
    },
    runner,
    capabilities: () => runner.capabilities({}),
    // App builds and provisioning run on this runtime today (the kernel build service; D-B moves them behind `build`).
    featureOverrides: () => ({ 'build.execute': { support: 'supported' }, ...toolsFeatureOverrides(runner.capabilities({}), toolsMode()) }),
    // Never `unavailable`: the default runtime must not be blocked by a probe. A failed check degrades (and its
    // feature fails closed where it is used: a mount without propagation is refused by MountManager).
    health: () => {
      const checks: RuntimeHealthCheck[] = [];
      const prop = runner.canPropagateMounts?.();
      if (prop) checks.push({ id: 'mount-propagation', ok: prop.ok, ...(prop.reason ? { detail: prop.reason } : {}) });
      const mode = toolsMode();
      if (mode) {
        checks.push({ id: 'tools-mode', ok: mode === 'hardlink',
          ...(mode === 'hardlink' ? {} : { detail: `tool grants are ${toolsEnforcement(mode)} (legacy symlink mode: every tool is reachable by absolute path)` }) });
      }
      return { status: checks.every((c) => c.ok) ? 'ok' : 'degraded', checks };
    },
    endpoint: (instanceId) => runnerEndpoint(runner, instanceId),

    ...(caps.survivesShellRestart ? { adoption: {
      async list() {
        const raw = await runner.listOrphanRecords?.();
        if (!raw) return raw === undefined ? [] : null;
        listed = new Map(raw.map((o) => [o.instanceId, o as OrphanRecord]));
        return raw.map((o): RuntimeSurvivor => {
          const r = o as OrphanRecord;
          return {
            instanceId: r.instanceId, appId: r.appId, port: r.port, ref: r.hostname,
            ...(r.tokenNonce ? { tokenNonce: r.tokenNonce } : {}),
            ...(r.ownerLabel ? { owner: r.ownerLabel } : {}),
            ...(r.user ? { user: r.user } : {}),
            ...(r.preview ? { preview: r.preview } : {}),
          };
        });
      },
      adopt(instanceId) {
        const rec = listed.get(instanceId);
        if (!rec) throw new Error(`${instanceId} is not a listed survivor`);
        runner.registerAdopted?.(rec);
        return { pid: rec.pid };
      },
      measure: async (instanceId) => (await runner.measureAdopted?.(instanceId)) ?? null,
      removeAllOf: async (appId) => { await runner.killAllForApp?.(appId); },
    } satisfies RuntimeAdoption } : {}),
    ...(caps.sessionExec ? { sessions: {
      // The broker's launcher pid stays in here (no PIDs at the contract).
      list: () => (runner.openSessions?.() ?? []).map(({ launcherPid: _pid, ...r }) => r),
      end: (sessionId) => runner.endSession?.(sessionId) ?? Promise.resolve(false),
    } satisfies RuntimeSessions } : {}),
    ...(caps.sidecars ? { workloads: {
      list: async () => (runner.listSidecars ? runner.listSidecars() : []),
      remove: (ids) => { runner.removeSidecars?.(ids); },
      removeOf: (instanceId, opts = {}) => runner.reapSiblingsOf?.(instanceId, opts.keepServices ? { keep: { services: opts.keepServices } } : {}) ?? 0,
    } satisfies RuntimeWorkloads } : {}),
    ...(caps.hostFilesystem ? { tools: hostToolsGroup(runner, toolsMode) } : {}),
    ...(caps.usage ? { usage: async (req: { instanceIds: string[]; sidecarIds: string[] }) => (runner.usage ? Object.fromEntries(await runner.usage(req)) : {}) } : {}),
  };
}
