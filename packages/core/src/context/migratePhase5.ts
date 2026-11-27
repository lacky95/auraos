/**
 * The Phase 5 Context migration (stream C, Q7): from "every `env` key to
 * every app, every `file` key mounted at `/run/context`" to "only declared
 * AND granted keys" (context/grantedContext.ts), without losing a value.
 *
 * Once, in kernel init (D78: no Shell, session or request dependency), after
 * a backup of the stored rows (sealed values only, never plaintext):
 *   1. continuity grants: `context.read:<KEY>` for the installations that
 *      read a key today and keep it (Q7: GEMINI_API_KEY for CallGemini and
 *      its copy; their P1 patch declares it);
 *   2. owner keys to the owner's vault (D56): each key is stored in
 *      `context:user:<owner>` for the consumer app (the System Terminal), the
 *      app gets the owner's raw-read grant `credential.read:<KEY>` (audited),
 *      and the system copy is set to `inject: []` for one release (rollback
 *      safety; 5-post deletes it). The Terminal declares the keys, so it
 *      keeps them (Q7);
 *   3. test keys nobody declares get `inject: []`;
 *   4. OS-only keys stay as they are;
 *   5. every installed app's source is scanned (`sourceScan`) for reads of a
 *      Context key it neither declares nor holds: the apps that lose a key.
 * It writes the backup and a report under `<data>/aura/context-migration/`
 * (0700, files 0600) and the audit row `context.migration-recorded`. The
 * report is the marker: a second run changes nothing. Each step applies only
 * where its key and app exist; nothing is deleted.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditInput } from '../auth/AdminAudit.js';
import type { GrantStore } from '../auth/GrantStore.js';
import { appGrantCounts, contextReadPermission, credentialReadPermission, userScope } from '../auth/GrantStore.js';
import { OS_SCOPE } from '../auth/types.js';
import { DEFAULT_OWNER_ID } from '../auth/identityContracts.js';
import type { ContractSourceFinding } from '../contract/sourceScan.js';
import type { ContextEntry, ContextKind, InjectTarget } from './ContextStore.js';
import type { CredentialVault, VaultKv } from './CredentialVault.js';
import { credentialNamespace } from './CredentialVault.js';

/** This release's decisions for the live install (Q7, plan stream C "Migration"). */
export const PHASE5_CONTEXT_MIGRATION = Object.freeze({
  continuity: [{ key: 'GEMINI_API_KEY', apps: ['io.lakner.callgemini', 'io.lakner.callgemini.copy'] }],
  ownerVault: [{ keys: ['LAKNERIO_REGISTRY_USER', 'LAKNERIO_REGISTRY_PASSWORD'], consumer: 'com.aura.terminal' }],
  injectNone: ['HELLO', 'TESTER', 'SUPP'],
  osOnly: ['NEXUS_SRC_LAKNER_IO_PASSWORD'],
} as const);

export const CONTEXT_MIGRATION_AUDIT_ACTION = 'context.migration-recorded';
const REPORT_FILE = 'phase5.json';

export interface ContextMigrationApp {
  appId: string;
  /** The app's install scope (system|global|user). */
  scope: string;
  /** Its installation in that scope (S1: a grant is given to it); null: none, so nothing is granted. */
  installationId: string | null;
  dir: string;
  context: readonly string[];
}

export interface ContextMigrationDeps {
  dataDir: string;
  /** Raw KV for the backup: the stored (sealed) rows. */
  kv(): VaultKv;
  store: {
    list(): Promise<ContextEntry[]>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, kind: ContextKind, inject: InjectTarget[]): Promise<unknown>;
  };
  vault: Pick<CredentialVault, 'store' | 'describe'>;
  grants: Pick<GrantStore, 'get' | 'grant'>;
  apps(): ContextMigrationApp[];
  /** sourceScan of one app against the live key names. */
  scan(app: ContextMigrationApp, keys: readonly string[]): ContractSourceFinding[];
  audit(entry: AuditInput): Promise<unknown>;
  now?: () => Date;
  /** The owner whose vault receives the owner keys; default the owner id. */
  ownerId?: string;
}

export interface ContextMigrationRow {
  key: string;
  kind: ContextKind;
  injectBefore: InjectTarget[];
  injectAfter: InjectTarget[];
  /** Before: `env` reached every app, `file` every app's `/run/context`. */
  reachedBefore: 'every app' | 'no app';
  /** After: the installed apps that declare the key AND hold it (system or the owner's vault). */
  reachesAfter: string[];
  action: 'continuity-grant' | 'owner-vault' | 'inject-none' | 'os-only' | 'unchanged';
  detail?: string;
}

export interface ContextMigrationResult {
  ran: boolean;
  reportFile: string;
  rows: ContextMigrationRow[];
  /** Apps whose source reads a Context key they will not get (sourceScan), by app. */
  losers: Array<{ appId: string; keys: string[]; findings: number }>;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Run the migration once (see the file comment). Throws on a Valkey error; the next boot retries. */
export async function migratePhase5Context(deps: ContextMigrationDeps): Promise<ContextMigrationResult> {
  const dir = join(deps.dataDir, 'aura', 'context-migration');
  const reportFile = join(dir, REPORT_FILE);
  if (existsSync(reportFile)) return { ran: false, reportFile, rows: [], losers: [] };
  const now = (deps.now ?? (() => new Date()))();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const owner = deps.ownerId ?? DEFAULT_OWNER_ID;
  const plan = PHASE5_CONTEXT_MIGRATION;
  const apps = deps.apps();
  const installed = (appId: string) => {
    const a = apps.find((x) => x.appId === appId);
    return a?.installationId ? { appScope: a.scope, installationId: a.installationId } : null;
  };

  // ── backup first: the stored rows, sealed as they are ────────────────────
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const kv = deps.kv();
  const backup: Record<string, Record<string, unknown>> = {};
  try {
    for (const ns of ['context:system', credentialNamespace(owner)]) {
      backup[ns] = {};
      for (const key of await kv.list(ns, { limit: 1000 })) backup[ns][key] = (await kv.get(ns, key))?.value ?? null;
    }
  } finally {
    await kv.close?.().catch(() => undefined);
  }
  const backupFile = join(dir, `backup-${stamp}.json`);
  writeFileSync(backupFile, JSON.stringify({ at: now.toISOString(), note: 'sealed values (Context master key), no plaintext', rows: backup }, null, 2), { mode: 0o600 });

  const entries = await deps.store.list();
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const rows = new Map<string, ContextMigrationRow>(entries.map((e) => [e.key, {
    key: e.key, kind: e.kind, injectBefore: [...e.inject], injectAfter: [...e.inject],
    reachedBefore: e.inject.length ? 'every app' : 'no app', reachesAfter: [], action: 'unchanged',
  }]));
  const by = { kind: 'system' } as const;

  // 1. continuity grants
  for (const c of plan.continuity) {
    const row = rows.get(c.key);
    if (!row) continue;
    const granted: string[] = [];
    for (const appId of c.apps) {
      const pin = installed(appId);
      if (!pin) continue;
      await deps.grants.grant({ kind: 'app', id: appId }, contextReadPermission(c.key), { by, ...pin });
      granted.push(appId);
    }
    row.action = 'continuity-grant';
    row.detail = granted.length ? `context.read:${c.key} granted to ${granted.join(', ')}` : 'no such installation';
  }

  // 2. owner keys to the owner's vault, with the consumer's raw-read grant
  for (const v of plan.ownerVault) {
    const pin = installed(v.consumer);
    for (const key of v.keys) {
      const row = rows.get(key);
      const entry = byKey.get(key);
      if (!row || !entry) continue;
      row.action = 'owner-vault';
      if (!(await deps.vault.describe(owner, key))) {
        const value = await deps.store.get(key);
        if (value === null || value.length === 0) { row.detail = 'no value: not moved'; continue; }
        await deps.vault.store(owner, key, value, { consumer: v.consumer, label: 'moved from the system Context (Phase 5)' });
        row.detail = `moved to ${owner}'s vault`;
      } else {
        row.detail = `${owner}'s vault already holds it: kept`;
      }
      if (pin) {
        await deps.grants.grant({ kind: 'app', id: v.consumer }, credentialReadPermission(key), { by, scope: userScope(owner), ...pin });
        await deps.audit({
          by, action: 'vault.read-granted', target: `vault:${key}`, outcome: 'ok',
          detail: { name: key, app: v.consumer, user: owner, via: 'phase5-migration' },
        }).catch(() => undefined);
        row.detail += `; credential.read:${key} for ${v.consumer}`;
      }
      if (entry.inject.length) {
        const value = await deps.store.get(key);
        if (value !== null) await deps.store.set(key, value, entry.kind, []);
        row.injectAfter = [];
      }
    }
  }

  // 3. test keys: injected nowhere
  for (const key of plan.injectNone) {
    const row = rows.get(key);
    const entry = byKey.get(key);
    if (!row || !entry) continue;
    row.action = 'inject-none';
    if (entry.inject.length) {
      const value = await deps.store.get(key);
      if (value !== null) await deps.store.set(key, value, entry.kind, []);
      row.injectAfter = [];
    }
  }
  // 4. OS-only keys: reported
  for (const key of plan.osOnly) {
    const row = rows.get(key);
    if (row) { row.action = 'os-only'; row.detail = 'stays OS-only'; }
  }

  // Who gets each key now; and 5. who reads one it won't get (sourceScan).
  const keys = [...rows.keys()];
  const losers: ContextMigrationResult['losers'] = [];
  for (const app of apps) {
    const holds = new Set<string>();
    for (const key of app.context) {
      const row = rows.get(key);
      if (!row) continue;
      const current = { scope: app.scope, installationId: app.installationId };
      const system = appGrantCounts(await deps.grants.get({ kind: 'app', id: app.appId }, contextReadPermission(key), OS_SCOPE), current)
        && row.injectAfter.includes('env');
      const vault = appGrantCounts(await deps.grants.get({ kind: 'app', id: app.appId }, credentialReadPermission(key), userScope(owner)), current)
        && !!(await deps.vault.describe(owner, key));
      if (system || vault) { holds.add(key); row.reachesAfter.push(app.appId); }
    }
    let findings: ContractSourceFinding[] = [];
    try { findings = deps.scan(app, keys); } catch { /* an unreadable tree: no scan */ }
    // A declared key it does not hold, and an env or raw read of one it does not declare.
    const lost = new Set<string>(app.context.filter((k) => rows.has(k) && !holds.has(k)));
    for (const f of findings) {
      if (f.code !== 'context-raw') continue;
      const named = keys.find((k) => f.message.includes(` ${k} `)) ?? (f.message.includes('/run/context') ? '/run/context' : null);
      if (named && !holds.has(named)) lost.add(named);
    }
    if (lost.size) losers.push({ appId: app.appId, keys: [...lost].sort(), findings: findings.length });
  }
  for (const row of rows.values()) row.reachesAfter.sort();

  const out = [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
  writeFileSync(reportFile, JSON.stringify({
    at: now.toISOString(), backup: backupFile, owner,
    rule: 'An app gets a Context key only when it declares it (context[]) and holds the grant (context.read:<KEY>, or credential.read:<KEY> in its user\'s vault). No /run/context for apps.',
    rows: out, losers,
    unchangedInject: out.filter((r) => sameSet(r.injectBefore, r.injectAfter)).map((r) => r.key),
  }, null, 2), { mode: 0o600 });
  await deps.audit({
    by, action: CONTEXT_MIGRATION_AUDIT_ACTION, outcome: 'ok',
    detail: {
      report: reportFile, keys: out.length,
      continuity: out.filter((r) => r.action === 'continuity-grant').length,
      ownerVault: out.filter((r) => r.action === 'owner-vault').length,
      injectNone: out.filter((r) => r.action === 'inject-none').length,
      losers: losers.length,
    },
  }).catch(() => undefined);
  return { ran: true, reportFile, rows: out, losers };
}
