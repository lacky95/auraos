// The alpha adapters (D94 §4.6, IC-4): a fixed list, no registry, no dynamic
// loading. Each adapter is a pure function of the config, the public files it
// imports (CA PEMs) and the view; the output is deterministic and sorted.
//
//   render(cfg, view)              → { files?, env?, systemPaths? }   non-secret only
//   secretFiles(cfg, view, resolve) → { <secret id>: content }         per operation only
//
// view: { root, files, systemBundle, noProxyExtra }
//   root          where consumers see the rendered directory (INFRA_ROOT
//                 everywhere: the shell links it, containers and image builds
//                 mount it there), so every path inside a file is the same
//   files         the store's public files (trust/<name>.pem …)
//   systemBundle  the distro root bundle text (trust.publicRoots: keep)
//   noProxyExtra  runtime-known internal destinations (aura-net subnet, desktop hosts)
// No config (or a config without network/trust/registries) renders nothing:
// exactly today's behaviour (D94 acceptance 6).
import * as apt from './apt.mjs';
import * as artifacts from './artifacts.mjs';
import * as endpoints from './endpoints.mjs';
import * as git from './git.mjs';
import * as mtls from './mtls.mjs';
import * as node from './node.mjs';
import * as npm from './npm.mjs';
import * as oci from './oci.mjs';
import * as proxy from './proxy.mjs';
import * as python from './python.mjs';
import * as trust from './trust.mjs';

export const ADAPTERS = Object.freeze([proxy, trust, node, npm, python, git, apt, oci, artifacts, mtls, endpoints]);
export const INFRA_ROOT = '/etc/aura/infra';

/** The secret ids the image build consumes (Dockerfile `--mount=type=secret,id=…`). */
export const BUILD_SECRET_IDS = Object.freeze(['infra_apt_auth', 'infra_git', 'infra_mtls', 'infra_npm_basic', 'infra_npmrc', 'infra_proxy', 'infra_proxy_http']);

/** Values the adapters must never emit (D94 §7.5): a test greps every output for them. */
export const TLS_BYPASS = Object.freeze([
  /strict-ssl\s*=\s*false/i, /sslVerify\s*=\s*false/i, /NODE_TLS_REJECT_UNAUTHORIZED/, /(^|\s)(-k|--insecure)(\s|$)/,
  /AllowInsecureRepositories/i, /allow-unauthenticated/i, /Verify-Peer\s*"?false/i, /allow-insecure-host/i, /GIT_SSL_NO_VERIFY/,
]);

const SAFE_ENV = /^[A-Za-z0-9._:/@+,=%~* -]*$/;
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

function viewOf(view = {}) {
  return { root: INFRA_ROOT, files: {}, systemBundle: null, noProxyExtra: [], ...view };
}

/** Renders every adapter: `{ files, env, systemPaths }`, all sorted; empty without a config. */
export function renderInfra(cfg, view) {
  const v = viewOf(view);
  const files = {}, env = {}, systemPaths = {};
  if (!cfg) return { files, env, systemPaths };
  for (const a of ADAPTERS) {
    const r = a.render(cfg, v) ?? {};
    for (const [kind, into] of [['files', files], ['env', env], ['systemPaths', systemPaths]]) {
      for (const [k, x] of Object.entries(r[kind] ?? {})) {
        if (Object.hasOwn(into, k) && into[k] !== x) throw new Error(`infra adapters: ${a.name} and another adapter both set ${kind} ${k}`);
        into[k] = x;
      }
    }
  }
  for (const [k, x] of Object.entries(env)) if (!SAFE_ENV.test(x)) throw new Error(`infra adapters: unsafe value for ${k}`);
  return { files: sortObj(files), env: sortObj(env), systemPaths: sortObj(systemPaths) };
}

/** True when nothing was rendered (no config, or one with nothing to apply). */
export const isEmptyRender = (r) => !Object.keys(r.files).length && !Object.keys(r.env).length;

/**
 * Every adapter's secret files for one operation: `{ id: content }`.
 * `resolve(ref)` → `{ kind: 'basic', user, password } | { kind: 'private-key', pem } | null`.
 */
export function renderSecrets(cfg, resolve, view) {
  const v = viewOf(view);
  const out = {};
  if (!cfg) return out;
  for (const a of ADAPTERS) Object.assign(out, a.secretFiles?.(cfg, v, resolve) ?? {});
  return sortObj(out);
}

/** `KEY=value` lines (the build helper and other shell consumers read them). */
export const envFile = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join('');

/** `export KEY='value'` lines for `.` in a POSIX shell. */
export const envSh = (env) => Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'\n`).join('');

export { apt, artifacts, endpoints, git, mtls, node, npm, oci, proxy, python, trust };
