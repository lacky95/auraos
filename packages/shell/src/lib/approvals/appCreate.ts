/**
 * D109 AF2: creating an app is the owner's decision (`app.create`, forced,
 * D102). `aura dev new` (`/api/admin/scaffold`) and `aura dev clone`
 * (`/api/admin/clone-app`) ask for it on every new app from a sandbox: the
 * System Terminal by a human or an agent, with or without `--agent` (D13: the
 * server cannot tell them apart), and Settings. The owner's desktop session
 * and the host operator act directly (`ownerAction`, admin.ts).
 * Overwriting an existing app stays `admin.change` (its `*.overwrite`
 * operation) with the same facts and binding.
 *
 * What the owner sees is read by the server from the manifest that will
 * actually be written (the `files` payload, or the staged clone), never from
 * the requester's wording:
 *   - id, name, version, scope, target directory, shape, runtime;
 *   - the tools, permissions, sidecars and Context keys it declares, and the
 *     high-risk review of a Nexus install (display.ts `installRisks`); any
 *     high-risk item (docker or every tool, privileged sidecars, …) makes it
 *     `fresh`: a declaration never hands over the Docker socket or another
 *     privileged resource without the owner's password (owner, D109);
 *   - the file count, bytes and digest, and what the route then does.
 * The requester's summary (Markdown, at most 8 KiB) goes in `explanation`,
 * shown apart from the facts and labelled as unchecked.
 *
 * Binding: the payload carries the digest of the files, the requester's
 * summary and plan digests, the scope and the target, so a retry with any
 * other file, summary or plan is refused (`mismatch`); the approval is the
 * requester's and single use, like every approval.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import * as core from '@aura/core';
import type { AppManifest, ApprovalLevel, ApprovalRisk } from '@aura/core';
import type { AdminRequest } from './admin.ts';
import { EXPLANATION_MAX_BYTES, installRisks, requesterExplanation } from './display.ts';

/** One file of a scaffold payload. */
export interface CreateFile { relPath: string; content: string; mode?: number }

/** An input the caller has to fix (D105 body, D109 AF4 categories). */
export interface InputRefusal { status: number; body: Record<string, unknown> }

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

const MANIFEST = 'app.manifest.json';

/** The path a payload file lands at, relative to the app directory. */
export const landingPath = (relPath: string): string => posix.normalize(relPath).replace(/^(\.\/)+/, '');

/**
 * Two entries for the same file: the later one would be written over the
 * earlier, so the server could read one manifest and write another. Refused.
 */
export function duplicateFile(files: readonly CreateFile[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    const p = landingPath(f.relPath);
    if (seen.has(p)) return f.relPath;
    seen.add(p);
  }
  return null;
}

/** SHA-256 over every file's landing path, mode and content, in path order. */
export function filesDigest(files: readonly CreateFile[]): string {
  const rows = files.map((f) => [landingPath(f.relPath), f.mode ?? null, sha256(f.content)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(rows));
}

/**
 * SHA-256 of a staged tree (a clone), with its manifest's `originId` left
 * out: a clone gets a fresh one on every staging, and the retry must hash
 * the same. Symlinks count by their target; only the executable bit of a mode.
 */
export function treeDigest(dir: string): { digest: string; fileCount: number; bytes: number } {
  const rows: Array<[string, string, string]> = [];
  let bytes = 0;
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) rows.push([r, 'l', sha256(readlinkSync(join(dir, r)))]);
      else if (st.isFile()) {
        let data: Buffer = readFileSync(join(dir, r));
        bytes += data.length;
        if (r === MANIFEST) {
          try {
            const m = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
            delete m['originId'];
            data = Buffer.from(JSON.stringify(m));
          } catch { /* unparsable: hashed as is, and refused by the manifest check */ }
        }
        rows.push([r, st.mode & 0o111 ? 'x' : 'f', sha256(data)]);
      }
    }
  };
  walk('');
  return { digest: sha256(JSON.stringify(rows)), fileCount: rows.length, bytes };
}

const invalidManifest = (message: string, issues?: string[]): InputRefusal => ({
  status: 422,
  body: {
    error: 'invalid-manifest', category: 'invalid-input', message,
    missing: [{ input: MANIFEST, kind: 'file', expects: 'a valid app manifest whose id is the app id (aura dev validate)' }],
    ...(issues?.length ? { details: issues } : {}),
  },
});

function checkManifest(parsed: unknown, appId: string): { manifest: AppManifest } | InputRefusal {
  const r = core.AppManifestSchema.safeParse(parsed);
  if (!r.success) {
    return invalidManifest('app.manifest.json does not pass the manifest schema.',
      r.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`));
  }
  if (r.data.id !== appId) return invalidManifest(`app.manifest.json names the id ${r.data.id}, not ${appId}.`);
  return { manifest: r.data };
}

/** The manifest a scaffold payload writes, parsed and checked by the server. */
export function manifestFromFiles(files: readonly CreateFile[], appId: string): { manifest: AppManifest } | InputRefusal {
  const entry = files.find((f) => landingPath(f.relPath) === MANIFEST);
  if (!entry) {
    return {
      status: 422,
      body: {
        error: 'missing-manifest', category: 'missing-input', message: 'files[] has no app.manifest.json at the app root.',
        missing: [{ input: MANIFEST, kind: 'file', expects: 'the app manifest at the app root' }],
      },
    };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(entry.content); }
  catch (err) { return invalidManifest(`app.manifest.json is not valid JSON: ${(err as Error).message}`); }
  return checkManifest(parsed, appId);
}

/** The manifest a staged clone writes. */
export function manifestFromDir(dir: string, appId: string): { manifest: AppManifest } | InputRefusal {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')); }
  catch (err) { return invalidManifest(`the copy's app.manifest.json cannot be read: ${(err as Error).message}`); }
  return checkManifest(parsed, appId);
}

/** The requester's summary and plan, checked: the summary a string of at most 8 KiB. */
export function checkCreateInputs(summary: unknown, plan: unknown): InputRefusal | null {
  if (summary !== undefined && typeof summary !== 'string') {
    return {
      status: 400,
      body: {
        error: 'invalid-summary', category: 'invalid-input', message: 'summary must be a string (Markdown).',
        missing: [{ input: 'summary', kind: 'field', expects: `Markdown text of at most ${EXPLANATION_MAX_BYTES} bytes` }],
      },
    };
  }
  if (typeof summary === 'string' && Buffer.byteLength(summary, 'utf8') > EXPLANATION_MAX_BYTES) {
    return {
      status: 413,
      body: {
        error: 'summary-too-large', category: 'invalid-input',
        message: `summary is ${Buffer.byteLength(summary, 'utf8')} bytes; at most ${EXPLANATION_MAX_BYTES} are accepted.`,
        missing: [{ input: 'summary', kind: 'field', expects: `Markdown text of at most ${EXPLANATION_MAX_BYTES} bytes` }],
      },
    };
  }
  if (plan !== undefined && (plan === null || typeof plan !== 'object' || Array.isArray(plan))) {
    return {
      status: 400,
      body: {
        error: 'invalid-plan', category: 'invalid-input', message: 'plan must be a JSON object.',
        missing: [{ input: 'plan', kind: 'field', expects: 'a JSON object (the creation plan, D109)' }],
      },
    };
  }
  return null;
}

/** One new app (or the overwrite of one), as the route validated it. */
export interface CreateTarget {
  via: 'scaffold' | 'clone';
  appId: string;
  scope: string;
  /** The app directory it is written to. */
  dest: string;
  /** It overwrites an existing app: `admin.change`, else `app.create`. */
  replaces: boolean;
  files: { digest: string; count: number; bytes: number };
  source?: { appId: string; scope: string };
  withData?: boolean;
  /** The requester's summary (Markdown) and plan, both bound by digest. */
  summary?: string;
  plan?: unknown;
}

/** Exactly what the approval binds (its `payloadHash`). Built the same on the request and on the retry. */
export function createPayload(t: CreateTarget): Record<string, unknown> {
  return {
    op: t.replaces ? `${t.via === 'clone' ? 'clone-app' : 'scaffold'}.overwrite` : 'app.create',
    via: t.via, appId: t.appId, scope: t.scope, target: t.dest, filesDigest: t.files.digest,
    ...(t.source ? { sourceAppId: t.source.appId, sourceScope: t.source.scope } : {}),
    ...(t.withData ? { withData: true } : {}),
    ...(t.summary !== undefined ? { summaryDigest: sha256(t.summary) } : {}),
    ...(t.plan !== undefined ? { planDigest: core.payloadHash(t.plan) } : {}),
  };
}

/** Every tool the app and its sidecar templates declare. */
const declaredTools = (m: AppManifest): string[] =>
  [...new Set([...m.tools, ...(m.services ?? []).flatMap((s) => (s as { tools?: string[] }).tools ?? [])])].sort();

/**
 * The high-risk review of what the manifest declares (a new install's, without
 * the parts this approval does not grant: Context keys, root execution).
 */
export function createRisks(m: AppManifest): ApprovalRisk[] {
  return installRisks(
    { appId: m.id, tools: declaredTools(m), permissions: [...new Set(m.permissions)].sort(), context: [], execution: null, exposure: core.installExposure(m) },
    core.computePermissionDiff(null, m),
  );
}

/** Any high-risk declaration needs the owner's password (D109, Q3 a). */
export const createLevel = (m: AppManifest): ApprovalLevel => (createRisks(m).length > 0 ? 'fresh' : 'session');

const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');

/** The facts the dialog shows, from the manifest being written. */
export function createDetails(m: AppManifest, t: CreateTarget): string[] {
  const shape = [
    m.componentType === 'service' ? 'a service (no window)' : 'an app with a window',
    m.backgroundService ? 'keeps running in the background' : '',
    m.autoStart ? 'starts with AuraOS' : '',
    `instance mode ${m.instanceMode}`,
  ].filter(Boolean).join(', ');
  const sidecars = (m.services ?? []).map((s) => `${s.name} (${s.image})`);
  const out = [
    `App: ${m.id}, "${m.name}" ${m.version}`,
    `Scope: ${t.scope}, written to ${t.dest}`,
    ...(t.source ? [`Copied from: ${t.source.appId} (${t.source.scope} scope)${t.withData ? ', with that app\'s data' : ''}`] : []),
    `Shape: ${shape}`,
    `Runtime: ${m.sandbox ?? 'the Runtime Settings default'}`,
    `Tools it declares: ${list(declaredTools(m))}`,
    `Permissions it declares: ${list(m.permissions)}`,
    ...(sidecars.length ? [`Sidecars: ${sidecars.join(', ')}`] : []),
    ...(m.context.length ? [`Context keys it declares (not granted by this approval): ${list(m.context)}`] : []),
    ...(m.execution ? ['It requests root execution (runAs: root): not granted by this approval.'] : []),
    `Files: ${t.files.count} (${t.files.bytes} bytes), digest ${t.files.digest.slice(0, 16)}…`,
    t.via === 'clone'
      ? 'AuraOS copies the source app\'s files under the new id and registers the installation.'
      : 'AuraOS writes these files, makes a git repository, registers the installation and installs its dependencies.',
    'Approving grants it what it declares above and nothing else: no permission the owner grants separately, no Context secret, no root execution.',
  ];
  if (t.replaces) {
    out.push('The code that runs under that app id is replaced.',
      'Its grants are revoked; its files and data go to trash (data a kept uninstall left is set aside for that app).');
  }
  return out;
}

/** The owner-action request of one create (or overwrite), for `ownerAction`. */
export function createRequest(m: AppManifest, t: CreateTarget): AdminRequest {
  const what = t.via === 'clone' ? `a copy of ${t.source?.appId ?? 'another app'}` : 'a new scaffold';
  const risks = createRisks(m);
  const explanation = requesterExplanation(t.summary);
  return {
    action: t.replaces ? 'admin.change' : 'app.create',
    level: risks.length ? 'fresh' : 'session',
    payload: createPayload(t),
    title: t.replaces ? `Overwrite ${t.appId} with ${what}` : `Create the app ${m.name} (${t.appId})${t.via === 'clone' ? ` as ${what}` : ''}`,
    details: createDetails(m, t),
    ...(risks.length ? { highRisk: risks } : {}),
    ...(explanation ? { explanation } : {}),
  };
}
