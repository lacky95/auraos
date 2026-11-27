// Proxy (D94 §5.2, §5.4): the credential-free proxy env every HTTP client
// reads (both cases), with NO_PROXY computed. The credential-bearing URL is a
// secret file for the installer and the system builders only (O4: never apps).
import { computeNoProxy } from '../config.mjs';

export const name = 'proxy';

const withUserinfo = (url, c) => {
  const u = new URL(url);
  u.username = encodeURIComponent(c.user);
  u.password = encodeURIComponent(c.password);
  return u.toString();
};

export function render(cfg, view) {
  const p = cfg.network?.proxy;
  if (!p) return {};
  const env = {};
  if (p.http) env.HTTP_PROXY = env.http_proxy = p.http;
  if (p.https) env.HTTPS_PROXY = env.https_proxy = p.https;
  env.NO_PROXY = env.no_proxy = computeNoProxy(cfg, view.noProxyExtra);
  return { env };
}

/**
 * `infra_proxy`: the https proxy (else the http one) with its credential;
 * `infra_proxy_http`: the http proxy, only when it is a different URL.
 */
export function secretFiles(cfg, view, resolve) {
  const p = cfg.network?.proxy;
  const c = p?.credential ? resolve(p.credential.ref) : null;
  if (!c || c.kind !== 'basic') return {};
  const out = { infra_proxy: `${withUserinfo(p.https ?? p.http, c)}\n` };
  if (p.http && p.https && p.http !== p.https) out.infra_proxy_http = `${withUserinfo(p.http, c)}\n`;
  return out;
}

/** True when `host` is covered by a NO_PROXY list (exact, `.suffix`, or `domain` suffix). */
export function bypassesProxy(host, noProxy) {
  return String(noProxy).split(',').map((e) => e.trim()).filter(Boolean).some((e) => {
    if (e.includes('/')) return false; // CIDR: tool-specific, not matched by name
    const d = e.replace(/^\*?\./, '');
    return host === d || host.endsWith(`.${d}`);
  });
}
