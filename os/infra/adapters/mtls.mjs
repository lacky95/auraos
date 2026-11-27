// Install-time mTLS (D94 IC-8, O8): a PEM client certificate and key per host,
// for the bootstrap tools that reach those hosts (git, npm/pnpm/yarn, pip,
// apt) during install, system builds and system updates. Never for apps or
// user sessions (alpha), never a TLS-weakening switch: a tool that can't do
// the configured mTLS fails with the server's "certificate required".
//
//   public   mtls/<name>.crt   the client certificate (public material)
//            mtls/clients      "<name>\t<host>" per line, sorted
//   secret   infra_mtls        every client key, one PEM block per name after
//                              a "# aura-mtls <name>" line (one BuildKit
//                              secret id: a Dockerfile can only mount fixed
//                              ids; os/infra/build-env.sh splits it into a
//                              tmpfs, 0600, for that RUN only)
// toolConfig() is the one place that turns an assignment into each tool's
// setting, for the image build (build-env.sh mirrors it in sh), the
// installer's host-side git/curl and the release builder.
export const name = 'mtls';

const clientsOf = (cfg) => [...(cfg.clientCertificates ?? [])].sort((a, b) => a.name.localeCompare(b.name));

export function render(cfg, view) {
  const files = {};
  const rows = [];
  for (const c of clientsOf(cfg)) {
    const pem = view.files[c.certificate.file];
    if (!pem) continue;
    files[`mtls/${c.name}.crt`] = pem;
    for (const h of [...c.hosts].sort()) rows.push(`${c.name}\t${h}`);
  }
  if (!rows.length) return {};
  files['mtls/clients'] = `${rows.join('\n')}\n`;
  return { files };
}

export const KEY_MARKER = '# aura-mtls ';

export function secretFiles(cfg, view, resolve) {
  const parts = [];
  for (const c of clientsOf(cfg)) {
    const k = resolve(c.key.ref);
    if (k?.kind === 'private-key') parts.push(`${KEY_MARKER}${c.name}\n${k.pem.replace(/\n?$/, '\n')}`);
  }
  return parts.length ? { infra_mtls: parts.join('') } : {};
}

/** Splits an `infra_mtls` bundle into `{ name: pem }`. */
export function splitKeys(bundle) {
  const out = {};
  let cur = null;
  for (const line of String(bundle).split('\n')) {
    if (line.startsWith(KEY_MARKER)) { cur = line.slice(KEY_MARKER.length).trim(); out[cur] = ''; continue; }
    if (cur !== null && line) out[cur] += `${line}\n`;
  }
  return out;
}

/**
 * Per-tool settings for one operation: `paths(name)` → `{ cert, key }` where
 * this operation keeps the files. Returns
 *   gitconfig  lines (http.<url>.sslCert/sslKey per host)
 *   npmrc      lines (//host/:certfile= / keyfile=)
 *   aptconf    lines (Acquire::https::<host>::SslCert / SslKey)
 *   pip        { cert, key } for the python index host, or null (pip takes one client certificate)
 */
export function toolConfig(cfg, paths) {
  const out = { gitconfig: [], npmrc: [], aptconf: [], pip: null };
  let pyHost = null;
  try { pyHost = cfg.registries?.python ? new URL(cfg.registries.python.index).hostname : null; } catch { /* validated elsewhere */ }
  for (const c of clientsOf(cfg)) {
    const p = paths(c.name);
    for (const h of [...c.hosts].sort()) {
      out.gitconfig.push(`[http "https://${h}/"]`, `\tsslCert = ${p.cert}`, `\tsslKey = ${p.key}`);
      out.npmrc.push(`//${h}/:certfile=${p.cert}`, `//${h}/:keyfile=${p.key}`);
      out.aptconf.push(`Acquire::https::${h}::SslCert "${p.cert}";`, `Acquire::https::${h}::SslKey "${p.key}";`);
      if (h === pyHost && !out.pip) out.pip = { cert: p.cert, key: p.key };
    }
  }
  return out;
}
