// Git (D94 §5.2): GIT_CONFIG_SYSTEM points at an AuraOS-owned system config
// that first includes the image's own /etc/gitconfig (so nothing there is
// lost), then sets the CA and the mirror rewrites. ~/.gitconfig and a
// repository's config keep winning. The proxy comes from the env (git honours
// https_proxy and no_proxy), so NO_PROXY applies to git exactly as elsewhere.
import { corporateCas } from './trust.mjs';

export const name = 'git';

export function render(cfg, view) {
  const rw = cfg.registries?.git?.rewrites ?? {};
  const corp = corporateCas(cfg, view.files);
  if (!Object.keys(rw).length && !corp) return {};
  const l = ['# AuraOS infrastructure configuration (D94): system layer, managed. ~/.gitconfig wins.', '[include]', '\tpath = /etc/gitconfig'];
  if (corp) l.push('[http]', `\tsslCAInfo = ${view.root}/ca-bundle.pem`);
  for (const from of Object.keys(rw).sort()) l.push(`[url "${rw[from]}"]`, `\tinsteadOf = ${from}`);
  return { files: { gitconfig: `${l.join('\n')}\n` }, env: { GIT_CONFIG_SYSTEM: `${view.root}/gitconfig` } };
}

/** `infra_git`: a git-credential-store file for the mirror origins (builders only). */
export function secretFiles(cfg, view, resolve) {
  const g = cfg.registries?.git;
  const c = g?.credential ? resolve(g.credential.ref) : null;
  if (!c || c.kind !== 'basic') return {};
  const lines = [...new Set(Object.values(g.rewrites ?? {}).map((u) => new URL(u).origin))].map((o) => {
    const u = new URL(o);
    u.username = encodeURIComponent(c.user);
    u.password = encodeURIComponent(c.password);
    return u.toString().replace(/\/$/, '');
  });
  return lines.length ? { infra_git: `${lines.join('\n')}\n` } : {};
}
