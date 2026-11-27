// Node.js (D94 §5.2; Node 22.23.5 has every flag used here):
//   NODE_EXTRA_CA_CERTS  the corporate CAs, added to Node's bundled roots
//   NODE_USE_ENV_PROXY   fetch/undici and http(s) follow HTTP(S)_PROXY/NO_PROXY
//                        (the env form of --use-env-proxy)
//   --use-openssl-ca     only with trust.publicRoots: replace: Node then trusts
//                        OpenSSL's store (SSL_CERT_FILE = the corporate-only
//                        bundle) instead of its bundled public roots.
//   --disable-warning=UNDICI-EHPA   with the env proxy: Node 22 prints
//                        "EnvHttpProxyAgent is experimental" on every start
//                        otherwise (a user NODE_OPTIONS replaces the whole value)
// --use-system-ca is not needed: with `keep` the bundled roots plus the
// corporate CAs are exactly the trust set, and it would only add the distro's
// copy of the same public roots.
import { corporateCas } from './trust.mjs';

export const name = 'node';

export function render(cfg, view) {
  const env = {};
  const options = [];
  if (corporateCas(cfg, view.files)) {
    env.NODE_EXTRA_CA_CERTS = `${view.root}/corporate-ca.pem`;
    if (cfg.trust?.publicRoots === 'replace') options.push('--use-openssl-ca');
  }
  if (cfg.network?.proxy) {
    env.NODE_USE_ENV_PROXY = '1';
    options.push('--disable-warning=UNDICI-EHPA');
  }
  if (options.length) env.NODE_OPTIONS = options.join(' ');
  return { env };
}
