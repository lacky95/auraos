// The infrastructure config store (D94 §4.1, O1): `/data/aura/infra/config.yaml`
// (non-secret, version 1, mode 0640) plus `trust/` (imported public PEMs).
// Writes are atomic (temp file + rename), keep the previous version as
// `config.yaml.prev`, and are validated before the swap. A seed staged by
// install.sh (`<state-dir>/seed/`) is imported only when no config exists yet
// (a later change is an explicit apply with a diff, never a silent overwrite).
// Dependency-free (see config.mjs); the kernel's IC-1 routes and CLI write
// through these functions.
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { InfraConfigError, configDigest, parseInfraConfig, toYaml } from './config.mjs';

export const STORE_HEADER = '# AuraOS infrastructure configuration (D94). Managed: change it with\n'
  + '# `aura admin infra apply -f <file>` or `install.sh --config <file>`, not by hand.\n';

/** The store directory under a data dir (`/data` → `/data/aura/infra`). */
export const infraDir = (dataDir = process.env.AURA_DATA_DIR ?? '/data') => join(dataDir, 'aura', 'infra');

const CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Checks a PEM certificate file's text; returns { pems, notAfter[] }. */
export function checkCertificatePem(text, label) {
  if (/PRIVATE KEY-----/.test(text)) throw new InfraConfigError([{ path: label, message: 'contains a private key: only public certificates go here' }]);
  const pems = text.match(CERT) ?? [];
  if (!pems.length) throw new InfraConfigError([{ path: label, message: 'no PEM certificate (-----BEGIN CERTIFICATE-----)' }]);
  const notAfter = pems.map((p) => {
    try { return new Date(new X509Certificate(p).validTo); } catch { throw new InfraConfigError([{ path: label, message: 'a certificate does not parse' }]); }
  });
  return { pems, notAfter };
}

/**
 * Reads a config file and the public files it names (relative to the
 * config's directory), and returns the form the store keeps: file paths
 * rewritten to `trust/<name>.pem` and `trust/client-<name>.crt`.
 * `{ config, text, files: {relPath: pem}, warnings, digest }`.
 */
export function stageConfig(configFile, { now = new Date() } = {}) {
  const baseDir = dirname(resolve(configFile));
  const { config, warnings } = parseInfraConfig(readFileSync(configFile, 'utf8'));
  const files = {};
  const errors = [];
  const load = (file, path, rel) => {
    const abs = isAbsolute(file) ? file : join(baseDir, file);
    if (!existsSync(abs)) { errors.push({ path, message: `file not found: ${abs}` }); return null; }
    try {
      const text = readFileSync(abs, 'utf8');
      const { pems, notAfter } = checkCertificatePem(text, path);
      for (const d of notAfter) {
        if (d < now) errors.push({ path, message: `certificate expired on ${d.toISOString().slice(0, 10)}` });
        else if (d - now < 30 * 864e5) warnings.push({ path, message: `certificate expires on ${d.toISOString().slice(0, 10)} (in under 30 days)` });
      }
      files[rel] = `${pems.join('\n')}\n`;
      return rel;
    } catch (e) {
      if (e instanceof InfraConfigError) { errors.push(...e.errors); return null; }
      throw e;
    }
  };
  (config.trust?.caCertificates ?? []).forEach((c, i) => { c.file = load(c.file, `trust.caCertificates[${i}].file`, `trust/${c.name}.pem`) ?? c.file; });
  (config.clientCertificates ?? []).forEach((c, i) => { c.certificate.file = load(c.certificate.file, `clientCertificates[${i}].certificate.file`, `trust/client-${c.name}.crt`) ?? c.certificate.file; });
  if (errors.length) throw new InfraConfigError(errors);
  return { config, text: STORE_HEADER + toYaml(config), files, warnings, digest: configDigest(config, files) };
}

function atomicWrite(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Writes a staged config into a store directory (validated again first). */
export function writeStore(dir, staged) {
  parseInfraConfig(staged.text);
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  for (const [rel, pem] of Object.entries(staged.files)) atomicWrite(join(dir, rel), pem, 0o644);
  const file = join(dir, 'config.yaml');
  if (existsSync(file)) copyFileSync(file, `${file}.prev`);
  atomicWrite(file, staged.text, 0o640);
  return { file, digest: staged.digest };
}

/** The stored config, or null when none exists. */
export function readStore(dir) {
  const file = join(dir, 'config.yaml');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const { config, warnings } = parseInfraConfig(text);
  const files = {};
  for (const c of config.trust?.caCertificates ?? []) files[c.file] = readFileSync(join(dir, c.file), 'utf8');
  for (const c of config.clientCertificates ?? []) files[c.certificate.file] = readFileSync(join(dir, c.certificate.file), 'utf8');
  return { file, text, config, warnings, files, digest: configDigest(config, files) };
}

/** Writes a store-form seed (what install.sh stages) into `<seedDir>`. */
export function writeSeed(seedDir, staged) {
  mkdirSync(seedDir, { recursive: true, mode: 0o750 });
  for (const [rel, pem] of Object.entries(staged.files)) atomicWrite(join(seedDir, rel), pem, 0o644);
  atomicWrite(join(seedDir, 'config.yaml'), staged.text, 0o640);
}

/** First boot / install: imports a seed only when the store has no config yet. */
export function importSeedIfAbsent(dir, seedDir) {
  if (existsSync(join(dir, 'config.yaml'))) return { imported: false, reason: 'present' };
  const seed = readStore(seedDir);
  if (!seed) return { imported: false, reason: 'no-seed' };
  const { digest } = writeStore(dir, { text: seed.text, files: seed.files, digest: seed.digest });
  return { imported: true, digest };
}
