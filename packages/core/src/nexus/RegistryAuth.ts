/**
 * Logins for private OCI sources — a customer adds "your registry + username +
 * password" and every `oras` call to that registry carries the login.
 *
 *   • The password lives in Aura Context as an OS-only secret
 *     (`NEXUS_SRC_<NAME>_PASSWORD`, `kind: secret`, `inject: []` — sealed in
 *     Valkey, handed to no app). The source entry in `os/nexus/sources`, which
 *     any app can read, keeps only `auth: { type, username, secret }` — the
 *     secret's KEY, never the value. Same pattern as `aura nexus store login`.
 *   • A login is BOUND to its registry host: the sealed value is
 *     `{"host": "<registry host>", "password": "…"}`, and it is only used for
 *     a source whose URL still has that host, under a `NEXUS_SRC_*` key. The
 *     sources config is writable through the Nexus API, so without the binding
 *     pointing a source at another host (or at another secret such as
 *     GITHUB_TOKEN) would send the password there.
 *   • `loadRegistryCredentials()` decrypts the logins into memory (per registry
 *     host) whenever the sources are loaded or changed; the `oras` calls are
 *     synchronous and can't wait for Valkey.
 *   • `orasSync()` is the one way Nexus runs `oras` against a registry: it finds
 *     the target host in the arguments, writes a short-lived docker-style auth
 *     file (0600, own temp dir) when that host has a login, passes it with
 *     `--registry-config`, and deletes it afterwards. The password is never in
 *     argv, the environment or the sources config. A rejected login becomes an
 *     `OrasAuthError` with a readable message instead of a bare exit code.
 */

import { execFile, execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextStore } from '../context/ContextStore.js';
import { orasHostFromUrl } from './RegistryConfig.js';
import type { OciSource, SourcesConfig } from './SourcesConfig.js';

export interface RegistryLogin {
  username: string;
  password: string;
}

/** The login as kept on a source entry: no password, only where it is sealed. */
export interface SourceAuth {
  type:     'basic';
  username: string;
  /** Aura Context key holding the password (`NEXUS_SRC_<NAME>_PASSWORD`). */
  secret:   string;
}

/** Context key for a source's password. Names are free-form; keys are not. */
export function secretKeyFor(sourceName: string): string {
  const slug = sourceName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SOURCE';
  return `NEXUS_SRC_${slug}_PASSWORD`;
}

/** Only keys this module writes may back a source login. */
export const SOURCE_SECRET_PATTERN = /^NEXUS_SRC_[A-Z0-9_]+_PASSWORD$/;

/** The sealed value: the password together with the host it belongs to. */
export function sealedLoginValue(host: string, password: string): string {
  return JSON.stringify({ v: 1, host, password });
}

/** The password, if `raw` is a login sealed for exactly this host. */
export function passwordForHost(raw: string | null, host: string): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { v?: unknown; host?: unknown; password?: unknown };
    return v.v === 1 && v.host === host && typeof v.password === 'string' ? v.password : null;
  } catch { return null; }
}

// ─── Store / remove ─────────────────────────────────────────────────────

/** Seal the password (OS-only, bound to the registry host of `url`) and
 *  return the `auth` block for the source entry. */
export async function saveRegistryLogin(dataDir: string, sourceName: string, url: string, login: RegistryLogin): Promise<SourceAuth> {
  const secret = secretKeyFor(sourceName);
  await new ContextStore(dataDir).set(secret, sealedLoginValue(orasHostFromUrl(url), login.password), 'secret', []);
  return { type: 'basic', username: login.username, secret };
}

export async function deleteRegistryLogin(dataDir: string, auth: SourceAuth | undefined): Promise<void> {
  if (!auth?.secret) return;
  await new ContextStore(dataDir).del(auth.secret).catch(() => false);
}

// ─── In-memory logins per host ──────────────────────────────────────────

const KEY = Symbol.for('aura.nexus.registryLogins');
type G = typeof globalThis & { [KEY]?: Map<string, RegistryLogin> };
const logins = (): Map<string, RegistryLogin> => ((globalThis as G)[KEY] ??= new Map());

/**
 * Decrypt the logins of every OCI source that has one, keyed by registry host.
 * Replaces the previous set. A source whose secret is missing is skipped (its
 * calls go out anonymously and fail with a clear OrasAuthError).
 */
export async function loadRegistryCredentials(dataDir: string, cfg: SourcesConfig): Promise<void> {
  const next = new Map<string, RegistryLogin>();
  const store = new ContextStore(dataDir);
  for (const s of cfg.sources) {
    if (s.kind !== 'oci' || !s.auth || !SOURCE_SECRET_PATTERN.test(s.auth.secret)) continue;
    const host = orasHostFromUrl(s.url);
    try {
      const login = await sealedSourceLogin(s, (key) => store.get(key));
      if (login) next.set(host, login);
      else console.warn(`[nexus] the login of source '${s.name}' is not for ${host} — not used (enter it again)`);
    } catch (err) {
      console.warn(`[nexus] could not read the login for source '${s.name}': ${(err as Error).message}`);
    }
  }
  const m = logins();
  m.clear();
  for (const [h, l] of next) m.set(h, l);
}

/** The login of one OCI source: its sealed password, only when sealed for the
 *  source's own registry host (and under a key this module writes). */
async function sealedSourceLogin(s: OciSource, secret: (key: string) => Promise<string | null>): Promise<RegistryLogin | null> {
  if (!s.auth || !SOURCE_SECRET_PATTERN.test(s.auth.secret)) return null;
  const password = passwordForHost(await secret(s.auth.secret), orasHostFromUrl(s.url));
  return password === null ? null : { username: s.auth.username, password };
}

/** True when a login is loaded for this registry host. */
export function hasRegistryLogin(host: string): boolean {
  return logins().has(host);
}

// ─── Running oras ───────────────────────────────────────────────────────

/** A registry rejected the login (or wants one). */
export class OrasAuthError extends Error {
  /**
   * `rejected`  — the login was not accepted (wrong username / password)
   * `missing`   — the registry wants a login and the source has none
   * `forbidden` — the login works but may not do this (e.g. a read-only
   *               customer login trying to publish)
   */
  constructor(readonly host: string, detail: string, readonly reason: 'rejected' | 'missing' | 'forbidden' = 'rejected') {
    super(reason === 'forbidden'
      ? `${host} refused this for that login — it may not have the right (customers usually may only read) (${detail})`
      : reason === 'missing'
        ? `${host} needs a login — add the username and password to that source (${detail})`
        : `login to ${host} failed — check the username and password of that source (${detail})`);
    this.name = 'OrasAuthError';
  }
}

const AUTH_FAILURE = /\b401\b|unauthori[sz]ed|authentication required|denied: requested access|basic credential not found|invalid username\/password/i;
const FORBIDDEN = /\b403\b|\bforbidden\b|denied: requested access/i;

/** Is this oras error output a rejected / missing login (or a refused action)? */
export function isAuthFailure(output: string): boolean {
  return AUTH_FAILURE.test(output) || FORBIDDEN.test(output);
}

/** Why oras was turned away: no / wrong login, or a login without the right. */
export function authFailureReason(output: string, hadLogin: boolean): 'rejected' | 'missing' | 'forbidden' {
  if (!hadLogin) return 'missing';
  return FORBIDDEN.test(output) && !/\b401\b|unauthori[sz]ed|authentication required|basic credential not found|invalid username/i.test(output)
    ? 'forbidden' : 'rejected';
}

/**
 * The registry host an oras invocation talks to: the first positional after
 * the subcommand (`repo ls <host>`, `pull <host/repo:tag>`, `manifest fetch
 * <ref>` …), cut at the first `/`.
 */
export function orasTargetHost(args: string[]): string | null {
  const two = new Set(['repo', 'manifest', 'blob']);
  const positional = args.filter((a) => !a.startsWith('-'));
  const target = two.has(positional[0] ?? '') ? positional[2] : positional[1];
  if (!target) return null;
  return target.split('/')[0]!.replace(/@sha256:.*$/, '') || null;
}

/** The docker-style auth file content oras reads with --registry-config. */
export function authFileContent(host: string, login: RegistryLogin): string {
  const auth = Buffer.from(`${login.username}:${login.password}`, 'utf-8').toString('base64');
  return JSON.stringify({ auths: { [host]: { auth } } });
}

// ─── Sidecar image pulls ────────────────────────────────────────────────

/**
 * The registry host of a docker image reference: the first path component
 * when it looks like a host (has a `.` or `:`, or is `localhost`), else
 * Docker Hub (`docker.io`), as the docker CLI reads it.
 */
export function imageRegistryHost(image: string): string {
  const slash = image.indexOf('/');
  if (slash < 0) return 'docker.io';
  const first = image.slice(0, slash);
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io';
}

/**
 * The login an app's sidecar image may be pulled with (SidecarManager): the
 * one of the OCI source the app was installed from (its install record's
 * `sourceName`), and only when the image lives on that source's own registry
 * host. An app never borrows another source's login; no source, a non-OCI
 * source or another host → null (the pull goes out anonymously). Read fresh
 * from the sources config and the sealed secret on every call, so a login
 * added or removed with `aura nexus registry login|logout` counts at once.
 */
export async function appPullLogin(
  installSource: string | undefined, imageHost: string,
  read: { sources(): Promise<SourcesConfig>; secret(key: string): Promise<string | null> },
): Promise<RegistryLogin | null> {
  if (!installSource) return null;
  const s = (await read.sources()).sources.find((x): x is OciSource => x.kind === 'oci' && x.name === installSource);
  if (!s || orasHostFromUrl(s.url) !== imageHost) return null;
  return sealedSourceLogin(s, read.secret);
}

/**
 * A docker-style config dir holding only `host`'s login (dir 0700 from
 * mkdtemp, `config.json` 0600), for `docker --config <dir>` or oras'
 * `--registry-config <file>`. The caller calls `cleanup()` in a finally.
 */
export function writeAuthConfig(host: string, login: RegistryLogin): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'aura-regauth-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const file = join(dir, 'config.json');
  try { writeFileSync(file, authFileContent(host, login), { mode: 0o600 }); }
  catch (err) { cleanup(); throw err; }
  return { dir, file, cleanup };
}

/** `text` with the login's password (plain and inside the base64 auth) masked —
 *  for registry output that ends up in an error or a log. */
export function redactLogin(text: string, login: RegistryLogin | null): string {
  if (!login) return text;
  let out = text;
  for (const secret of [login.password, Buffer.from(`${login.username}:${login.password}`, 'utf-8').toString('base64')]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

// ─── Pushing Aura artifacts ─────────────────────────────────────────────

/** Where an Aura artifact type is kept when the registry refuses it as the
 *  manifest's artifactType / config media type (see orasPushArtifact). */
export const ARTIFACT_TYPE_ANNOTATION = 'app.aura.artifactType';
const OCI_IMAGE_CONFIG = 'application/vnd.oci.image.config.v1+json';
const UNKNOWN_MEDIA_TYPE = /unknown media type|unsupported media type|manifest invalid/i;

/**
 * `oras push <ref> <files…> --artifact-type <type>` — and when the registry
 * refuses a media type it doesn't know (GitLab only takes image config types),
 * the same push as a plain OCI image (v1.0 manifest, empty `{}` config) with
 * the type in the `app.aura.artifactType` annotation. Readers use
 * `artifactTypeOf`. `files` are relative to `opts.cwd`, which must be set.
 */
export function orasPushArtifact(
  ref: string, files: string[], artifactType: string, extra: string[], opts: ExecFileSyncOptions & { cwd: string },
): Buffer {
  try {
    return orasSync(['push', ref, ...files, '--artifact-type', artifactType, ...extra], opts);
  } catch (err) {
    if (err instanceof OrasAuthError || !UNKNOWN_MEDIA_TYPE.test((err as Error).message)) throw err;
  }
  const cfg = '.aura-oci-config.json';
  writeFileSync(join(opts.cwd, cfg), '{}');
  return orasSync([
    'push', ref, ...files,
    '--image-spec', 'v1.0',
    '--config', `${cfg}:${OCI_IMAGE_CONFIG}`,
    '--annotation', `${ARTIFACT_TYPE_ANNOTATION}=${artifactType}`,
    ...extra,
  ], opts);
}

/** The Aura artifact type of a fetched manifest, wherever the push put it. */
export function artifactTypeOf(m: {
  artifactType?: string; annotations?: Record<string, string>; config?: { mediaType?: string };
}): string | undefined {
  if (m.artifactType) return m.artifactType;
  const ann = m.annotations?.[ARTIFACT_TYPE_ANNOTATION];
  if (ann) return ann;
  const cfg = m.config?.mediaType;
  return cfg && cfg !== OCI_IMAGE_CONFIG && cfg !== 'application/vnd.oci.empty.v1+json' ? cfg : undefined;
}

/** The auth file for one oras call (when the target host has a login). */
function orasAuth(args: string[], login?: RegistryLogin): { fullArgs: string[]; host: string | null; hadLogin: boolean; cleanup: () => void } {
  const host = orasTargetHost(args);
  const use = login ?? (host ? logins().get(host) : undefined);
  const fullArgs = [...args];
  const auth = host && use ? writeAuthConfig(host, use) : null;
  if (auth) fullArgs.push('--registry-config', auth.file);
  return { fullArgs, host, hadLogin: !!use, cleanup: () => auth?.cleanup() };
}

/** A failed oras call as a readable error (OrasAuthError for login trouble). */
function orasError(err: unknown, host: string | null, hadLogin: boolean): Error {
  const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
  const out = `${e.stderr?.toString() ?? ''}\n${e.stdout?.toString() ?? ''}`.trim();
  if (host && isAuthFailure(out)) return new OrasAuthError(host, out.split('\n').pop() ?? 'unauthorized', authFailureReason(out, hadLogin));
  if (out && !e.message.includes(out)) e.message = `${e.message}\n${out}`;
  return e;
}

/**
 * `execFileSync('oras', args, opts)` with the target registry's login, when
 * one is known (or given as `login` — used to probe a login before saving it).
 * Blocks the event loop for the whole call — fine for one-off actions
 * (publish, install), never for anything a page polls: use orasAsync.
 */
export function orasSync(args: string[], opts: ExecFileSyncOptions = {}, login?: RegistryLogin): Buffer {
  const a = orasAuth(args, login);
  try {
    return execFileSync('oras', a.fullArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }) as Buffer;
  } catch (err) {
    throw orasError(err, a.host, a.hadLogin);
  } finally {
    a.cleanup();
  }
}

/** orasSync without blocking: the shell keeps serving while a registry
 *  answers (the store's catalog reads many manifests from a remote registry). */
export async function orasAsync(
  args: string[], opts: { timeout?: number; maxBuffer?: number; cwd?: string } = {}, login?: RegistryLogin,
): Promise<Buffer> {
  const a = orasAuth(args, login);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      execFile('oras', a.fullArgs, {
        encoding: 'buffer', timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, cwd: opts.cwd,
      }, (err, stdout, stderr) => {
        if (err) { Object.assign(err, { stdout, stderr }); reject(err); } else resolve(stdout);
      });
    });
  } catch (err) {
    throw orasError(err, a.host, a.hadLogin);
  } finally {
    a.cleanup();
  }
}
