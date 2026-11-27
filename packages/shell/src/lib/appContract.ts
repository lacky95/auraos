/**
 * The shell's side of the Aura app contract (D48):
 *
 *   GET /api/os/context/<KEY>          `osClient.context.get`: a declared Context
 *                                      key, to the app's own server only
 *   GET /api/user/me/permissions?p=…   `osClient.permissions.has/check`
 *   GET /api/admin/contract-report     per app: the contract it was built
 *                                      for, what it declares, undeclared use
 *                                      (source scan + access-report signals),
 *                                      and with `?datadir=1` the writes outside
 *                                      its dataDir
 *
 * `context.get` follows the one rule of the spawn env (Phase 5 stream C,
 * core context/grantedContext.ts): a key the app declares in `context[]` AND
 * holds: from the vault of the user the instance acts for (`credential.read`,
 * D56), else from the system Context (`context.read:<KEY>`). An undeclared
 * key is refused (and counted in the access report); a declared one the
 * owner has not granted is refused too, naming the grant.
 */
import * as core from '@aura/core';
import type { AppManifest, ContextStore } from '@aura/core';
import type { CallerPrincipal, ResolvedPrincipal } from './access/identify.ts';
import { actingInstance, isOwnerPrincipal } from './access/identify.ts';
import type { ContractSignal } from './access/types.ts';

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
/** `permissions.check` asks about at most this many at once. */
export const MAX_PERMISSION_CHECKS = 32;
const PERMISSION_RE = /^[A-Za-z0-9._:<>-]{1,128}$/;

// ── GET /api/os/context/<KEY> ───────────────────────────────────────────────

export interface ContextReadDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  /** The app's manifest `context[]`, undefined for an unknown app. */
  declared(appId: string): readonly string[] | undefined;
  /** The granted-Context lookups (core `liveGrantedContextDeps`). */
  context: core.GrantedContextDeps;
  signal(signal: ContractSignal, appId: string): void;
}

/**
 * A Context value for the app's own server: an instance token (or an OS
 * sidecar's), never a page through the gateway, never the owner (the
 * Context API never discloses a secret to anyone else).
 */
export async function readContext(request: Request, key: string | undefined, deps: ContextReadDeps): Promise<Response> {
  if (!key || !KEY_RE.test(key)) return reply({ error: 'invalid-key' }, 422);
  const r = await deps.resolve(request);
  if (r.rejected) return reply({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  if (p.kind !== 'instance' || r.via !== 'instance-token') {
    return reply({ error: 'server-only', message: 'Context values go only to an app\'s own server, with its instance token (osClient.context.get).' },
      p.kind === 'anonymous' ? 401 : 403);
  }
  const inst = p as core.InstancePrincipal;
  const got = await core.grantedContextValue({
    appId: inst.appId, declared: deps.declared(inst.appId), key, instanceId: inst.instanceId,
    ...(inst.userId ? { userId: inst.userId } : {}),
  }, deps.context);
  if ('refused' in got) {
    if (got.refused === 'undeclared') {
      deps.signal('context-undeclared', inst.appId);
      return reply({ error: 'context-undeclared', message: `Declare "${key}" in app.manifest.json context[] to read it.` }, 403);
    }
    deps.signal('context-get', inst.appId);
    if (got.refused === 'not-granted') {
      return reply({ error: 'context-not-granted', message: `The owner has not granted ${key} to this app (aura admin grant ${inst.appId} context.read:${key}).` }, 403);
    }
    return reply({ error: 'not-set', message: `The owner has not set ${key}.` }, 404);
  }
  deps.signal('context-get', inst.appId);
  return reply({ key, value: got.value });
}

/** The live Context read: the registry's declarations, GrantStore, the system Context, the vault, the audit. */
export function liveContextReadDeps(store: Pick<ContextStore, 'get' | 'resolveEnv'>, signal: ContextReadDeps['signal']): ContextReadDeps {
  const svc = core.getAuthServices();
  return {
    resolve: async (request) => (await import('./auth.ts')).resolveCaller(request),
    declared: (appId) => {
      // D108: a ready setup's approved Context keys count (the effective view).
      try { return (core.getAppManager().effectiveManifest(appId) as (AppManifest & { context?: string[] }) | undefined)?.context; } catch { return undefined; }
    },
    context: core.liveGrantedContextDeps({
      grants: svc.grants,
      appBinding: async (appId) => { try { return await core.getAppManager().appGrantBinding(appId); } catch { return { scope: undefined, installationId: null }; } },
      store,
      vault: new core.CredentialVault(),
      audit: (entry) => svc.audit.record(entry),
    }),
    signal,
  };
}

// ── GET /api/user/me/permissions ────────────────────────────────────────────

export interface PermissionCheckDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  /** Whether the principal holds the permission, as a route rule decides it (decide.ts `permissionHeld`). */
  held(principal: core.Principal, permission: string): Promise<boolean>;
}

/**
 * The principal a permission is asked for: the app behind the call. `owner`:
 * the owner (holds every permission). A member is asked as itself: it holds
 * only its own `user` grants (I.2 audit).
 */
function permissionSubject(p: CallerPrincipal): core.Principal | 'owner' | null {
  const inst = actingInstance(p);
  if (inst) return inst;
  if (p.kind === 'apiKey') return p;
  if (isOwnerPrincipal(p)) return 'owner';
  if (p.kind === 'user') return p;
  return null;
}

export async function checkPermissions(request: Request, deps: PermissionCheckDeps): Promise<Response> {
  const names = [...new Set(new URL(request.url).searchParams.getAll('p'))];
  if (names.length === 0) return reply({ error: 'no-permissions', message: 'Ask with ?p=<permission>.' }, 400);
  if (names.length > MAX_PERMISSION_CHECKS) return reply({ error: 'too-many' }, 400);
  if (!names.every((n) => PERMISSION_RE.test(n))) return reply({ error: 'invalid-permission' }, 400);
  const r = await deps.resolve(request);
  if (r.rejected) return reply({ error: 'invalid-credential' }, 401);
  if (r.principal.kind === 'anonymous') return reply({ error: 'login-required' }, 401);
  const subject = permissionSubject(r.principal);
  if (!subject) return reply({ error: 'no-app' }, 403);
  const permissions: Record<string, boolean> = {};
  for (const n of names) permissions[n] = subject === 'owner' ? true : await deps.held(subject, n);
  return reply({ permissions });
}

// ── GET /api/admin/contract-report ──────────────────────────────────────────

export interface ContractReportApp {
  appId: string;
  name: string;
  scope: string;
  dir: string;
  /** The runtime id, as latched or named (5b G: reported as is). */
  sandbox: string;
  /** Its runtime gives instances their own mount namespace (capabilities). */
  ownNamespace: boolean;
  manifest: AppManifest & { context?: string[] };
  instances: Array<{ instanceId: string; inspect?: boolean }>;
}

export interface ContractReportDeps {
  apps(): ContractReportApp[];
  /** The live Context keys (names only), for the env-read scan. */
  contextKeys(): Promise<string[]>;
  /** `contract|<signal>|<appId>` counters, summed over the report window. */
  signals(): Promise<Record<string, number>>;
  dataDir?(apps: core.DataDirAppInput[]): Promise<core.DataDirAppReport[]>;
}

export interface ContractReportRow {
  appId: string;
  name: string;
  scope: string;
  contract: { version: number | null; status: core.ContractStatus };
  declares: core.ContractDeclarations;
  findings: core.ContractFinding[];
  source: core.ContractSourceFinding[];
  /** Access-report counters of this app (CONTRACT_SIGNALS). */
  signals: Record<string, number>;
  /** Reads the raw mounted Context (source scan): the count the plan's report asks for. */
  readsRawContext: boolean;
  dataDir?: core.DataDirAppReport;
}

export async function contractReport(deps: ContractReportDeps, opts: { dataDir?: boolean } = {}): Promise<{
  contract: number; apps: ContractReportRow[]; summary: Record<string, number>;
}> {
  const apps = deps.apps().sort((a, b) => a.appId.localeCompare(b.appId));
  const [keys, signals] = await Promise.all([deps.contextKeys().catch(() => []), deps.signals().catch(() => ({} as Record<string, number>))]);
  const dataDir = opts.dataDir && deps.dataDir
    ? new Map((await deps.dataDir(apps.map((a) => ({ appId: a.appId, scope: a.scope, dir: a.dir, sandbox: a.sandbox, ownNamespace: a.ownNamespace, instances: a.instances })))).map((r) => [r.appId, r]))
    : null;
  const rows = apps.map((a): ContractReportRow => {
    const source = core.scanContractSources(a.dir, a.manifest, keys);
    const mine = Object.fromEntries(Object.entries(signals)
      .filter(([k]) => k.endsWith(`|${a.appId}`))
      .map(([k, n]) => [k.split('|')[1]!, n]));
    const row: ContractReportRow = {
      appId: a.appId, name: a.name, scope: a.scope,
      contract: core.contractStatus(a.manifest),
      declares: core.contractDeclarations(a.manifest),
      findings: core.contractFindings(a.manifest),
      source,
      signals: mine,
      readsRawContext: source.some((f) => f.code === 'context-raw'),
    };
    const dd = dataDir?.get(a.appId);
    if (dd) row.dataDir = dd;
    return row;
  });
  const count = (f: (r: ContractReportRow) => boolean) => rows.filter(f).length;
  return {
    contract: core.AURA_CONTRACT,
    apps: rows,
    summary: {
      apps: rows.length,
      onContract: count((r) => r.contract.status === 'current'),
      noContract: count((r) => r.contract.status === 'none'),
      incompatible: count((r) => r.contract.status === 'incompatible'),
      readsRawContext: count((r) => r.readsRawContext),
      undeclaredUse: count((r) => r.findings.length > 0 || r.source.some((s) => s.code !== 'context-raw') || Object.keys(r.signals).some((s) => s.endsWith('undeclared'))),
      ...(dataDir ? { writesOutsideDataDir: count((r) => r.dataDir?.outside === true) } : {}),
    },
  };
}

/** The live report inputs: the registry, running instances, the Context key names, the access report. */
export function liveContractReportDeps(): ContractReportDeps {
  const mgr = core.getAppManager();
  return {
    apps: () => mgr.registry.getAll().map((m) => {
      // The runtime a running instance latched; else the manifest's, else the built-in default (Q18).
      const sandbox = mgr.getAllInstances().find((i) => i.appId === m.id && i.sandbox)?.sandbox ?? m.sandbox ?? 'container';
      const caps = mgr.runtimes.get(sandbox)?.capabilities({});
      const ownNamespace = !!caps && caps.isolation !== 'none' && caps.isolation !== 'ptrace';
      return {
        appId: m.id, name: m.name, scope: String(m.scopeId), dir: m.appDir, sandbox, ownNamespace,
        manifest: m as unknown as ContractReportApp['manifest'],
        instances: mgr.getAllInstances()
          .filter((i) => i.appId === m.id && !i.inPool)
          // A workload whose runtime reports its own writes (`diagnostics.inspectWrites`, 5b-2 D-R).
          .map((i) => ({
            instanceId: i.instanceId,
            ...(mgr.runtimeDiagnosticsOf(i.instanceId)?.inspectWrites ? { inspect: true } : {}),
          })),
      };
    }),
    contextKeys: async () => (await new core.ContextStore().list()).map((e) => e.key),
    signals: async () => {
      const { defaultRedis } = await import('@aura/kv-store');
      const { readAccessReport } = await import('./access/report.ts');
      const { ACCESS_BRIDGE_KEY } = await import('./access/types.ts');
      const out: Record<string, number> = {};
      const add = (field: string, n: number) => { if (field.startsWith('contract|')) out[field] = (out[field] ?? 0) + n; };
      try {
        const redis = defaultRedis();
        if (redis.status === 'ready') {
          const report = await readAccessReport(redis as never, 14, Date.now(), 1);
          for (const d of report.days) for (const [k, n] of Object.entries(d.counters)) add(k, n);
        }
      } catch { /* no report store: pending counters only */ }
      const pending = (globalThis as Record<symbol, { pending?: () => { meta: Record<string, number> } } | undefined>)[ACCESS_BRIDGE_KEY]?.pending?.();
      for (const [k, n] of Object.entries(pending?.meta ?? {})) add(k, n);
      return out;
    },
    dataDir: (apps) => core.dataDirReport(apps, core.liveDataDirDeps((id) => mgr.runtimeDiagnosticsOf(id))),
  };
}
