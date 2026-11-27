#!/usr/bin/env node
// Signs release metadata with the maintainer's Ed25519 key (D71). Run it on the
// maintainer's own machine: the private key never enters AuraOS, a git checkout
// or a release. See tools/release/README.md.
//
//   sign.mjs --key PRIVATE.pem --meta release-meta.json [--out release-meta.sig] [--passphrase-env VAR]
//   sign.mjs --key PRIVATE.pem --export-public [--out FILE]   write the public key for os/release-keys/
//
// Refuses: inside AuraOS (a running system or one of its sandboxes), a key file
// inside a git working tree, a key file readable by group or others.
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseMeta, parsePublicKey, signedMessage } from '../../os/release-verify.mjs';

export class SignRefused extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new SignRefused(code, message); };

/** Signs the exact metadata bytes; returns the release-meta.sig bytes. */
export function signMetaBytes(metaBytes, privateKey) {
  const meta = parseMeta(metaBytes);
  const pub = parsePublicKey(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
  if (meta.keyId !== pub.keyId) refuse('key-mismatch', `the metadata names key ${meta.keyId}, this key is ${pub.keyId} (cut with --key-id ${pub.keyId})`);
  const raw = edSign(null, signedMessage(metaBytes), privateKey);
  if (!edVerify(null, signedMessage(metaBytes), pub.key, raw)) refuse('self-check', 'the signature does not verify');
  return Buffer.from(`${JSON.stringify({ v: 1, alg: 'ed25519', keyId: pub.keyId, sig: raw.toString('base64') })}\n`);
}

/** Why this process must not touch a private release key, or null. */
export function insideAuraReason(env = process.env, exists = existsSync) {
  if (env.OS_API_BASE) return 'OS_API_BASE is set (an AuraOS Terminal or app)';
  if (env.AURA_DATA_DIR || exists('/data/aura')) return 'an AuraOS data directory is present (the AuraOS master)';
  if (exists('/aura/my-tools')) return '/aura/my-tools exists (an AuraOS sandbox)';
  return null;
}

/** Checks a key file's location and mode before it is read. */
export function checkKeyFile(file, { git = 'git' } = {}) {
  if (!existsSync(file)) refuse('no-key', `no key file at ${file}`);
  const st = statSync(file);
  if (st.mode & 0o077) refuse('key-mode', `${file} is readable by group or others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  let top = null;
  try {
    top = execFileSync(git, ['-C', dirname(realpathSync(file)), 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* not in a work tree: good */ }
  if (top) refuse('key-in-repo', `${file} is inside the git working tree ${top}; keep the private key outside every checkout`);
}

export function loadPrivateKey(file, passphrase) {
  let key;
  try { key = createPrivateKey({ key: readFileSync(file), format: 'pem', ...(passphrase ? { passphrase } : {}) }); }
  catch (e) { refuse('bad-key', `cannot read the private key (${e.code ?? 'error'}): encrypted keys need --passphrase-env`); }
  if (key.asymmetricKeyType !== 'ed25519') refuse('bad-key', `not an Ed25519 key (${key.asymmetricKeyType})`);
  return key;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv, []);
  try {
    if (!a.key || (!a.meta && !a['export-public'])) {
      process.stderr.write('usage: sign.mjs --key PRIVATE.pem --meta release-meta.json [--out FILE] | --key PRIVATE.pem --export-public [--out FILE]\n');
      return 64;
    }
    const why = insideAuraReason();
    if (why) refuse('inside-aura', `refusing to use a private release key inside AuraOS: ${why}. Sign on the maintainer's own machine (D71).`);
    checkKeyFile(a.key);
    const key = loadPrivateKey(a.key, a['passphrase-env'] ? process.env[a['passphrase-env']] : undefined);
    if (a['export-public']) {
      const pem = createPublicKey(key).export({ type: 'spki', format: 'pem' });
      const { keyId, fingerprint } = parsePublicKey(pem);
      const out = typeof a.out === 'string' ? a.out : `${keyId}.pub`;
      writeFileSync(out, pem, { mode: 0o644 });
      process.stdout.write(`public key ${keyId} (fingerprint ${fingerprint}) → ${out}\nadd it to os/release-keys/ in a release signed by a key that is already trusted (rotation), see tools/release/README.md\n`);
      return 0;
    }
    const out = typeof a.out === 'string' ? a.out : a.meta.replace(/\.json$/, '') + '.sig';
    writeFileSync(out, signMetaBytes(readFileSync(a.meta), key), { mode: 0o644 });
    process.stdout.write(`signed ${a.meta} → ${out}\nnext: node tools/release/cut.mjs tag --meta ${a.meta} --sig ${out}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof SignRefused) && !e.code) throw e;
    process.stderr.write(`sign: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
