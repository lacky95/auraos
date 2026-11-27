// Linux trust (D94 §5.2): the CA bundle every OpenSSL/GnuTLS/Go/Python client
// can be pointed at, and the corporate-only PEM for additive consumers (Node).
//   ca-bundle.pem      the distro's public roots + the corporate CAs
//                      (only the corporate CAs with trust.publicRoots: replace)
//   corporate-ca.pem   the corporate CAs alone
//   ca-certificates/   one .crt per CA, for update-ca-certificates in images
//                      AuraOS builds (system path below; applied by IC-5)
// No CA is baked into an image (O7); the files are mounted or read at runtime.
import { existsSync, readFileSync } from 'node:fs';

export const name = 'trust';

/** Where Linux distributions keep the public root bundle (first existing wins). */
export const SYSTEM_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem', '/etc/ssl/ca-bundle.pem'];

/** The text of the first system bundle that exists, or null. */
export function readSystemBundle(candidates = SYSTEM_BUNDLES) {
  const f = candidates.find((x) => existsSync(x));
  return f ? readFileSync(f, 'utf8') : null;
}

/** The corporate CA PEMs of a staged/stored config (`files` keyed by store path). */
export function corporateCas(cfg, files = {}) {
  return (cfg.trust?.caCertificates ?? []).map((c) => files[c.file]).filter(Boolean).join('');
}

/** CA bundle: system roots (unless publicRoots: replace) + the corporate CAs. */
export function caBundle(cfg, files, systemBundle) {
  const corp = corporateCas(cfg, files);
  if (cfg.trust?.publicRoots === 'replace') return corp;
  const sys = systemBundle ?? '';
  return `${sys}${sys && !sys.endsWith('\n') ? '\n' : ''}${corp}`;
}

export function render(cfg, view) {
  const corp = corporateCas(cfg, view.files);
  if (!corp) return {};
  if (cfg.trust?.publicRoots !== 'replace' && !view.systemBundle) {
    // A bundle without the public roots would silently drop them for every client pointed at it.
    throw Object.assign(new Error('trust: no system CA bundle to add the corporate CAs to (publicRoots: keep)'), { code: 'no-system-bundle' });
  }
  const files = { 'corporate-ca.pem': corp, 'ca-bundle.pem': caBundle(cfg, view.files, view.systemBundle) };
  for (const c of cfg.trust.caCertificates) if (view.files[c.file]) files[`ca-certificates/aura-infra-${c.name}.crt`] = view.files[c.file];
  const bundle = `${view.root}/ca-bundle.pem`;
  return {
    files,
    env: { SSL_CERT_FILE: bundle, CURL_CA_BUNDLE: bundle, REQUESTS_CA_BUNDLE: bundle },
    systemPaths: { '/usr/local/share/ca-certificates/aura-infra': 'ca-certificates' },
  };
}
