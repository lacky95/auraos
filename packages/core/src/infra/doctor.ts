/**
 * `aura admin infra doctor` / `POST /api/admin/infra/doctor` (D94 IC-7, O9): the infrastructure
 * configuration checked against the running system. Every result is a category and plain words
 * (a field path, a host, a status code), never a value: no URL userinfo, no credential, no
 * certificate body. Read-only: it renders in memory and compares, it never applies.
 */
import { connect } from 'node:net';
import { loadOsInfra } from './osInfra.js';
import { dataRootOf, renderDigest } from './propagate.js';
import { credentialResolver } from './credentials.js';
import { infraBootStatus } from './kernel.js';
import { readInfraPolicy, type InfraPolicy } from './policy.js';

export type InfraCheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface InfraCheck { id: string; status: InfraCheckStatus; message: string }
export interface InfraDoctorReport { configured: boolean; ok: boolean; digest: string | null; checks: InfraCheck[] }

export interface InfraDoctorOptions {
  dataDir?: string;
  /** Network probes (registries, proxy). Off: config, render, certificates, policy, credentials only. */
  network?: boolean;
  policy?: InfraPolicy;
  fetch?: typeof fetch;
  now?: Date;
  /** Tests: the TCP probe. */
  tcp?: (host: string, port: number, ms: number) => Promise<boolean>;
}

const tcpProbe = (host: string, port: number, ms: number): Promise<boolean> => new Promise((res) => {
  const s = connect({ host, port });
  const done = (ok: boolean) => { s.destroy(); res(ok); };
  s.setTimeout(ms, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

/** A fetch failure as a category (D94 §10: actionable, no value). */
export function failureCategory(err: unknown): string {
  const c = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = c?.code ?? (err as { code?: string })?.code ?? '';
  const msg = `${c?.message ?? ''} ${(err as Error)?.message ?? ''}`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|unable to get local issuer|certificate/i.test(`${code} ${msg}`)) return 'TLS verification failed (corporate CA missing in trust.caCertificates?)';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'DNS: the host does not resolve';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(code)) return 'unreachable (connection refused or no route)';
  if (/TIMEOUT|ABORT/i.test(`${code} ${(err as Error)?.name ?? ''}`)) return 'timed out';
  if (/407|Proxy Authentication/i.test(msg)) return 'the proxy requires authentication';
  return 'request failed';
}

export async function runInfraDoctor(opts: InfraDoctorOptions = {}): Promise<InfraDoctorReport> {
  const dataDir = dataRootOf(opts.dataDir);
  const checks: InfraCheck[] = [];
  const add = (id: string, status: InfraCheckStatus, message: string) => checks.push({ id, status, message });
  const digest = renderDigest(dataDir);
  const osi = await loadOsInfra();
  const dir = osi.store.infraDir(dataDir);
  let store: { config: Record<string, any>; files: Record<string, string>; warnings: Array<{ path: string; message: string }> } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    store = osi.store.readStore(dir);
  } catch (err) {
    const errors = (err as { errors?: Array<{ path: string; message: string }> }).errors;
    add('config', 'fail', errors ? `invalid: ${errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}` : `unreadable: ${(err as Error).message}`);
    return { configured: true, ok: false, digest, checks };
  }
  if (!store) {
    add('config', 'ok', 'no infrastructure configuration: AuraOS uses the public defaults (today\'s behaviour)');
    if (digest) add('render', 'fail', 'a rendered config exists without config.yaml: run `node os/infra/render.mjs apply` or restore the config');
    return { configured: false, ok: !digest, digest, checks };
  }
  const cfg = store.config;
  add('config', 'ok', `valid (version ${cfg['version']})`);
  for (const w of store.warnings) add('config', 'warn', `${w.path}: ${w.message}`);

  // The rendered dir is the render of this config (and the shell applied it).
  try {
    const r = osi.adapters.renderInfra(cfg, { root: osi.adapters.INFRA_ROOT, files: store.files, systemBundle: osi.adapters.trust.readSystemBundle() });
    const want = osi.adapters.isEmptyRender(r) ? null : osi.render.renderTree(r).digest as string;
    if (want === digest) add('render', 'ok', want ? `generated/current is ${want.slice(0, 19)}…` : 'nothing to render');
    else add('render', 'fail', 'generated/current is not the render of config.yaml: re-apply (`aura restart os` renders at boot)');
  } catch (err) {
    add('render', 'fail', `the config does not render: ${(err as Error).message}`);
  }
  const boot = infraBootStatus();
  if (!boot) add('boot', 'skip', 'boot step 0 did not run in this process');
  else if (boot.digest !== digest) add('boot', 'warn', 'the shell runs an older render: it reloads within seconds, or after `aura restart os`');
  else add('boot', boot.state === 'ok' ? 'ok' : boot.state === 'none' ? 'ok' : 'warn', boot.issues.length ? boot.issues.join('; ') : `applied (${boot.state})`);

  // Certificates: expired fails, under 30 days warns.
  const now = opts.now ?? new Date();
  for (const [file, pem] of Object.entries(store.files)) {
    try {
      for (const d of osi.store.checkCertificatePem(pem, file).notAfter as Date[]) {
        const days = Math.floor((d.getTime() - now.getTime()) / 864e5);
        if (days < 0) add('certificate', 'fail', `${file} expired on ${d.toISOString().slice(0, 10)}`);
        else if (days < 30) add('certificate', 'warn', `${file} expires on ${d.toISOString().slice(0, 10)} (in ${days} days)`);
        else add('certificate', 'ok', `${file} valid until ${d.toISOString().slice(0, 10)}`);
      }
    } catch (err) {
      add('certificate', 'fail', `${file}: ${(err as Error).message}`);
    }
  }

  // D64 consistency (the switches are the only truth; the config must agree).
  const policy = opts.policy ?? await readInfraPolicy();
  const hasProxy = !!cfg['network']?.proxy;
  if (hasProxy && policy.proxy !== 'configured') add('policy', 'warn', 'a proxy is configured but infra-proxy is off: `aura admin security set infra-proxy configured`');
  else if (!hasProxy && policy.proxy === 'configured') add('policy', 'warn', 'infra-proxy is configured but the config has no network.proxy');
  const roots = cfg['trust']?.publicRoots === 'replace' ? 'replace' : 'keep';
  if (roots !== policy.publicRoots) add('policy', 'fail', `trust.publicRoots is ${roots} but infra-public-roots is ${policy.publicRoots}: both must say replace`);
  if (policy.publicFallback === 'deny') {
    const r = cfg['registries'] ?? {};
    const gaps = ['npm', 'python', 'apt', 'oci', 'git'].filter((k) => !r[k]);
    if (gaps.length) add('policy', 'warn', `infra-public-fallback is deny and registries.${gaps.join(', registries.')} ${gaps.length > 1 ? 'are' : 'is'} not configured: those tools have no allowed endpoint`);
    if (!cfg['endpoints']?.nexusIndex) add('policy', 'warn', 'infra-public-fallback is deny: the default Nexus store index is refused (set endpoints.nexusIndex to a mirror)');
  }
  if (!checks.some((c) => c.id === 'policy')) add('policy', 'ok', `infra-public-fallback ${policy.publicFallback}, infra-proxy ${policy.proxy}, infra-inherit ${policy.inherit}, infra-public-roots ${policy.publicRoots}`);

  // Credentials: every ref resolves (names only).
  const refs = osi.config.refsOf(cfg) as Array<{ ref: string; path: string; hosts: string[] }>;
  if (refs.length) {
    try {
      const resolve = await credentialResolver({ dataDir, refs });
      for (const r of refs) add('credential', resolve(r.ref) ? 'ok' : 'fail', `${r.ref} (${r.path}): ${resolve(r.ref) ? 'resolvable' : 'missing: `aura admin infra credential set` or re-run install.sh --credentials-dir'}`);
    } catch (err) {
      add('credential', 'fail', (err as Error).message);
    }
  }

  // Network: the proxy answers, each configured endpoint answers with TLS verified.
  if (opts.network !== false) {
    const tcp = opts.tcp ?? tcpProbe;
    for (const p of [...new Set([cfg['network']?.proxy?.http, cfg['network']?.proxy?.https].filter(Boolean) as string[])]) {
      const u = new URL(p);
      const ok = await tcp(u.hostname, Number(u.port || (u.protocol === 'https:' ? 443 : 80)), 5000);
      add('proxy', ok ? 'ok' : 'fail', `${u.host}: ${ok ? 'reachable' : 'unreachable (DNS, firewall or the proxy is down)'}`);
    }
    const f = opts.fetch ?? fetch;
    for (const e of osi.config.endpointsOf(cfg) as Array<{ kind: string; url: string }>) {
      if (e.kind === 'proxy') continue;
      const u = new URL(e.url);
      try {
        const res = await f(e.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
        await res.body?.cancel().catch(() => undefined);
        const s = res.status;
        const auth = s === 401 || s === 403;
        const cc = osi.config.clientCertFor(cfg, e.url);
        add(`registry:${e.kind}`, s >= 500 ? 'fail' : auth || s === 407 ? 'warn' : 'ok',
          `${u.host}: HTTP ${s}${s === 407 ? ' (the proxy requires authentication: the kernel\'s own requests go without credentials, O4)' : auth ? (cc ? ' (needs its credential or client certificate: used by the builders only)' : ' (needs its credential: used by the builders only)') : ''}`);
      } catch (err) {
        add(`registry:${e.kind}`, 'fail', `${u.host}: ${failureCategory(err)}`);
      }
    }
  }
  return { configured: true, ok: !checks.some((c) => c.status === 'fail'), digest, checks };
}
