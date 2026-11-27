// D108 P3v: the shared world of the setup-verify*.test.mjs suites (not a suite itself).
// The REAL engine (SetupService) over a REAL valkey-server: P2's sealed store and state
// machine, the App Host registry, D102 approvals (on a clock the test moves), the
// vault, the GrantStore; P9's home environment through the INT adapter
// (system/compose.ts `homeEnvironmentPort`, auth services pinned to this world).
// Fakes: the kernel's instances, sessions, runtime, the maintenance start.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import { createAppHostRegistry } from '../dist/app-hosts/AppHostRegistry.js';
import { ValkeyApprovalStore } from '../dist/approvals/ValkeyApprovalStore.js';
import { payloadHash } from '../dist/approvals/state.js';
import { GrantStore, isPrivilegedPermission, userScope, appGrantCounts } from '../dist/auth/GrantStore.js';
import { OS_SCOPE } from '../dist/auth/types.js';
import { pinAuthServices } from '../dist/auth/services.js';
import { RUNTIME_FEATURE_IDS } from '../dist/runtimes/ari.js';
import { homeEnvironmentPort, privateHomeForSpawn } from '../dist/system/compose.js';
import { CredentialVault, SetupConfigStore, SetupStateMachine, SetupService } from '../dist/index.js';

export const SRC = { kind: 'oci', ref: 'reg.example/apps/x:1.0.0' };
export const OPERATOR = { kind: 'operator' };
export const OWNER = { kind: 'user', userId: 'default' };
export const TERMINAL = { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' };
export const ALL = Object.fromEntries(RUNTIME_FEATURE_IDS.map((id) => [id, 'supported']));
export const CONTAINER_CAPS = {
  isolation: 'namespace', network: 'bridge', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
  readOnlyBinds: true, hostFilesystem: true, mounts: true, idmappedMounts: false, portExpose: true, sidecars: true, warmPool: true,
  survivesShellRestart: true, usage: true, gpu: false, userNamespaces: false,
};

/** One valkey for the suite; `reset()` before each test. */
export function kvHarness() {
  const root = mkdtempSync(join(tmpdir(), 'aura-setup-verify-'));
  const server = new KvServer();
  const h = {
    root, keyFile: join(root, 'identity.key'), redis: null, clock: { t: Date.now() },
    async start() { h.redis = createRedis(await server.start({ dataDir: join(root, 'kv') })); },
    async stop() { h.redis?.disconnect(); await server.stop(); rmSync(root, { recursive: true, force: true }); },
    async reset() {
      await h.redis.flushall();
      h.clock.t = Date.now();
      h.registry = createAppHostRegistry(() => h.redis);
      h.store = new SetupConfigStore({ identityKeyFile: h.keyFile, redis: () => h.redis });
      h.machine = new SetupStateMachine({ registry: h.registry, store: h.store });
      h.approvals = new ValkeyApprovalStore({ redis: () => h.redis, now: () => h.clock.t });
      h.grants = new GrantStore(() => h.redis);
    },
  };
  return h;
}

function memoryKv() {
  const m = new Map();
  return () => ({
    async get(ns, key) { return m.get(`${ns}|${key}`) ?? null; },
    async set(ns, key, value) { const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}|${key}`, e); return e; },
    async del(ns, key) { return m.delete(`${ns}|${key}`); },
    async list(ns) { return [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)); },
  });
}

/** A maintenance starter: records hook calls; `hooks[name](body)` answers them (may return a promise). */
export function fakeStarter(hooks = {}) {
  const calls = [];
  return {
    calls,
    async startMaintenance(appId, opts) {
      calls.push(['start', appId, opts.reason]);
      return {
        ok: true,
        session: {
          instanceId: `${appId}-m`, appId, reason: opts.reason, startedAt: 0,
          async callHook(hook, body) { calls.push([hook, body]); return hooks[hook] ? hooks[hook](body) : null; },
          async finish(o) { calls.push(['finish', o]); },
        },
      };
    },
  };
}

/**
 * One app's world. `o.manifest(id)` may be swapped by the test (`w.manifest = …`).
 * The resolver ports follow compose.ts `setupResolverPorts`: privileged permissions and
 * `context.read:<KEY>` count through the GrantStore (OS scope, this installation),
 * non-grantable requests through the approval, the Private Home through the home port.
 */
export async function world(h, manifest, o = {}) {
  const appId = manifest.id;
  const inst = await h.registry.createInstallation({ appId, originId: randomUUID(), scope: 'user', source: SRC });
  const installationId = inst.installationId;
  const w = {
    appId, installationId, manifest, features: { ...ALL, ...(o.features ?? {}) }, policy: { 'app-private-home': 'grant', ...(o.policy ?? {}) },
    vault: new CredentialVault({ kv: memoryKv(), key: randomBytes(32) }),
    events: [], audits: [], stopped: [], creates: 0, starter: o.starter ?? null,
    // The kernel the home adapter sees: running instances and open sessions (fakes).
    instances: [], sessions: [], instanceStops: [], sessionsEnded: [],
  };
  const binding = { scope: 'user', installationId };
  // AuthServices as compose's adapter reads them: the real GrantStore, the D64 policy, the audit.
  pinAuthServices({
    version: Number.MAX_SAFE_INTEGER, grants: h.grants,
    securityPolicy: { get: async () => ({ ...w.policy }) },
    audit: { record: async (e) => { w.audits.push(e); } },
  });
  w.kernel = {
    registry: { getById: (id) => (id === appId ? w.manifest : undefined), getScopeId: () => 'user', getAll: () => [w.manifest] },
    appGrantBinding: async () => binding,
    resolveRuntime: async () => ({ runtime: 'container', capabilities: CONTAINER_CAPS, module: {}, settings: {} }),
    installationRunAs: async (id) => (id === appId ? { installationId, runAs: 'app' } : null),
    getInstancesByApp: (id) => (id === appId ? w.instances : []),
    stop: async (instanceId) => { w.instanceStops.push(instanceId); w.instances = w.instances.filter((i) => i.instanceId !== instanceId); },
    openSessions: () => w.sessions,
    endSession: async (sessionId) => { w.sessionsEnded.push(sessionId); w.sessions = w.sessions.filter((s) => s.sessionId !== sessionId); return true; },
    setup: null,
  };
  w.home = o.home === null ? null : homeEnvironmentPort(w.kernel);
  w.deps = {
    ownerId: 'default',
    manifest: (id) => (id === appId ? w.manifest : null),
    installation: async (id) => (id === appId ? { installationId } : null),
    store: h.store, states: h.machine,
    resolverPorts: async (q) => {
      const held = new Set((await h.grants.listFor({ kind: 'app', id: appId }))
        .filter((g) => g.scope.kind === OS_SCOPE.kind && appGrantCounts(g, binding)).map((g) => g.permission));
      const homeAuth = new Map();
      if (w.home) {
        const view = q.homeView ?? q.manifest;
        const q0 = { appId, installationId, userId: q.userId, manifest: view };
        homeAuth.set('', await w.home.homePrivateAuthorized(q0).catch(() => false));
        for (const s of view.services) homeAuth.set(s.name, await w.home.homePrivateAuthorized({ ...q0, sidecar: s.name }).catch(() => false));
      }
      return {
        runtimeFeatures: (id) => (id === 'container' ? w.features : null),
        defaultRuntime: () => 'container',
        isAuthorized: (r) => {
          switch (r.kind) {
            case 'permission': return q.approved.permissions.includes(r.permission) || (isPrivilegedPermission(r.permission) && held.has(r.permission));
            case 'tool': return q.approved.tools.includes(r.tool) || q.manifest.tools.includes(r.tool);
            case 'context': return held.has(`context.read:${r.key}`);
            case 'grant': return held.has(r.grant) || q.approved.permissions.includes(r.grant);
            case 'home-private': return homeAuth.get('') === true;
            case 'home-private-sidecar': return homeAuth.get(r.sidecar) === true;
            default: return false;
          }
        },
        capability: (n) => ({ installed: true, granted: q.manifest.tools.includes(n) || q.approved.tools.includes(n) }),
        policy: (id) => (id in w.policy ? w.policy[id] : null),
      };
    },
    approvals: {
      create: (r) => { w.creates++; return h.approvals.create(r); },
      get: (id) => h.approvals.get(id), consume: (id, c) => h.approvals.consume(id, c),
      cancel: (id, by) => h.approvals.cancel(id, by), hash: payloadHash,
    },
    requester: (a) => (a.kind === 'terminal' ? { kind: 'instance', appId: 'com.aura.terminal', instanceId: a.instanceId, userId: a.userId } : { kind: 'user', userId: a.userId ?? 'default' }),
    appName: () => w.manifest.name,
    vault: w.vault,
    grants: {
      grantPermission: async ({ permission, installationId: i, by }) => { await h.grants.grant({ kind: 'app', id: appId }, permission, { by, installationId: i, appScope: 'user' }); },
      grantContext: async ({ key, installationId: i, by }) => { await h.grants.grant({ kind: 'app', id: appId }, `context.read:${key}`, { by, installationId: i, appScope: 'user' }); },
      grantable: (p) => isPrivilegedPermission(p),
    },
    readGranted: async () => false,
    home: w.home,
    maintenance: () => w.starter,
    stopWorkloads: async (id) => { w.stopped.push(id); },
    audit: async (e) => { w.audits.push(e); },
    emit: (e) => { w.events.push(e); },
    appIds: () => [appId],
  };
  w.svc = new SetupService(w.deps);
  w.kernel.setup = w.svc;
  /** A kernel/shell restart: a new engine over the same records (the old one's memory is gone). */
  w.restart = () => { w.svc.stop(); w.svc = new SetupService(w.deps); w.kernel.setup = w.svc; return w.svc; };
  w.summary = async () => (await h.registry.getInstallation(installationId)).setup ?? null;
  w.record = async () => (await h.store.read({ installationId })).value;
  w.gate = () => w.svc.check(appId, w.manifest, { installationId });
  w.handle = async (name, value = 'pw-from-the-owner') => (await w.vault.store('default', name, value, { consumer: appId })).handle;
  w.spawnPort = () => privateHomeForSpawn(() => w.kernel);
  w.revokeHome = (permission = 'home.private') => h.grants.revoke({ kind: 'app', id: appId }, permission, userScope('default'));
  w.regrantHome = async (permission = 'home.private') => {
    await h.grants.grant({ kind: 'app', id: appId }, permission, { by: { kind: 'operator' }, scope: userScope('default'), installationId, appScope: 'user' });
  };
  return w;
}

/** Poll until `fn()` is truthy (the watcher's debounce), at most `ms`. */
export async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The Open WebUI worked example (setup-resolve.test.mjs `openWebui()`), with an extra profile that asks the
 * Private Home but leaves the base's shared listener (webui) as it is. */
export const openWebui = () => ({
  id: 'io.lakner.openwebui', name: 'Open WebUI', version: '0.2.0', auraContract: 1, sandbox: 'container', environmentScope: 'user',
  homeEnvironments: { supported: ['app', 'private'], recommended: 'app', reason: 'uses your agent logins in the terminal sidecar' },
  services: [
    { name: 'webui', image: 'ghcr.io/open-webui/open-webui:main', port: 8080, env: {
      WEBUI_AUTH: { fromSetup: 'auth', map: { native: 'True', aura: 'False' } },
      WEBUI_SECRET_KEY: { fromSecret: 'sessionKey' },
    } },
    { name: 'terminal', image: 'ghcr.io/example/terminal:1', inheritHome: true },
  ],
  setup: {
    version: 1,
    fields: {
      auth: { type: 'string', enum: ['native', 'aura'], default: 'native', title: 'Sign-in' },
      sessionKey: { type: 'secret', title: 'Session key', secret: { source: 'generate', length: 32 } },
    },
    init: { hook: true },
  },
  profiles: [
    { id: 'personal', title: 'Personal (own logins)', recommended: true,
      overlay: { instanceScope: 'per-user', environmentScope: 'user', homeEnvironment: 'app' } },
    { id: 'personal-private', title: 'Personal, using my logins',
      overlay: { instanceScope: 'per-user', homeEnvironment: 'private',
        services: { terminal: { home: 'owner-environment', network: 'instance' }, webui: { network: 'instance' } } },
      setup: { requirements: [
        { grant: 'home.private', level: 'required' }, { grant: 'home.private.sidecar:terminal', level: 'required' },
        { feature: 'storage.privateHome', level: 'required' }, { feature: 'network.isolation', level: 'required' },
      ] } },
    { id: 'private-shared-listener', title: 'Private, base networks',
      overlay: { instanceScope: 'per-user', homeEnvironment: 'private', services: { terminal: { home: 'owner-environment', network: 'instance' } } },
      setup: { requirements: [{ grant: 'home.private', level: 'required' }, { grant: 'home.private.sidecar:terminal', level: 'required' }] } },
    { id: 'team', title: 'Shared for several users',
      overlay: { instanceScope: 'shared', environmentScope: 'global', homeEnvironment: 'app' } },
  ],
});
