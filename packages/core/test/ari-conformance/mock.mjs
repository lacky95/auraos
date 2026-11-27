// The ARI reference mock provider (D100 §18): a provider elsewhere (`remote`),
// whose instances outlive the kernel, with sessions, associated workloads and
// usage, implemented in memory with opaque refs and nothing of Docker. The
// conformance kit runs it (ari-conformance.test.mjs) and the kernel adopts
// from it (ari-modules.test.mjs): the kernel depends on the contract only.
import { HEALTHY, runnerEndpoint } from '../../dist/index.js';

export function mockProvider() {
  const MOCK_CAPS = {
    isolation: 'remote', network: 'remote', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
    readOnlyBinds: true, hostFilesystem: false, mounts: false, idmappedMounts: false, portExpose: false, sidecars: true,
    warmPool: false, survivesShellRestart: true, usage: true, gpu: false,
  };
  const running = new Map();
  const survivors = [{ instanceId: 'org.mock.app-1', appId: 'org.mock.app', port: 4700, ref: 'urn:mock:ws/7f3a', tokenNonce: 'n-1', owner: 'default' }];
  const sessions = [{ sessionId: 's-1', instanceId: 'org.mock.app-1', kind: 'user', userId: 'default', home: 'private', uid: 100000, startedAt: '2026-11-27T00:00:00.000Z' }];
  const runner = {
    capabilities: () => MOCK_CAPS,
    getHost: (id) => (running.has(id) || id === 'known-1' ? 'mock.invalid' : null),
    getPort: (id) => (running.has(id) || id === 'known-1' ? 4700 : null),
    isRunning: (id) => running.has(id),
    onExit: () => {},
    getActivePids: () => [],
  };
  return {
    descriptor: { id: 'mock', version: '0.1.0', ari: 1, title: 'Mock', description: 'reference mock provider (tests only)', builtIn: false,
      settingsVersion: 1, settingsSchema: { type: 'object', properties: {} } },
    runner, capabilities: () => ({ ...MOCK_CAPS }), health: () => HEALTHY, endpoint: (id) => runnerEndpoint(runner, id),
    adoption: {
      list: async () => survivors.map((x) => ({ ...x })),
      adopt: (id) => { running.set(id, true); return { pid: null }; },
      measure: async () => null,
      removeAllOf: async (appId) => { for (const id of [...running.keys()]) if (id.startsWith(appId)) running.delete(id); },
    },
    sessions: { list: () => sessions.map((x) => ({ ...x })), end: async (id) => sessions.some((x) => x.sessionId === id) },
    workloads: { list: async () => [], remove: () => {}, removeOf: () => 0 },
    usage: async (req) => Object.fromEntries(req.instanceIds.filter((id) => running.has(id)).map((id) => [id, { memBytes: 1, cpuPct: 1 }])),
    // A remote provider: no host tool directory, so no `tools` group (tools.* unsupported).
    _running: running,
  };
}
