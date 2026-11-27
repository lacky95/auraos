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
 * here: a survivor's `ref` is opaque to the kernel. 5b-2 D moved behind its
 * groups: port expose (`endpoints`), builds (`build`), sidecar exec/logs
 * (`workloads`), instance logs (`logs`), the dataDir and cap-doctor
 * inspections (`diagnostics`). Mounts and sidecar create stay in the
 * managers until Phase 6 (D-M, D-S).
 *
 * The runner is handed in by the composition point (AppManager today,
 * `bootSystem()` in Phase 6): this module imports no app-manager code at
 * runtime (D97: no `runtimes → app-manager` edge).
 */
import type { ContainerRunner } from '../../app-manager/ContainerRunner.js';
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import {
  runnerEndpoint, type RuntimeAdoption, type RuntimeBuild, type RuntimeLogsRequest, type RuntimeOutputStream, type RuntimeHealthCheck, type RuntimeModule, type RuntimeSessions, type RuntimeSurvivor, type RuntimeWorkloads,
} from '../ari.js';
import { containerDiagnostics } from './diagnostics.js';
import { containerEndpoints } from './endpoints.js';
import { RuntimeExecError } from '../types.js';
import { hostToolsGroup, toolsEnforcement, toolsFeatureOverrides, type HostToolStore, type ToolsMode } from '../hostTools.js';

/** The runner surface the module adapts: the SandboxRunner contract plus the container's own groups. */
export type ContainerRunnerSurface = SandboxRunner & Partial<Pick<ContainerRunner,
  'openSessions' | 'endSession' | 'canPropagateMounts' | 'instanceLogs' | 'execWorkload' | 'workloadLogs' | 'forwarderFacts' | 'buildApp' | 'provisionApp'>>;

type OrphanRecord = NonNullable<Awaited<ReturnType<NonNullable<SandboxRunner['listOrphanRecords']>>>>[number] & { user?: string };

export interface ContainerRuntimeDeps {
  /** The host's tools mode (tool-provision `currentToolsMode`); absent: not reported. */
  toolsMode?: () => ToolsMode;
  /** The toolchain store (`tools.status`); absent: no library checks. */
  toolStore?: () => HostToolStore;
  /** The image app containers run (BaseImage `BASE_IMAGE`; default `aura-base`). */
  baseImage?: string;
  /** Environment (the `cap doctor` probe's volume name; default `process.env`). */
  env?: Record<string, string | undefined>;
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
    // App builds and provisioning run on this runtime (its `build` group, D-B).
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
      exec: async (workloadId, spec, onOutput) => {
        if (!runner.execWorkload) throw new RuntimeExecError('engine', `no exec into ${workloadId}: the runner has no engine`);
        return runner.execWorkload(workloadId, spec, onOutput);
      },
      logs: async (workloadId, req, onChunk) => {
        if (!runner.workloadLogs) throw new RuntimeExecError('engine', `no log of ${workloadId}: the runner has no engine`);
        return runner.workloadLogs(workloadId, req, onChunk);
      },
    } satisfies RuntimeWorkloads } : {}),
    // The instance's own output: the engine's log (5b-2 D-X).
    ...(runner.instanceLogs ? { logs: (instanceId: string, req: RuntimeLogsRequest, onChunk: (stream: RuntimeOutputStream, data: Buffer) => void) => runner.instanceLogs!(instanceId, req, onChunk) } : {}),
    ...(caps.portExpose ? { endpoints: containerEndpoints(() => {
      if (!runner.forwarderFacts) throw new Error('the container runner has no forwarder facts');
      return runner.forwarderFacts();
    }) } : {}),
    // App builds and provisioning in a throwaway builder container (D-B; the runner's `buildApp`/`provisionApp`).
    build: {
      build: async ({ appId, appDir, timeoutMs }) => {
        if (!runner.buildApp) throw new Error('the container runner has no builder');
        return runner.buildApp(appId, appDir, timeoutMs !== undefined ? { timeoutMs } : {});
      },
      provision: async ({ appId, appDir, runtime, onLine }) => {
        if (!runner.provisionApp) throw new Error('the container runner has no builder');
        return runner.provisionApp(appId, appDir, runtime, onLine ? { onLine } : {});
      },
    } satisfies RuntimeBuild,
    ...(caps.hostFilesystem ? { tools: hostToolsGroup(runner, toolsMode, () => deps.toolStore?.() ?? null) } : {}),
    diagnostics: containerDiagnostics({
      baseImage: deps.baseImage ?? 'aura-base',
      // As the `cap doctor` route always named it (the compose project's app-data volume).
      appDataVolume: () => (deps.env ?? process.env)['AURA_APP_DATA_VOLUME'] ?? 'aura_aura-app-data',
    }),
    ...(caps.usage ? { usage: async (req: { instanceIds: string[]; sidecarIds: string[] }) => (runner.usage ? Object.fromEntries(await runner.usage(req)) : {}) } : {}),
  };
}
