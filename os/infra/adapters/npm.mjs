// npm / pnpm / yarn classic / corepack (D94 §5.2). One AuraOS-owned npmrc in
// the tools' GLOBAL layer, so a user's ~/.npmrc and a project's .npmrc keep
// winning natively:
//   NPM_CONFIG_GLOBALCONFIG   npm reads the global npmrc from here
//   /usr/local/etc/npmrc      ${prefix}/etc/npmrc of the node images: yarn
//                             classic's (and npm's default) global location
//   COREPACK_NPM_REGISTRY     corepack has no config file; its only knob
// pnpm 11+ (12.18 verified) reads no global npmrc at all: only the project's
// and the user's (NPM_CONFIG_USERCONFIG, else ~/.npmrc), and pnpm_config_*
// env, which outranks both. It still follows HTTP(S)_PROXY/NO_PROXY and the
// CA env as fallbacks. So a system operation with no user of its own (the
// image build, os/boot.sh, the builders) uses this npmrc as its user config;
// a person's session keeps their own files, and the registry reaches pnpm
// there only once IC-5 decides how (no env that would outrank their files).
// Never into a home or an app tree. Credentials are secret files for the
// builders only (infra_npmrc as a per-build user config, infra_npm_basic for
// corepack); apps never get them (O4).
import { computeNoProxy } from '../config.mjs';
import { corporateCas } from './trust.mjs';

export const name = 'npm';

export function render(cfg, view) {
  const r = cfg.registries?.npm;
  const p = cfg.network?.proxy;
  const corp = corporateCas(cfg, view.files);
  if (!r && !p && !corp) return {};
  const lines = ['# AuraOS infrastructure configuration (D94): global layer, managed. ~/.npmrc and a project .npmrc win.'];
  const env = { NPM_CONFIG_GLOBALCONFIG: `${view.root}/npmrc` };
  if (r) {
    lines.push(`registry=${r.url}`);
    for (const s of Object.keys(r.scopes ?? {}).sort()) lines.push(`${s}:registry=${r.scopes[s]}`);
    env.COREPACK_NPM_REGISTRY = r.url.replace(/\/+$/, '');
  }
  // yarn classic reads no proxy env of its own: the npmrc carries it (credential-free).
  if (p?.http) lines.push(`proxy=${p.http}`);
  if (p?.https) lines.push(`https-proxy=${p.https}`);
  if (p) lines.push(`noproxy=${computeNoProxy(cfg, view.noProxyExtra)}`);
  // cafile replaces the client's CA list, so it is the full bundle (public roots kept unless replace).
  if (corp) lines.push(`cafile=${view.root}/ca-bundle.pem`);
  return { files: { npmrc: `${lines.join('\n')}\n` }, env, systemPaths: { '/usr/local/etc/npmrc': 'npmrc' } };
}

export function secretFiles(cfg, view, resolve) {
  const r = cfg.registries?.npm;
  const c = r?.credential ? resolve(r.credential.ref) : null;
  if (!c || c.kind !== 'basic') return {};
  const auth = Buffer.from(`${c.user}:${c.password}`).toString('base64');
  const npmrc = [r.url, ...Object.values(r.scopes ?? {})]
    .map((u) => { const x = new URL(u); return `//${x.host}${x.pathname.endsWith('/') ? x.pathname : `${x.pathname}/`}:_auth=${auth}`; })
    .filter((l, i, a) => a.indexOf(l) === i).join('\n');
  return { infra_npmrc: `${npmrc}\n`, infra_npm_basic: `${c.user}:${c.password}\n` };
}
