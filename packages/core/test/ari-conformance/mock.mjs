// The ARI reference mock provider (D100 §18): a provider elsewhere (`remote`),
// whose instances outlive the kernel, with sessions, associated workloads and
// usage, implemented in memory with opaque refs and nothing of Docker. The
// conformance kit runs it (ari-conformance.test.mjs) and the kernel adopts
// from it (ari-modules.test.mjs): the kernel depends on the contract only.
// Its instance operations (spawn, kill, forceKill, onExit) are in memory too,
// so the kit's instance-ops, workload-token and G1 rows run against it (5b E).
import { HEALTHY, runnerEndpoint } from '../../dist/index.js';

export function mockProvider() {
  const MOCK_CAPS = {
    isolation: 'remote', network: 'remote', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
    readOnlyBinds: true, hostFilesystem: false, mounts: false, idmappedMounts: false, portExpose: false, sidecars: true,
    warmPool: false, survivesShellRestart: true, usage: true, gpu: false,
  };
  const running = new Map();   // instanceId → { port, env, ref, nonce }
  const exits = new Map();     // instanceId → [cb]
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
  return {
    descriptor: { id: 'mock', version: '0.1.0', ari: 1, title: 'Mock', description: 'reference mock provider (tests only)', builtIn: false,
      settingsVersion: 1, settingsSchema: { type: 'object', properties: {} } },
    runner, capabilities: () => ({ ...MOCK_CAPS }), health: () => HEALTHY, endpoint: (id) => runnerEndpoint(runner, id),
    adoption: {
      list: async () => [...survivors.map((x) => ({ ...x })),
        ...[...running].filter(([id]) => !survivors.some((s) => s.instanceId === id))
          .map(([instanceId, r]) => ({ instanceId, appId: instanceId.replace(/-\d+$/, ''), port: r.port, ref: r.ref, tokenNonce: r.nonce }))],
      adopt: (id) => { if (!running.has(id)) running.set(id, { port: 4700, env: {}, ref: 'urn:mock:adopted', nonce: 'n' }); return { pid: null }; },
      measure: async () => null,
      removeAllOf: async (appId) => { for (const id of [...running.keys()]) if (id.startsWith(appId)) running.delete(id); },
    },
    sessions: { list: () => sessions.map((x) => ({ ...x })), end: async (id) => sessions.some((x) => x.sessionId === id) },
    workloads: { list: async () => [], remove: () => {}, removeOf: () => 0 },
    usage: async (req) => Object.fromEntries(req.instanceIds.filter((id) => running.has(id)).map((id) => [id, { memBytes: 1, cpuPct: 1 }])),
    // A remote provider: no host tool directory, so no `tools` group (tools.* unsupported).
    _running: running,
    /** The env its workload got (the kit's workload-token row). */
    _workloadEnv: (id) => ({ ...(running.get(id)?.env ?? {}) }),
  };
}
