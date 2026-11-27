#!/usr/bin/env node
// install.sh's helper (D94 IC-2, stream I). install.sh orchestrates; the logic
// lives in the shared, dependency-free modules this file calls: the D94 config
// (os/infra/*) and the D71 verifier (os/release-verify.mjs). It runs from the
// installer's own copy, on the host's node or in a `--network none` node
// container. Output is for people, except where a subcommand says `KEY=value`
// lines (values are checked to be shell-safe before they are printed).
//
//   validate    --config F [--credentials-dir D]                 check the config and its refs
//   endpoints   --config F                                       kind<TAB>url<TAB>client-cert-name per line
//   net-config  --config F [--credentials-dir D] --out DIR [--system-bundle F]
//                 writes DIR/ca.pem, DIR/curlrc, DIR/gitconfig (0600; proxy credentials only here)
//   stage       --config F [--credentials-dir D] --state-dir S   seed, credentials, rendered files, compose overrides
//   override    --state-dir S [--config F]                       (re)render S/compose.infra.yml only
//   select      --repo R [--channel C] [--maturity M] [--ref REF] [--keys D]... [--key F]... [--pin ID]...   KEY=value lines
//   tree        DIR                                              the git tree id of a directory
//   fingerprint FILE...                                          key ids and fingerprints
//   requirements --repo R [--config F]                           what to mirror (D94 §6.1.5)
//   audit-public --repo R --config F                             public build inputs under publicFallback: deny
//   write-data  --data D [--seed S] [--credentials C] [--system-mode M] [--source-json F]   first-boot handoff into the data volume
//   build-inputs --state-dir S [--config F]                      the release builder's D94 inputs (JSON; paths, never values)
//   runner-plan --root R [--config F] [--node-image I]           RUNNER_TAG/RUNNER_NODE/RUNNER_CLI KEY=value lines
//   redact      [--config F --credentials-dir D]                 stdin → stdout with secrets redacted
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InfraConfigError, computeNoProxy, endpointsOf, parseInfraConfig, rewriteImage, rewriteUrl, toYaml, clientCertFor,
} from '../infra/config.mjs';
import { INFRA_ROOT, oci, proxy, renderInfra, trust } from '../infra/adapters/index.mjs';
import { renderTree, writeTree } from '../infra/render.mjs';
import { CredentialError, bootstrapName, checkConfigCredentials, knownSecretValues, readBootstrapCredential, redactSecrets, renderBuildSecrets } from '../infra/secrets.mjs';
import { importSeedIfAbsent, infraDir, readStore, stageConfig, writeSeed } from '../infra/store.mjs';
import { ReleaseVerifyError, gitTreeOfDir, main as verifierMain, parseArgs, selectRelease, emptyTrust, trustFrom } from '../release-verify.mjs';

const say = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s) => process.stderr.write(`${s}\n`);

export const { SYSTEM_BUNDLES, caBundle } = trust;

function writeSecretFile(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

const loadConfig = (file) => parseInfraConfig(readFileSync(file, 'utf8'));

/** The proxy URL (without credentials) a config uses for https, or null. */
const proxyOf = (cfg) => cfg.network?.proxy?.https ?? cfg.network?.proxy?.http ?? null;

/** Non-secret proxy env (both cases, NO_PROXY computed; the proxy adapter). */
export const proxyEnv = (cfg) => proxy.render(cfg, { noProxyExtra: [] }).env ?? {};

const readText = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8') : null);

/**
 * compose.infra.yml: non-secret only (the named build context with the
 * adapters' public render, the base-image registry arg, the runtime proxy env
 * and CA mount, DNS). Safe to keep. The image build reads proxy, CA and
 * mirrors from the named context (os/infra/build-env.sh), not from build args.
 */
export function renderInfraOverride(cfg, { publicDir, hasCorporateCa }) {
  const env = proxyEnv(cfg);
  const build = {};
  const args = oci.buildArgs(cfg);
  if (Object.keys(args).length) build.args = args;
  build.additional_contexts = { 'aura-infra-public': publicDir };
  const os = { build: { ...build } };
  const runtimeEnv = { ...env };
  if (hasCorporateCa) runtimeEnv.NODE_EXTRA_CA_CERTS = '/etc/aura/infra-install/corporate-ca.pem';
  if (Object.keys(runtimeEnv).length) os.environment = runtimeEnv;
  os.volumes = [`${publicDir}:/etc/aura/infra-install:ro`];
  const dns = cfg.network?.dns;
  // O11: the host (Docker's) resolver is the default, so `host`/`default` set
  // nothing; servers and search domains only when configured.
  if (Array.isArray(dns)) os.dns = dns;
  else if (dns && typeof dns === 'object') {
    if (dns.servers) os.dns = dns.servers;
    if (dns.search) os.dns_search = dns.search;
  }
  return '# Rendered by install.sh from the D94 infrastructure config: non-secret values only.\n'
    + '# Re-render with install.sh --config; do not edit.\n'
    + toYaml({ services: { 'aura-base': { build }, 'aura-os': os } });
}

/** compose.secrets.yml: BuildKit secret declarations for install-time builds only. */
export function renderSecretsOverride(ids, secretsDir) {
  if (!ids.length) return null;
  const secrets = Object.fromEntries(ids.map((id) => [id, { file: join(secretsDir, id) }]));
  return '# Rendered by install.sh: BuildKit secrets for this install\'s build only (D94 §6.3).\n'
    + toYaml({ services: { 'aura-base': { build: { secrets: ids } }, 'aura-os': { build: { secrets: ids } } }, secrets });
}

function cmdValidate(a) {
  const { config, warnings } = loadConfig(a.config);
  const creds = checkConfigCredentials(config, a['credentials-dir']);
  say(`config ${a.config}: valid (version ${config.version})`);
  for (const w of warnings) say(`  warning ${w.path}: ${w.message}`);
  for (const r of creds.refs) say(`  credential ${r.ref} (${r.path}): ${r.status}${r.message && r.status !== 'ok' ? ` - ${r.message}` : ''}`);
  // The files it names (CAs, client certificates) must exist and be public PEMs.
  stageConfig(a.config);
  if (!creds.ok) { fail('credential references are not resolvable (see above)'); return 1; }
  return 0;
}

function cmdEndpoints(a) {
  const { config } = loadConfig(a.config);
  for (const e of endpointsOf(config)) say([e.kind, e.url, clientCertFor(config, e.url)?.name ?? ''].join('\t'));
  return 0;
}

/**
 * Per-operation network config for the host's curl and git (0600 files in a
 * 0700 dir the caller removes): the CA bundle, the proxy with its
 * credential, client certificates, git rewrites and the git credential store.
 */
function cmdNetConfig(a) {
  const staged = stageConfig(a.config);
  const cfg = staged.config;
  const out = resolve(a.out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const bundle = caBundle(cfg, staged.files, readText(a['system-bundle'] ?? SYSTEM_BUNDLES.find((f) => existsSync(f))));
  writeSecretFile(join(out, 'ca.pem'), bundle);
  const curl = [];
  const git = [];
  if (bundle) { curl.push(`cacert = "${join(out, 'ca.pem')}"`); git.push('[http]', `\tsslCAInfo = ${join(out, 'ca.pem')}`); }
  const proxy = proxyOf(cfg);
  if (proxy) {
    curl.push(`proxy = "${proxy}"`);
    let gitProxy = proxy;
    const ref = cfg.network.proxy.credential?.ref;
    if (ref && bootstrapName(ref)) {
      const c = readBootstrapCredential(a['credentials-dir'], bootstrapName(ref));
      curl.push(`proxy-user = "${`${c.user}:${c.password}`.replace(/["\\]/g, '\\$&')}"`);
      const u = new URL(proxy); u.username = encodeURIComponent(c.user); u.password = encodeURIComponent(c.password); gitProxy = u.toString();
    }
    if (!git.includes('[http]')) git.push('[http]');
    git.push(`\tproxy = ${gitProxy}`);
    curl.push(`noproxy = "${computeNoProxy(cfg)}"`);
  }
  for (const [from, to] of Object.entries(cfg.registries?.git?.rewrites ?? {})) git.push(`[url "${to}"]`, `\tinsteadOf = ${from}`);
  const gitSecret = renderBuildSecrets({ registries: { git: cfg.registries?.git } }, a['credentials-dir']).infra_git;
  if (gitSecret) {
    writeSecretFile(join(out, 'git-credentials'), gitSecret);
    git.push('[credential]', `\thelper = store --file=${join(out, 'git-credentials')}`);
  }
  // mTLS (O8): a client certificate per host, for curl (per endpoint, see install.sh) and git.
  for (const cc of cfg.clientCertificates ?? []) {
    const key = readBootstrapCredential(a['credentials-dir'], bootstrapName(cc.key.ref));
    writeSecretFile(join(out, `client-${cc.name}.key`), key.pem);
    writeFileSync(join(out, `client-${cc.name}.crt`), staged.files[cc.certificate.file], { mode: 0o644 });
    for (const h of cc.hosts) git.push(`[http "https://${h}/"]`, `\tsslCert = ${join(out, `client-${cc.name}.crt`)}`, `\tsslKey = ${join(out, `client-${cc.name}.key`)}`);
  }
  writeSecretFile(join(out, 'curlrc'), `${curl.join('\n')}\n`);
  writeSecretFile(join(out, 'gitconfig'), `${git.join('\n')}\n`);
  say(`network config → ${out} (ca.pem, curlrc, gitconfig${gitSecret ? ', git-credentials' : ''})`);
  return 0;
}

/** Stages everything install-time: seed, credentials copy, rendered files, overrides. */
export function stage({ config: configFile, credentialsDir, stateDir, systemBundle }) {
  const staged = stageConfig(configFile);
  const cfg = staged.config;
  const creds = checkConfigCredentials(cfg, credentialsDir);
  if (!creds.ok) throw new CredentialError('refs', creds.refs.filter((r) => r.status !== 'ok' && r.status !== 'later').map((r) => r.message).join('\n'));
  const S = resolve(stateDir);
  mkdirSync(S, { recursive: true, mode: 0o750 });
  writeSeed(join(S, 'seed'), staged);
  // Bootstrap credentials: copied 0600 into <state-dir>/credentials (0700), outside every checkout and build context.
  const credDir = join(S, 'credentials');
  const names = [...new Set(creds.refs.map((r) => bootstrapName(r.ref)).filter(Boolean))];
  if (names.length) {
    mkdirSync(credDir, { recursive: true, mode: 0o700 });
    chmodSync(credDir, 0o700);
    for (const n of names) writeSecretFile(join(credDir, n), readFileSync(join(credentialsDir, n)));
  }
  // The named build context `aura-infra-public` = the adapters' public render,
  // the same tree the kernel renders into /data/aura/infra/generated (D36).
  const pub = join(S, 'rendered', 'public');
  rmSync(join(S, 'rendered'), { recursive: true, force: true });
  mkdirSync(pub, { recursive: true, mode: 0o755 });
  const sys = readText(systemBundle ?? SYSTEM_BUNDLES.find((f) => existsSync(f)));
  writeTree(pub, renderTree(renderInfra(cfg, { root: INFRA_ROOT, files: staged.files, systemBundle: sys })).tree);
  const corp = trust.corporateCas(cfg, staged.files);
  const secrets = renderBuildSecrets(cfg, names.length ? credDir : credentialsDir);
  const secDir = join(S, 'rendered', 'secrets');
  if (Object.keys(secrets).length) {
    mkdirSync(secDir, { recursive: true, mode: 0o700 });
    chmodSync(secDir, 0o700);
    for (const [id, content] of Object.entries(secrets)) writeSecretFile(join(secDir, id), content);
  }
  writeFileSync(join(S, 'compose.infra.yml'), renderInfraOverride(cfg, { publicDir: pub, hasCorporateCa: Boolean(corp) }), { mode: 0o644 });
  const sec = renderSecretsOverride(Object.keys(secrets).sort(), secDir);
  if (sec) writeFileSync(join(S, 'compose.secrets.yml'), sec, { mode: 0o600 });
  else rmSync(join(S, 'compose.secrets.yml'), { force: true });
  return { digest: staged.digest, credentials: names, secrets: Object.keys(secrets).sort(), warnings: staged.warnings, policy: cfg.policy ?? {} };
}

function cmdStage(a) {
  const r = stage({ config: a.config, credentialsDir: a['credentials-dir'], stateDir: a['state-dir'] });
  say(`staged config ${r.digest}`);
  for (const w of r.warnings) say(`  warning ${w.path}: ${w.message}`);
  say(`  bootstrap credentials: ${r.credentials.length ? r.credentials.join(', ') : 'none'}`);
  say(`  build secrets (BuildKit): ${r.secrets.length ? r.secrets.join(', ') : 'none'}`);
  return 0;
}

const SAFE = /^[A-Za-z0-9._:/@+-]*$/;
function envLines(obj) {
  for (const [k, v] of Object.entries(obj)) {
    const s = v === undefined || v === null ? '' : String(v);
    if (!SAFE.test(s)) throw new ReleaseVerifyError('malformed', `unsafe value for ${k}`);
    say(`${k}=${s}`);
  }
}

function cmdSelect(a) {
  const channel = a.channel ?? 'signed';
  try {
    const trust = channel === 'main' ? emptyTrust() : trustFrom(a);
    const r = selectRelease(a.repo, { channel, maturity: a.maturity ?? 'alpha', ref: typeof a.ref === 'string' ? a.ref : undefined, trust });
    envLines({
      REL_OK: 1, REL_CHANNEL: r.channel, REL_MATURITY: r.maturity ?? '', REL_REF: r.ref, REL_COMMIT: r.commit, REL_TREE: r.gitTree, REL_SIGNED: r.signed ? 1 : 0,
      REL_VERSION: r.meta?.version ?? '', REL_KEYID: r.keyId ?? '', REL_FINGERPRINT: r.fingerprint ?? '', REL_META_DIGEST: r.metaDigest ?? '',
      REL_SECURITY: r.meta?.securityUpdate ? r.meta.severity : '', REL_PROVENANCE: r.provenance, REL_CHAIN: (r.chain ?? []).map((c) => c.tag).join(','),
    });
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseVerifyError)) throw e;
    envLines({ REL_OK: 0, REL_CODE: e.code });
    fail(e.message);
    return 1;
  }
}

/** What an air-gapped or restricted network must mirror (D94 §6.1.5), from the Dockerfile and the lockfile. */
/** The Dockerfile with every `${ARG}` replaced by its default (ARG NAME=default lines). */
export function expandDockerfileArgs(df) {
  const args = {};
  for (const m of df.matchAll(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/gm)) args[m[1]] ??= m[2].replace(/^"(.*)"$/, '$1');
  return df.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (x, k) => args[k] ?? x);
}

/** A canonical image ref without the implied docker.io/library prefix. */
const shortImage = (ref) => ref.replace(/^docker\.io\/library\//, '').replace(/^docker\.io\//, '');

export function requirements(repo, cfg) {
  const df = expandDockerfileArgs(readFileSync(join(repo, 'Dockerfile'), 'utf8'));
  const stages = new Set([...df.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()));
  const images = new Set();
  for (const m of df.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)) if (!stages.has(m[1].toLowerCase()) && m[1] !== 'scratch' && !m[1].includes('$')) images.add(shortImage(m[1]));
  for (const m of df.matchAll(/--from=(\S+)/g)) if (!stages.has(m[1].toLowerCase()) && /[:/]/.test(m[1])) images.add(shortImage(m[1]));
  const clones = new Set([...df.matchAll(/git clone[^\n]*?(https?:\/\/[^\s"'`)\\]+)/g)].map((m) => m[1]));
  const urls = new Set([...df.matchAll(/https?:\/\/[^\s"'`)\\]+/g)].map((m) => m[0].replace(/[.,;]+$/, '')).filter((u) => !clones.has(u)));
  const pnpm = /pnpm@([0-9][^\s"']*)/.exec(df)?.[1] ?? 'latest (not pinned)';
  let packages = 0;
  const lock = join(repo, 'pnpm-lock.yaml');
  if (existsSync(lock)) {
    const text = readFileSync(lock, 'utf8');
    // Every `packages:` section: with a root `packageManager`, pnpm 12 writes the package manager's own
    // lockfile as a first YAML document (`---`) before the project's.
    for (const m of text.matchAll(/\npackages:\n([\s\S]*?)(?=\n\S|$)/g)) packages += (m[1].match(/^ {2}\S.*:$/gm) ?? []).length;
  }
  const mirrors = cfg?.registries?.oci?.mirrors ?? {};
  // The release builder's runner (Normal installs) pulls its two base images too.
  if (existsSync(join(repo, RUNNER_DOCKERFILE))) { const r = runnerBaseImages(repo); for (const i of [r.node, r.cli]) if (i) images.add(i); }
  return {
    images: [...images].sort().map((i) => ({ image: i, via: rewriteImage(i, mirrors) })),
    downloads: [...urls].sort().map((u) => ({ url: u, via: rewriteUrl(u, cfg?.registries?.artifacts?.rewrites ?? {}) })),
    clones: [...clones].sort().map((u) => ({ url: u, via: rewriteUrl(u, cfg?.registries?.git?.rewrites ?? {}) })),
    npm: { packages, pnpm, registry: cfg?.registries?.npm?.url ?? 'https://registry.npmjs.org/' },
    apt: { mirrors: cfg?.registries?.apt?.mirrors ?? { 'deb.debian.org': 'https://deb.debian.org', 'security.debian.org': 'https://security.debian.org' } },
    git: rewriteUrl('https://github.com/lacky95/auraos.git', cfg?.registries?.git?.rewrites ?? {}),
  };
}

function cmdRequirements(a) {
  const cfg = a.config ? loadConfig(a.config).config : null;
  const r = requirements(a.repo, cfg);
  say('Base images (pulled by the Docker daemon: daemon mirrors/proxy are operator-owned, D94 §6.5):');
  for (const i of r.images) say(`  ${i.image}${i.via !== i.image ? `  → ${i.via}` : ''}`);
  say('Downloads in the image build (artifacts.rewrites):');
  for (const d of r.downloads) say(`  ${d.url}${d.via !== d.url ? `  → ${d.via}` : ''}`);
  say('Git clones in the image build (registries.git.rewrites):');
  for (const d of r.clones) say(`  ${d.url}${d.via !== d.url ? `  → ${d.via}` : ''}`);
  say(`npm: ${r.npm.packages} packages from the lockfile + pnpm ${r.npm.pnpm}, registry ${r.npm.registry}`);
  say(`apt (Debian bookworm): ${Object.entries(r.apt.mirrors).map(([k, v]) => `${k} → ${v}`).join(', ')}`);
  say(`git source: ${r.git}`);
  return 0;
}

/** Under `policy.publicFallback: deny`: every build input that would still go to a public endpoint. */
export function auditPublic(repo, cfg) {
  if (cfg.policy?.publicFallback !== 'deny') return [];
  const r = requirements(repo, cfg);
  const out = [];
  for (const i of r.images) if (i.via === i.image) out.push(`image ${i.image}: no registries.oci.mirrors entry for its registry`);
  for (const d of r.downloads) if (d.via === d.url) out.push(`download ${d.url}: no registries.artifacts.rewrites prefix`);
  for (const d of r.clones) if (d.via === d.url) out.push(`git clone ${d.url}: no registries.git.rewrites prefix`);
  if (!cfg.registries?.npm) out.push('npm: no registries.npm (the lockfile would come from registry.npmjs.org)');
  if (!cfg.registries?.apt) out.push('apt: no registries.apt mirrors (deb.debian.org)');
  return out;
}

function cmdAuditPublic(a) {
  const { config } = loadConfig(a.config);
  const hits = auditPublic(a.repo, config);
  for (const h of hits) say(`  public: ${h}`);
  if (hits.length) { fail(`publicFallback: deny, but ${hits.length} build input(s) would go to public endpoints (fix the config, or allow)`); return 1; }
  return 0;
}

/** First-boot handoff into the data volume (run in a container with the volume at --data). */
export function writeData({ data, seed, credentials, systemMode, sourceJson }) {
  const out = {};
  if (seed) out.infra = importSeedIfAbsent(infraDir(data), seed);
  if (credentials) {
    // D94 IC-5: the kernel's first boot seals these into the System Context and deletes the dir.
    const imp = join(infraDir(data), 'import');
    mkdirSync(imp, { recursive: true, mode: 0o700 });
    chmodSync(imp, 0o700);
    const names = readdirSync(credentials).filter((n) => !n.startsWith('.'));
    for (const n of names) writeSecretFile(join(imp, n), readFileSync(join(credentials, n)));
    out.credentials = names.length;
  }
  if (systemMode) {
    if (!['normal', 'developer'].includes(systemMode)) throw new Error(`bad system mode ${systemMode}`);
    mkdirSync(join(data, 'aura'), { recursive: true });
    writeFileSync(join(data, 'aura', 'system-mode'), `${systemMode}\n`);
    out.systemMode = systemMode;
  }
  if (sourceJson) {
    const src = JSON.parse(readFileSync(sourceJson, 'utf8'));
    mkdirSync(join(data, 'aura', 'release'), { recursive: true });
    writeFileSync(join(data, 'aura', 'release', 'source.json'), `${JSON.stringify(src, null, 2)}\n`, { mode: 0o644 });
    out.source = true;
  }
  return out;
}

/**
 * The release builder's D94 build inputs (os/release/builder.mjs `--infra`)
 * from what `stage` rendered: non-secret build args and env, the BuildKit
 * secret FILES (paths only), the public named context and the corporate CA.
 * No config: every field empty (today's behaviour).
 */
export function buildInputs({ stateDir, config }) {
  const S = resolve(stateDir);
  const out = { v: 1, digest: null, buildArgs: {}, env: {}, secrets: {}, publicContext: null, caBundle: null, gitConfig: null };
  if (!config) return out;
  const staged = stageConfig(config);
  out.digest = staged.digest;
  out.buildArgs = proxyEnv(staged.config);
  out.env = proxyEnv(staged.config);
  const secDir = join(S, 'rendered', 'secrets');
  if (existsSync(secDir)) for (const id of readdirSync(secDir).sort()) out.secrets[id] = join(secDir, id);
  const pub = join(S, 'rendered', 'public');
  if (existsSync(pub)) {
    out.publicContext = pub;
    const corp = join(pub, 'corporate-ca.pem');
    if (existsSync(corp) && readFileSync(corp, 'utf8').trim()) out.caBundle = corp;
  }
  return out;
}

export const RUNNER_DOCKERFILE = 'os/release/runner/Dockerfile';
const HELPER_SOURCE = 'os/rename-exchange/rename-exchange.c';

/** The ARG defaults of the runner Dockerfile (its base images). */
export function runnerBaseImages(root) {
  const df = readFileSync(join(root, RUNNER_DOCKERFILE), 'utf8');
  const arg = (n) => new RegExp(`^ARG ${n}=(\\S+)$`, 'm').exec(df)?.[1];
  return { df, node: arg('NODE_IMAGE'), cli: arg('DOCKER_CLI_IMAGE') };
}

/**
 * The builder runner image (os/release/runner/Dockerfile): its base images
 * through the D94 OCI mirrors, and a tag that fingerprints the Dockerfile, the
 * base refs and the helper source (a changed input builds a new runner).
 */
export function runnerPlan({ root, config, nodeImage }) {
  const { df, node, cli } = runnerBaseImages(root);
  const mirrors = config ? loadConfig(config).config.registries?.oci?.mirrors ?? {} : {};
  const out = { node: rewriteImage(nodeImage ?? node, mirrors), cli: rewriteImage(cli, mirrors) };
  const h = createHash('sha256').update(df).update('\0').update(out.node).update('\0').update(out.cli).update('\0')
    .update(readFileSync(join(root, HELPER_SOURCE)));
  return { tag: `aura-release-runner:${h.digest('hex').slice(0, 16)}`, ...out };
}

const shellSafe = (v) => /^[A-Za-z0-9._:/@+-]+$/.test(v);

function cmdRunnerPlan(a) {
  const p = runnerPlan({ root: a.root, config: a.config, nodeImage: a['node-image'] });
  for (const [k, v] of [['RUNNER_TAG', p.tag], ['RUNNER_NODE', p.node], ['RUNNER_CLI', p.cli]]) {
    if (!shellSafe(v)) { fail(`runner-plan: unsafe image reference ${JSON.stringify(v)}`); return 1; }
    say(`${k}=${v}`);
  }
  return 0;
}

function cmdRedact(a) {
  let known = [];
  if (a.config && a['credentials-dir']) {
    try { known = knownSecretValues(loadConfig(a.config).config, a['credentials-dir']); } catch { /* still redact patterns */ }
  }
  const text = readFileSync(0, 'utf8');
  process.stdout.write(redactSecrets(text, known));
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  const need = (...ks) => { const miss = ks.filter((k) => !a[k] || a[k] === true); if (miss.length) throw Object.assign(new Error(`${cmd}: missing --${miss.join(', --')}`), { code: 'usage' }); };
  try {
    switch (cmd) {
      case 'validate': need('config'); return cmdValidate(a);
      case 'endpoints': need('config'); return cmdEndpoints(a);
      case 'net-config': need('config', 'out'); return cmdNetConfig(a);
      case 'stage': need('config', 'state-dir'); return cmdStage(a);
      case 'select': need('repo'); return cmdSelect(a);
      case 'tree': return verifierMain(['tree', ...rest]);
      case 'fingerprint': return verifierMain(['fingerprint', ...rest]);
      case 'requirements': need('repo'); return cmdRequirements(a);
      case 'audit-public': need('repo', 'config'); return cmdAuditPublic(a);
      case 'write-data': need('data'); say(JSON.stringify(writeData({ data: a.data, seed: a.seed, credentials: a.credentials, systemMode: a['system-mode'], sourceJson: a['source-json'] }))); return 0;
      case 'store-show': need('data'); { const s = readStore(infraDir(a.data)); say(s ? `${s.file} ${s.digest}` : 'no infrastructure config'); return 0; }
      case 'runner-plan': need('root'); return cmdRunnerPlan(a);
      case 'build-inputs': need('state-dir'); say(JSON.stringify(buildInputs({ stateDir: a['state-dir'], config: a.config }))); return 0;
      case 'redact': return cmdRedact(a);
      case 'node-ok': return 0;
      default: fail('usage: installer.mjs validate|endpoints|net-config|stage|select|tree|fingerprint|requirements|audit-public|write-data|build-inputs|runner-plan|redact (see the file header)'); return 64;
    }
  } catch (e) {
    if (e instanceof InfraConfigError) { fail(`infrastructure config is invalid:\n${e.errors.map((x) => `  ${x.path || '(root)'}: ${x.message}`).join('\n')}`); return 1; }
    if (e instanceof CredentialError) { fail(e.message); return 1; }
    if (e.code === 'usage') { fail(e.message); return 64; }
    if (e.code === 'ENOENT') { fail(`not found: ${e.path}`); return 1; }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
