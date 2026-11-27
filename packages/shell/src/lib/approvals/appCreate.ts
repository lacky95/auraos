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

/**
 * Exactly what the approval binds (its `payloadHash`). Built the same on the request and on the retry,
 * from the validated request: the files digest, the level the server derived from the manifest (owner
 * decision 12: bound to the validated plan), the target, and the requester's summary and plan digests.
 */
export function createPayload(t: CreateTarget, level: ApprovalLevel): Record<string, unknown> {
  return {
    op: t.replaces ? `${t.via === 'clone' ? 'clone-app' : 'scaffold'}.overwrite` : 'app.create',
    via: t.via, appId: t.appId, scope: t.scope, target: t.dest, filesDigest: t.files.digest, level,
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
  const level: ApprovalLevel = risks.length ? 'fresh' : 'session';
  return {
    action: t.replaces ? 'admin.change' : 'app.create',
    level,
    payload: createPayload(t, level),
    title: t.replaces ? `Overwrite ${t.appId} with ${what}` : `Create the app ${m.name} (${t.appId})${t.via === 'clone' ? ` as ${what}` : ''}`,
    details: createDetails(m, t),
    ...(risks.length ? { highRisk: risks } : {}),
    ...(explanation ? { explanation } : {}),
  };
}

/**
 * Owner decision 12: the approved request is revalidated before it executes. `again` is the request
 * rebuilt from a full second validation (manifest parse, id, duplicates, level, files digest, target
 * state) right before the first write; null when it is the same decision, else why not.
 */
export function changedSinceApproval(approved: AdminRequest, again: AdminRequest): string | null {
  if (again.action !== approved.action) return `it is now ${again.action === 'admin.change' ? 'an overwrite' : 'a new app'}`;
  if (again.level !== approved.level) return `its level is now ${again.level}`;
  if (core.payloadHash(again.payload) !== core.payloadHash(approved.payload)) return 'its files, target or summary changed';
  return null;
}

/** The answer when revalidation before execution fails: nothing was written. */
export const revalidationRefusal = (why: string): InputRefusal => ({
  status: 409,
  body: {
    error: 'changed-since-approval', category: 'conflict',
    message: `The approved request no longer holds (${why}); nothing was written.`,
    hint: 'Send the request again: the owner decides on what it is now.',
  },
});

// ── the scaffold request, validated as a whole (owner decision 12) ──────────

export const CREATE_SCOPES = ['system', 'global', 'user'] as const;
export type CreateScope = (typeof CREATE_SCOPES)[number];
const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
/** Scaffolding is tiny (the template is ~10 files, ~30 KB): a 1 MB ceiling catches misuse. */
export const SCAFFOLD_MAX_BYTES = 1_000_000;

/** What validation reads of the world: the scope's apps directory and whether a path exists. */
export interface ScaffoldEnv {
  appsDir(scope: CreateScope): string | null;
  exists(path: string): boolean;
}

export interface ValidScaffold {
  appId: string;
  scope: CreateScope;
  appsDir: string;
  dest: string;
  files: CreateFile[];
  replacing: boolean;
  manifest: AppManifest;
  target: CreateTarget;
  /** The owner-action request this validated request asks for. */
  request: AdminRequest;
}

const refuse = (status: number, body: Record<string, unknown>): InputRefusal => ({ status, body });

/**
 * The whole validation of a scaffold request, before the owner is asked and again before it executes:
 * id, files, size, scope, every path, duplicate targets, summary and plan, the manifest (parse, schema,
 * id), the target's state (exists, overwrite, system scope), and the request it makes (action, level,
 * payload with the files digest). Pure but for `env`.
 */
export function validateScaffold(body: Record<string, unknown>, env: ScaffoldEnv): ValidScaffold | InputRefusal {
  const appId = body['appId'];
  const files = body['files'];
  const rawScope = body['scope'];
  const scope: CreateScope = typeof rawScope === 'string' && (CREATE_SCOPES as readonly string[]).includes(rawScope) ? rawScope as CreateScope : 'user';
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    return refuse(400, {
      error: 'invalid-app-id', category: !appId ? 'missing-input' : 'invalid-input',
      message: `appId must match reverse-domain notation (got ${JSON.stringify(appId)}).`,
      missing: [{ input: 'appId', kind: 'field', expects: 'reverse-domain id, e.g. com.example.notes' }],
    });
  }
  if (!Array.isArray(files) || files.length === 0) {
    return refuse(400, {
      error: 'no-files', category: 'missing-input', message: 'files[] is required and must be non-empty.',
      missing: [{ input: 'files', kind: 'field', expects: 'the rendered template: [{relPath, content, mode?}]' }],
    });
  }
  const totalBytes = files.reduce((n: number, f) => n + (typeof (f as CreateFile)?.content === 'string' ? (f as CreateFile).content.length : 0), 0);
  if (totalBytes > SCAFFOLD_MAX_BYTES) return refuse(413, { error: 'payload-too-large', category: 'invalid-input', bytes: totalBytes });
  const appsDir = env.appsDir(scope);
  if (!appsDir) {
    return refuse(400, { error: 'unknown-scope', category: 'invalid-input', message: `Unknown scope '${scope}'. Expected one of: ${CREATE_SCOPES.join(', ')}.` });
  }
  const dest = join(appsDir, appId);
  // Every file's resolved path stays under the app's own directory: no `..`, no absolute path, no
  // manifest dropped into a sibling app.
  for (const f of files as CreateFile[]) {
    if (typeof f?.relPath !== 'string' || typeof f.content !== 'string') {
      return refuse(400, { error: 'malformed-file', category: 'invalid-input', file: String(f?.relPath) });
    }
    if (f.relPath.startsWith('/') || f.relPath.includes('\0')) return refuse(400, { error: 'unsafe-path', category: 'invalid-input', file: f.relPath });
    const resolved = posix.normalize(join(dest, f.relPath));
    if (!resolved.startsWith(`${dest}/`) && resolved !== dest) {
      return refuse(400, { error: 'path-escape', category: 'invalid-input', file: f.relPath, resolved });
    }
  }
  const list = files as CreateFile[];
  const dup = duplicateFile(list);
  if (dup !== null) return refuse(422, { error: 'duplicate-file', category: 'invalid-input', file: dup, message: `files[] names ${dup} twice.` });
  // AF1: files that would make the install or git run payload code in the shell, refused before the owner is asked.
  const refusedFiles = core.refusedScaffoldFiles(list);
  if (refusedFiles.length) {
    return refuse(400, {
      error: 'refused-file', category: 'invalid-request',
      message: `The scaffold payload contains ${refusedFiles.length === 1 ? 'a file' : 'files'} the shell does not install: ${refusedFiles.map((r) => r.file).join(', ')}. Nothing was written.`,
      hint: 'Send the files `aura dev new` renders; add install settings, hooks or non-registry dependencies after creation, inside the app.',
      details: { refused: refusedFiles },
    });
  }
  const inputs = checkCreateInputs(body['summary'], body['plan']);
  if (inputs) return inputs;
  const parsed = manifestFromFiles(list, appId);
  if ('status' in parsed) return parsed;
  const exists = env.exists(dest);
  if (exists && body['force'] !== true) {
    return refuse(409, { error: 'exists', category: 'conflict', message: `${dest} already exists. Pass force=true to overwrite.` });
  }
  const replacing = exists;
  // A built-in app's code is the AuraOS repo's: never overwritten by a scaffold (D1).
  if (replacing && scope === 'system') {
    return refuse(409, { error: 'system-app', message: `${appId} is in the system scope (the AuraOS repo): a scaffold does not overwrite it. Use --scope user.` });
  }
  const target: CreateTarget = {
    via: 'scaffold', appId, scope, dest, replaces: replacing,
    files: { digest: filesDigest(list), count: list.length, bytes: totalBytes },
    ...(body['summary'] !== undefined ? { summary: body['summary'] as string } : {}),
    ...(body['plan'] !== undefined ? { plan: body['plan'] } : {}),
  };
  return { appId, scope, appsDir, dest, files: list, replacing, manifest: parsed.manifest, target, request: createRequest(parsed.manifest, target) };
}
