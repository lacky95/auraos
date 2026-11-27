// The ARI reference mock provider (D100 §18): a provider elsewhere (`remote`),
// whose instances outlive the kernel, with sessions, associated workloads and
// usage, implemented in memory with opaque refs and nothing of Docker. The
// conformance kit runs it (ari-conformance.test.mjs) and the kernel adopts
// from it (ari-modules.test.mjs): the kernel depends on the contract only.
// Its instance operations (spawn, kill, forceKill, onExit) are in memory too,
// so the kit's instance-ops, workload-token and G1 rows run against it (5b E).
import { HEALTHY, RuntimeExecError, requireLimits, requireNetworkIsolation, runnerEndpoint } from '../../dist/index.js';

/**
 * `limits`: which resource limits it enforces (D106), each `supported` by default; a variant with some or all
 * `unsupported` is the conformance kit's partial and no-limits provider.
 */
export function mockProvider({
  limits = { cpus: 'supported', memoryBytes: 'supported', pids: 'supported' },
  /** D107: the network isolation it enforces for workloads (`none`: a variant that can't). */
  workloadIsolation = 'instance',
  /** D107: nested sandboxes in its workloads. */
  userNamespaces = true,
} = {}) {
  const MOCK_CAPS = {
    isolation: 'remote', network: 'remote', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
    readOnlyBinds: true, hostFilesystem: false, mounts: false, idmappedMounts: false, portExpose: false, sidecars: true,
    warmPool: false, survivesShellRestart: true, usage: true, gpu: false, userNamespaces,
  };
  const running = new Map();   // instanceId → { port, env, ref, nonce }
  const exits = new Map();     // instanceId → [cb]
  const workloads = new Map(); // OS sidecar ref → { ref, state, env, tags }
  const builds = [];           // { op, appId, limits }
  const attached = [];         // instances that (re)joined their workload network
  const anyLimit = Object.values(limits).some((v) => v !== 'unsupported');
  const featureOverrides = () => ({
    'build.execute': { support: 'supported' },
    'network.isolation': { support: 'supported', constraints: { workloadIsolation } },
    'resources.limits': { support: anyLimit ? 'supported' : 'unsupported', constraints: { workloads: 'build', ...limits } },
  });
  /** D106 `resources.limits`: positive finite; integer bytes and pids; nothing else. */
  const checkLimits = (l) => {
    if (l === undefined) return;
    const bad = !l || typeof l !== 'object' || Object.entries(l).some(([k, v]) => !['cpus', 'memoryBytes', 'pids'].includes(k)
      || typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (k !== 'cpus' && !Number.isInteger(v)));
    if (bad) throw Object.assign(new Error('invalid resource limits'), { code: 'invalid-resource-limits' });
    // Mandatory (D106): a limit it can't enforce refuses the workload, the same contract check the kernel makes.
    requireLimits({ descriptor: { id: 'mock' }, capabilities: () => ({ ...MOCK_CAPS }), featureOverrides }, {}, l);
  };
  const survivors = [{ instanceId: 'org.mock.app-1', appId: 'org.mock.app', port: 4700, ref: 'urn:mock:ws/7f3a', tokenNonce: 'n-1', owner: 'default' }];
  const sessions = [{ sessionId: 's-1', instanceId: 'org.mock.app-1', kind: 'user', userId: 'default', home: 'private', uid: 100000, startedAt: '2026-11-27T00:00:00.000Z' }];
  let seq = 0;
  const exit = (id, code) => {
    if (!running.delete(id)) return false;
    for (const cb of exits.get(id) ?? []) cb(code);
    exits.delete(id);
    return true;
  };
  const runner = {
    capabilities: () => MOCK_CAPS,
    getHost: (id) => (running.has(id) || id === 'known-1' ? 'mock.invalid' : null),
    getPort: (id) => (running.get(id)?.port ?? (id === 'known-1' ? 4700 : null)),
    isRunning: (id) => running.has(id),
    onExit: (id, cb) => { exits.set(id, [...(exits.get(id) ?? []), cb]); },
    getActivePids: () => [],
    // D89: the workload gets the kernel's token as AURA_INSTANCE_TOKEN; the provider keeps only the nonce.
    spawn: async (instanceId, _appId, port, _manifest, ctx) => {
      if (!ctx?.instanceToken?.token) throw new Error('no workload token: refused (D89)');
      running.set(instanceId, { port, env: { ...(ctx.env ?? {}), AURA_INSTANCE_TOKEN: ctx.instanceToken.token }, ref: `urn:mock:ws/${++seq}`, nonce: ctx.instanceToken.nonce });
      return 0;
    },
    kill: async (id) => { exit(id, 0); },
    forceKill: (id) => exit(id, 137),
  };
  const self = { descriptor: { id: 'mock' }, capabilities: () => ({ ...MOCK_CAPS }), featureOverrides };
  return {
    descriptor: { id: 'mock', version: '0.1.0', ari: 1, title: 'Mock', description: 'reference mock provider (tests only)', builtIn: false,
      settingsVersion: 1, settingsSchema: { type: 'object', properties: {} } },
    runner, capabilities: () => ({ ...MOCK_CAPS }), health: () => HEALTHY, endpoint: (id) => runnerEndpoint(runner, id),
    // D106: it builds in memory, within the limits it is given (validated by its own rules: the contract, not Docker's).
    featureOverrides,
    build: {
      build: async (spec) => { checkLimits(spec.limits); builds.push({ op: 'build', appId: spec.appId, limits: spec.limits ?? null }); return { ok: true, output: '' }; },
      provision: async (spec) => { checkLimits(spec.limits); builds.push({ op: 'provision', appId: spec.appId, limits: spec.limits ?? null }); return { ok: true, output: '' }; },
    },
    /** What it built, with the limits each ran within. */
    _builds: builds,
    adoption: {
      list: async () => [...survivors.map((x) => ({ ...x })),
        ...[...running].filter(([id]) => !survivors.some((s) => s.instanceId === id))
          .map(([instanceId, r]) => ({ instanceId, appId: instanceId.replace(/-\d+$/, ''), port: r.port, ref: r.ref, tokenNonce: r.nonce }))],
      adopt: (id) => { if (!running.has(id)) running.set(id, { port: 4700, env: {}, ref: 'urn:mock:adopted', nonce: 'n' }); return { pid: null }; },
      measure: async () => null,
      removeAllOf: async (appId) => { for (const id of [...running.keys()]) if (id.startsWith(appId)) running.delete(id); },
    },
    sessions: { list: () => sessions.map((x) => ({ ...x })), end: async (id) => sessions.some((x) => x.sessionId === id) },
    // Associated workloads in memory: an exec or a log of one that isn't there fails with a neutral code (5b-2 D-X).
    workloads: {
      list: async () => [], remove: () => {}, removeOf: () => 0,
      exec: async (id) => { throw new RuntimeExecError('not-found', `no workload ${id}`); },
      logs: async (id) => { throw new RuntimeExecError('not-found', `no workload ${id}`); },
      // OS sidecars (Phase 6 D-S): opaque refs, tags kept as given, nothing of Docker.
      ref: (instanceId, name) => `urn:mock:wl/${instanceId}/${name}`,
      listOf: async (instanceId) => [...workloads.values()].filter((w) => w.tags['aura.parent'] === instanceId && w.tags['aura.managed'] === 'os')
        .map((w) => ({ ref: w.ref, instanceId, state: w.state, record: w.tags['aura.sidecar.spec'] })),
      listManaged: async () => [...workloads.values()].filter((w) => w.tags['aura.managed'] === 'os')
        .map((w) => ({ ref: w.ref, instanceId: w.tags['aura.parent'], record: w.tags['aura.sidecar.spec'] })),
      spawnedBy: async (instanceId, owner) => [...workloads.values()]
        .filter((w) => w.tags['aura.parent'] === instanceId && w.tags['aura.sidecar.owner'] === owner).map((w) => w.ref),
      inspect: async (ref) => { const w = workloads.get(ref); return w ? { ref, state: w.state, tags: { ...w.tags }, restarts: 0 } : null; },
      storageExists: async () => false,
      prepareImage: async () => {},
      instanceEnv: async (id) => ({ ...(running.get(id)?.env ?? {}) }),
      seed: async () => {},
      create: async (req) => {
        // D107: mandatory isolation, the same contract check the kernel makes; never created on a shared network.
        if (req.spec.network === 'instance') requireNetworkIsolation(self, {}, 'instance');
        const ref = `urn:mock:wl/${req.instanceId}/${req.spec.name}`;
        workloads.set(ref, { ref, state: 'created', network: req.spec.network ?? 'shared', env: { ...req.env, ...(req.token ? { AURA_INSTANCE_TOKEN: req.token } : {}) }, tags: {
          'aura.parent': req.instanceId, 'aura.app': req.appId, 'aura.service': req.spec.name, 'aura.managed': 'os',
          'aura.sidecar.template': req.spec.template, 'aura.sidecar.owner': req.owner ?? '-', 'aura.sidecar.spec': req.record,
        } });
        return ref;
      },
      attachInstance: async (instanceId) => { attached.push(instanceId); },
      start: async (id) => { const w = workloads.get(id); if (!w) throw new Error(`no workload ${id}`); w.state = 'running'; },
      destroy: async (ref, o = {}) => { if (!workloads.delete(ref) && !o.quiet) throw new Error(`no workload ${ref}`); },
      run: async (ref) => { if (!workloads.has(ref)) throw new Error(`no workload ${ref}`); return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }; },
      output: async (ref) => { if (!workloads.has(ref)) throw new Error(`no workload ${ref}`); return { stdout: '', stderr: '' }; },
      lastWords: async () => '',
    },
    /** Instances that rejoined their workload network (D107). */
    _attached: attached,
    /** The OS sidecars it runs (the D-S row of ari-modules.test.mjs). */
    _workloads: workloads,
    // The instance's own output, kept by the provider (no runner output ring, no engine).
    logs: async (id, _req, onChunk) => {
      if (!running.has(id)) throw new RuntimeExecError('not-running', `${id} is not running`);
      onChunk('out', Buffer.from(`${id} started\n`));
      return { done: Promise.resolve(), close: () => {} };
    },
    // Read-only diagnostics of a remote workload: what it wrote outside its mounts, by instance id only.
    diagnostics: { inspectWrites: async (id) => (running.has(id) ? [] : null) },
    usage: async (req) => Object.fromEntries(req.instanceIds.filter((id) => running.has(id)).map((id) => [id, { memBytes: 1, cpuPct: 1 }])),
    // A remote provider: no host tool directory, so no `tools` group (tools.* unsupported).
    _running: running,
    /** The env its workload got (the kit's workload-token row). */
    _workloadEnv: (id) => ({ ...(running.get(id)?.env ?? {}) }),
  };
}
