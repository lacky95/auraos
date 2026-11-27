// APT (D94 §5.2): an apt.conf.d drop-in (proxy, CA, DIRECT for mirrors that
// NO_PROXY covers) at its system path, and the mirror table. An apt mirror
// replaces `scheme://host` of a source; its path (/debian, /debian-security)
// is kept: `deb.debian.org: https://m.corp/debian-remote` turns
// http://deb.debian.org/debian into https://m.corp/debian-remote/debian.
// Image builds rewrite a temporary copy of the sources (os/infra/build-env.sh,
// same rule); nothing in the image keeps the mirror. Where a shared file can't
// be avoided, withManagedBlock replaces only AuraOS's block in it.
import { computeNoProxy } from '../config.mjs';
import { bypassesProxy } from './proxy.mjs';
import { corporateCas } from './trust.mjs';

export const name = 'apt';
export const CONF = 'apt/apt.conf.d/90aura-infra';

const hostOf = (u) => new URL(u).hostname;

export function render(cfg, view) {
  const mirrors = cfg.registries?.apt?.mirrors ?? {};
  const p = cfg.network?.proxy;
  const corp = corporateCas(cfg, view.files);
  if (!Object.keys(mirrors).length && !p && !corp) return {};
  const l = ['// AuraOS infrastructure configuration (D94): managed, do not edit.'];
  if (p?.http) l.push(`Acquire::http::Proxy "${p.http}";`);
  if (p?.https) l.push(`Acquire::https::Proxy "${p.https}";`);
  if (p) {
    const np = computeNoProxy(cfg, view.noProxyExtra);
    for (const h of [...new Set(Object.values(mirrors).map(hostOf))].sort()) {
      if (bypassesProxy(h, np)) l.push(`Acquire::http::Proxy::${h} "DIRECT";`, `Acquire::https::Proxy::${h} "DIRECT";`);
    }
  }
  if (corp) l.push(`Acquire::https::CAInfo "${view.root}/ca-bundle.pem";`);
  const files = { [CONF]: `${l.join('\n')}\n` };
  const m = Object.keys(mirrors).sort().map((h) => `${h}\t${mirrors[h].replace(/\/+$/, '')}`);
  if (m.length) files['apt/mirrors'] = `${m.join('\n')}\n`;
  return { files, systemPaths: { '/etc/apt/apt.conf.d/90aura-infra': CONF } };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Sources text (one-line or deb822) with every mirrored `scheme://host` replaced. */
export function rewriteAptSources(text, mirrors = {}) {
  let out = text;
  for (const h of Object.keys(mirrors)) out = out.replace(new RegExp(`https?://${esc(h)}(?=[/\\s]|$)`, 'gm'), mirrors[h].replace(/\/+$/, ''));
  return out;
}

const BEGIN = '# >>> aura-infra (managed, do not edit) >>>';
const END = '# <<< aura-infra <<<';

/** `text` with AuraOS's managed block set to `body` (null removes it); the text outside stays byte-identical. */
export function withManagedBlock(text, body) {
  const i = text.indexOf(BEGIN);
  const j = i < 0 ? -1 : text.indexOf(END, i);
  const block = body === null ? '' : `${BEGIN}\n${body.replace(/\n?$/, '\n')}${END}\n`;
  if (i >= 0 && j >= 0) {
    let end = j + END.length;
    if (text[end] === '\n') end++;
    return text.slice(0, i) + block + text.slice(end);
  }
  if (!block) return text;
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${block}`;
}

/** `infra_apt_auth`: auth.conf lines for the mirrors (builders only). */
export function secretFiles(cfg, view, resolve) {
  const a = cfg.registries?.apt;
  const c = a?.credential ? resolve(a.credential.ref) : null;
  if (!c || c.kind !== 'basic') return {};
  const machines = [...new Set(Object.values(a.mirrors).map((u) => { const x = new URL(u); return `${x.host}${x.pathname}`.replace(/\/$/, ''); }))];
  return { infra_apt_auth: `${machines.map((m) => `machine ${m} login ${c.user} password ${c.password}`).join('\n')}\n` };
}
