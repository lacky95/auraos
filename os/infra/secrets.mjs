// Infrastructure credentials (D94 §4.3, §6.3): bootstrap credential files,
// the secret build inputs rendered from them, and the one redactor every
// installer, builder and updater log goes through. Dependency-free (see
// config.mjs).
//
// A bootstrap credential `bootstrap:<name>` is the file `<credentials-dir>/<name>`:
// mode 0600 (no group/other bits), owned by the operator, one line
// `username:password` (Basic auth: proxy, registries, git), or a PEM private
// key for a client certificate (mTLS, O8). Its value is read only to render
// secret files for one operation; it never goes into argv, env of a long-lived
// process, an image layer, a log or the config.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { refsOf } from './config.mjs';

export class CredentialError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const PEM_KEY = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

/**
 * The one redactor (D94 §6.3): URL userinfo, Authorization and
 * Proxy-Authorization headers, npm auth lines, PEM private keys, and every
 * known secret value (plain, URL-encoded and base64 forms).
 */
export function redactSecrets(text, known = []) {
  let s = String(text);
  for (const v of known.filter((x) => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length)) {
    for (const form of new Set([v, encodeURIComponent(v), Buffer.from(v).toString('base64')])) s = s.split(form).join('***');
  }
  return s
    .replace(PEM_KEY, '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@:]*:[^/\s@]*@/gi, '$1***@')
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer|token)?\s*[^\s"',]+/gi, '$1***')
    .replace(/(_auth(?:Token)?\s*=\s*)\S+/g, '$1***')
    .replace(/(:_password\s*=\s*)\S+/g, '$1***')
    .replace(/(\bpassword\s+)\S+/g, '$1***');
}

/** The bootstrap name of a ref, or null for refs resolved elsewhere (system:). */
export const bootstrapName = (ref) => (/^bootstrap:/.test(ref) ? ref.slice('bootstrap:'.length) : null);

/**
 * Checks one bootstrap credential file without reading it into any output.
 * Returns `{ name, file, kind: 'basic'|'private-key' }`.
 */
export function checkBootstrapCredential(dir, name, { uid = process.getuid?.() } = {}) {
  const file = join(dir, name);
  let st;
  try { st = statSync(file); } catch { throw new CredentialError('missing', `bootstrap:${name}: no file ${file}`); }
  if (!st.isFile()) throw new CredentialError('not-file', `bootstrap:${name}: ${file} is not a regular file`);
  if (st.mode & 0o077) throw new CredentialError('mode', `bootstrap:${name}: ${file} must be mode 0600 (it is ${(st.mode & 0o777).toString(8)}): chmod 600 ${file}`);
  if (uid !== undefined && uid !== 0 && st.uid !== uid) throw new CredentialError('owner', `bootstrap:${name}: ${file} belongs to uid ${st.uid}, not to the operator (uid ${uid})`);
  const text = readFileSync(file, 'utf8');
  const kind = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ? 'private-key' : 'basic';
  if (kind === 'basic' && !/^[^\s:]+:[^\r\n]+\r?\n?$/.test(text)) throw new CredentialError('format', `bootstrap:${name}: expected one line username:password (or a PEM private key)`);
  return { name, file, kind };
}

/** Reads a checked bootstrap credential: `{ kind, user?, password?, pem? }`. */
export function readBootstrapCredential(dir, name, opts) {
  const { kind, file } = checkBootstrapCredential(dir, name, opts);
  const text = readFileSync(file, 'utf8');
  if (kind === 'private-key') return { kind, pem: text };
  const line = text.replace(/\r?\n$/, '');
  const i = line.indexOf(':');
  return { kind, user: line.slice(0, i), password: line.slice(i + 1) };
}

/**
 * Every bootstrap ref of a config checked against a credentials directory.
 * Returns `{ ok, refs: [{ref, path, hosts, status, message?}] }`: names and
 * paths only, never a value. `system:` refs resolve in the kernel later.
 */
export function checkConfigCredentials(cfg, dir, opts) {
  const refs = refsOf(cfg).map((r) => {
    const name = bootstrapName(r.ref);
    if (!name) return { ...r, status: 'later', message: 'resolved by the kernel (system:)' };
    if (!dir) return { ...r, status: 'missing', message: `${r.ref}: pass --credentials-dir` };
    try {
      const c = checkBootstrapCredential(dir, name, opts);
      const wantKey = r.path.startsWith('clientCertificates.');
      if (wantKey !== (c.kind === 'private-key')) return { ...r, status: 'invalid', message: `${r.ref}: expected ${wantKey ? 'a PEM private key' : 'username:password'}` };
      return { ...r, status: 'ok' };
    } catch (e) {
      if (!(e instanceof CredentialError)) throw e;
      return { ...r, status: e.code, message: e.message };
    }
  });
  return { ok: refs.every((r) => r.status === 'ok' || r.status === 'later'), refs };
}

const withUserinfo = (url, c) => {
  const u = new URL(url);
  u.username = encodeURIComponent(c.user);
  u.password = encodeURIComponent(c.password);
  return u.toString();
};

/**
 * The BuildKit secret files for one build (D94 §6.3), from the bootstrap
 * credentials: `{ id: content }`. Ids are fixed: infra_proxy (the proxy URL
 * with credentials, for `RUN --mount=type=secret,id=infra_proxy,env=HTTPS_PROXY`),
 * infra_npmrc, infra_pip (index URL with credentials), infra_apt_auth
 * (auth.conf), infra_git (git-credentials store), infra_mtls_<name>_key.
 * The Dockerfile consumes them from IC-3 on; until then they are passed but unused.
 */
export function renderBuildSecrets(cfg, dir, opts) {
  const out = {};
  const get = (ref) => { const n = bootstrapName(ref); return n ? readBootstrapCredential(dir, n, opts) : null; };
  const p = cfg.network?.proxy;
  if (p?.credential) {
    const c = get(p.credential.ref);
    if (c) out.infra_proxy = `${withUserinfo(p.https ?? p.http, c)}\n`;
  }
  const r = cfg.registries ?? {};
  if (r.npm?.credential) {
    const c = get(r.npm.credential.ref);
    if (c) {
      const auth = Buffer.from(`${c.user}:${c.password}`).toString('base64');
      out.infra_npmrc = [r.npm.url, ...Object.values(r.npm.scopes ?? {})]
        .map((u) => { const x = new URL(u); return `//${x.host}${x.pathname.endsWith('/') ? x.pathname : `${x.pathname}/`}:_auth=${auth}`; })
        .filter((l, i, a) => a.indexOf(l) === i).join('\n') + '\n';
    }
  }
  if (r.python?.credential) {
    const c = get(r.python.credential.ref);
    if (c) out.infra_pip = `${withUserinfo(r.python.index, c)}\n`;
  }
  if (r.apt?.credential) {
    const c = get(r.apt.credential.ref);
    if (c) out.infra_apt_auth = [...new Set(Object.values(r.apt.mirrors).map((u) => { const x = new URL(u); return `${x.host}${x.pathname}`.replace(/\/$/, ''); }))]
      .map((m) => `machine ${m} login ${c.user} password ${c.password}`).join('\n') + '\n';
  }
  if (r.git?.credential) {
    const c = get(r.git.credential.ref);
    if (c) out.infra_git = [...new Set(Object.values(r.git.rewrites ?? {}).map((u) => new URL(u).origin))]
      .map((o) => withUserinfo(o, c).replace(/\/$/, '')).join('\n') + '\n';
  }
  for (const cc of cfg.clientCertificates ?? []) {
    const c = get(cc.key.ref);
    if (c) out[`infra_mtls_${cc.name.replace(/-/g, '_')}_key`] = c.pem;
  }
  return out;
}

/** Every secret value of a credentials dir for redaction (never printed). */
export function knownSecretValues(cfg, dir, opts) {
  const vals = [];
  for (const r of refsOf(cfg)) {
    const n = bootstrapName(r.ref);
    if (!n || !dir) continue;
    try {
      const c = readBootstrapCredential(dir, n, opts);
      if (c.kind === 'basic') vals.push(c.password, `${c.user}:${c.password}`);
      else vals.push(c.pem);
    } catch { /* reported by the check */ }
  }
  return vals;
}
