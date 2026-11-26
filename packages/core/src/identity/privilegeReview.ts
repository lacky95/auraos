/**
 * The privilege review (P5-3, stream A): per installation, how it runs
 * (`runAs`), its app identity, how its last start under that identity went,
 * and every reason it may need more than a non-root, capability-less process
 * ("needs elevated privileges: <reason>"), for the owner's explicit review.
 *
 * Two sources, combined:
 *   - the migration table (`APP_MIGRATION`): the per-app expectations of the
 *     5-apps waves, read from each app's code (stream A notes);
 *   - what the manifest and the runtime say now (`manifestPrivilegeNeeds`):
 *     the Docker socket, a runtime without an enforced identity, privileged
 *     or root sidecars.
 * Pure: the shell gathers the inputs. Nothing secret is in it.
 */
import type { AppRunAs } from './types.js';

export type MigrationWave = 1 | 2 | 3 | 'terminal';
/** What stream A expects for the app in its wave. */
/** `session-host`: not an app identity at all; each instance runs as its user's uid (stream T, D69). */
export type MigrationExpectation = 'convert' | 'review' | 'blocked' | 'session-host';

export interface AppMigrationEntry {
  wave: MigrationWave;
  expect: MigrationExpectation;
  /** Why, in plain words (problem spots and what was checked). */
  note: string;
}

/**
 * The 23 apps of the plan's migration list (stream A, 2026-11-26), from
 * their code. `convert`: nothing in the app needs root, flip after the VM
 * check. `review`: something in the app needs a change first. `blocked`: it
 * needs more than its App Home (5-main, stream H), or the Terminal sessions.
 */
export const APP_MIGRATION: Readonly<Record<string, AppMigrationEntry>> = Object.freeze({
  'com.aura.counter': { wave: 1, expect: 'convert', note: 'writes only /data/counter.json; the e2e canary, flipped first' },
  'com.aura.example': { wave: 1, expect: 'convert', note: 'no writes outside /data; its granted claude is not run by the app' },
  'io.lakner.hello': { wave: 1, expect: 'convert', note: 'prod build; no writes outside /data' },
  'io.lakner.slides.aura': { wave: 1, expect: 'convert', note: 'prod build; no writes outside /data' },
  'io.lakner.example.testproot': { wave: 1, expect: 'convert', note: 'needs the P1 move to the container runtime (PRoot has no enforced identity)' },
  'com.aura.aurashelld': { wave: 1, expect: 'convert', note: 'service; no writes and no subprocesses in its source' },
  'com.aura.nexus': { wave: 1, expect: 'convert', note: 'no writes or subprocesses in the app (installs run in the shell); git knows the account from the generated passwd' },
  'com.aura.settings': { wave: 1, expect: 'convert', note: 'runs neither gh nor claude itself (grep), so the read-only shared home is no problem' },
  'com.aura.registry': { wave: 1, expect: 'convert', note: 'critical: zot storage /data/oci becomes app-owned, config in /tmp, port 4090; validate push and pull before anything else installs; flipped last' },
  'com.aura.console': { wave: 2, expect: 'convert', note: 'astro dev: the dev-cache rows; log in /data/console.log' },
  'io.lakner.projector': { wave: 2, expect: 'convert', note: 'astro dev: the dev-cache rows; SQLite in /data; prisma generate runs in the builder (postinstall)' },
  'io.lakner.callgemini': { wave: 2, expect: 'convert', note: 'astro dev: the dev-cache rows; conversations in /data; dependencies come from the builder' },
  'io.lakner.excalidraw': { wave: 2, expect: 'convert', note: 'astro dev: the dev-cache rows; boards in /data; sidecars keep their image users (canvas 0:0, mcp)' },
  'io.lakner.trilium': { wave: 2, expect: 'convert', note: 'after P1 (sidecars through the OS, no Docker socket); the app only proxies; the sidecar volume keeps its image user' },
  'io.lakner.steelaibrowser': { wave: 2, expect: 'convert', note: 'after P1 (sidecars through the OS, no Docker socket); browse state in /data' },
  'com.aura.docs': { wave: 2, expect: 'review', note: 'serve.mjs builds Next.js into its own source tree at start (.next, .next-staging, next-env.d.ts) and npm-installs fumadocs-site when missing: the build has to move to the builder first' },
  'io.lakner.callgemini.copy': { wave: 2, expect: 'review', note: 'its OpenClaw state is in /data/openclaw (fine), but it patches node_modules/openclaw/dist at every gateway start: that patch has to move to install time first' },
  'com.aura.browser': { wave: 3, expect: 'convert', note: 'its granted claude and code-server keep state in $HOME, which is now its own App Home (5-main, D65); the app runs neither itself (grep): global scope' },
  'com.aura.notepad': { wave: 3, expect: 'convert', note: '$HOME is its own App Home (5-main, D65); the app does not run its granted code-server (grep), so global scope (D72); its notes stay in /data' },
  'io.lakner.improvementboard': { wave: 3, expect: 'convert', note: 'after the D66 P2 patch: logins in its global App Home (aura jump --home app), one config dir per supervisor; its inheritHome supervisors get the same App Home and run as the app' },
  'dev.box': { wave: 3, expect: 'blocked', note: 'App Homes exist now, but its entrypoint still writes /usr/local/bin/devbox (rootfs) and runs npm ci and aura install sdk in the running app at start: the P2 patch (scope user, devbox on PATH from the App Home) plus a builder-provisioning check on the VM first' },
  'io.lakner.terminalx': { wave: 3, expect: 'convert', note: 'after the P2 patch (environmentScope: user): $HOME (.gitconfig) is the owner\'s App Home; container runtime since P1' },
  'com.aura.terminal': { wave: 'terminal', expect: 'session-host', note: 'not an app identity: each Terminal instance is its user\'s session host and runs as that user\'s uid, no capabilities (stream T, D69); root only in a root tab (J.6). Fewer privileges than an app, not more' },
});

/** What the review needs from a manifest (a structural subset of AppManifest). */
export interface PrivilegeManifest {
  id: string;
  tools?: readonly string[];
  runtime?: string;
  services?: ReadonlyArray<{
    name: string; image: string; user?: string; inheritHome?: boolean; privileged?: boolean; capabilities?: readonly string[];
  }>;
}

export interface PrivilegeNeed {
  /** `blocks` an `app` start; `info` is shown for the review only. */
  level: 'blocks' | 'info';
  reason: string;
}

/** What the manifest and the runtime ask for beyond a non-root, capability-less process. */
export function manifestPrivilegeNeeds(
  m: PrivilegeManifest, runtime: { id: string | null; identity: 'none' | 'emulated' | 'enforced' | null }, baseImage: string,
): PrivilegeNeed[] {
  const out: PrivilegeNeed[] = [];
  const tools = m.tools ?? [];
  if (tools.includes('*') || tools.includes('docker')) {
    out.push({ level: 'blocks', reason: 'holds the Docker socket (tools: docker or *): a non-root app can\'t use it; sidecars go through the OS (mode: os, P1)' });
  }
  if (runtime.identity === 'none') {
    out.push({ level: 'blocks', reason: `its runtime (${runtime.id ?? 'unknown'}) can't enforce an app identity: an app start is refused (never run as root instead)` });
  }
  for (const s of m.services ?? []) {
    if (s.privileged) out.push({ level: 'info', reason: `sidecar ${s.name} is privileged (its template's reviewed exception)` });
    if (s.capabilities?.length) out.push({ level: 'info', reason: `sidecar ${s.name} adds capabilities ${s.capabilities.join(', ')}` });
    if (s.image === baseImage && s.inheritHome && !s.user) {
      out.push({ level: 'info', reason: `sidecar ${s.name} (aura-base, inheritHome) runs as the app's identity` });
    } else if (!s.user || /^0(:|$)|^root(:|$)/.test(s.user)) {
      out.push({ level: 'info', reason: `root sidecar ${s.name} (image user${s.user ? ` ${s.user}` : ''}); unchanged` });
    }
  }
  return out;
}

export interface PrivilegeReviewInput {
  appId: string;
  scope: string;
  installationId: string | null;
  /** The recorded runAs; null when there is no installation record. */
  runAs: AppRunAs | null;
  /** The allocated app identity, if any. */
  identity: { uid: number; gid: number } | null;
  needs: PrivilegeNeed[];
  /** Running instances and the uid each runs as (latched at spawn or read on adoption). */
  instances: Array<{ instanceId: string; uid: number | null }>;
  /** The last start under `runAs: app` since the shell started. */
  lastAppStart?: { at: string; ok: boolean; error?: string };
}

export type PrivilegeVerdict = 'app' | 'ready' | 'needs-review' | 'blocked' | 'root';

export interface PrivilegeReviewRow extends PrivilegeReviewInput {
  migration: AppMigrationEntry | null;
  /**
   *   app           runs as its app identity
   *   ready         runs as root; nothing found against `app`: flip it after the VM check
   *   needs-review  something must change first (see `elevated`)
   *   blocked       a manifest/runtime need blocks `app`, or it waits for 5-main
   *   root          runs as root (no record)
   */
  verdict: PrivilegeVerdict;
  /** "needs elevated privileges: <reason>" rows for the owner's review. */
  elevated: string[];
  /** Instances whose actual uid does not match the recorded runAs. */
  mismatched: string[];
}

export interface PrivilegeReview {
  version: 1;
  generatedAt: string;
  rows: PrivilegeReviewRow[];
  summary: Record<PrivilegeVerdict, number>;
}

export function buildPrivilegeReview(inputs: readonly PrivilegeReviewInput[], now: () => number = Date.now): PrivilegeReview {
  const rows = [...inputs].sort((a, b) => a.appId.localeCompare(b.appId)).map((i): PrivilegeReviewRow => {
    const migration = APP_MIGRATION[i.appId] ?? null;
    const elevated = [
      ...i.needs.filter((n) => n.level === 'blocks').map((n) => `needs elevated privileges: ${n.reason}`),
      ...(migration && migration.expect !== 'convert' && migration.expect !== 'session-host' ? [`needs elevated privileges: ${migration.note}`] : []),
    ];
    const sessionHost = migration?.expect === 'session-host';
    const mismatched = i.instances.filter((x) => {
      if (x.uid === null) return false;
      // A session host runs as its user's uid (any user's, never 0 once the owner's home is handed over).
      if (sessionHost) return false;
      return i.runAs === 'app' ? x.uid !== i.identity?.uid : x.uid !== 0;
    }).map((x) => x.instanceId);
    let verdict: PrivilegeVerdict;
    if (i.runAs === 'app' || sessionHost) verdict = 'app';
    else if (i.runAs === null) verdict = 'root';
    else if (i.needs.some((n) => n.level === 'blocks') || migration?.expect === 'blocked') verdict = 'blocked';
    else if (migration?.expect === 'review') verdict = 'needs-review';
    else verdict = 'ready';
    return { ...i, migration, verdict, elevated, mismatched };
  });
  const summary: Record<PrivilegeVerdict, number> = { app: 0, ready: 0, 'needs-review': 0, blocked: 0, root: 0 };
  for (const r of rows) summary[r.verdict]++;
  return { version: 1, generatedAt: new Date(now()).toISOString(), rows, summary };
}

/** Audit actions of the runAs flip (`aura admin apps run-as`). */
export const RUN_AS_AUDIT_ACTIONS = {
  changed: 'app.run-as-changed',
} as const;
