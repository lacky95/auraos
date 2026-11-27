// Fixtures for the D71 release tests: throwaway Ed25519 keys (generated per
// test run, never stored) and small git repositories with release tags.
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ROOT = new URL('../../../', import.meta.url).pathname;
export const V = await import(join(ROOT, 'os/release-verify.mjs'));
export const CUT = await import(join(ROOT, 'tools/release/cut.mjs'));
export const SIGN = await import(join(ROOT, 'tools/release/sign.mjs'));

export function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const { keyId, fingerprint } = V.parsePublicKey(pem);
  return { pem, privateKey, keyId, fingerprint };
}

export const tmp = (prefix = 'aura-rel-') => mkdtempSync(join(tmpdir(), prefix));

export const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, AURA_NO_BUMP: '1' },
}).toString().trim();

/** A repo on main with package.json and the given `os/release-keys/` keys. */
export function makeRepo(keys = []) {
  const dir = tmp('aura-rel-repo-');
  write(dir, 'package.json', '{\n  "name": "aura",\n  "version": "0.0.1",\n  "private": true\n}\n');
  write(dir, 'README.md', 'x\n');
  for (const k of keys) write(dir, `os/release-keys/${k.keyId}.pub`, k.pem);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

export function write(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

export function commitAll(dir, msg = 'change') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
}

/** cut + sign + tag with `key`; returns { tag, commit, metaFile, sigFile }. */
export function release(dir, version, key, { raw = false, ...opts } = {}) {
  const out = tmp('aura-rel-out-');
  const r = CUT.cut({ repo: dir, version, keyId: key.keyId, out, ...opts });
  const sigFile = join(out, 'release-meta.sig');
  writeFileSync(sigFile, SIGN.signMetaBytes(execFileSync('cat', [r.metaFile]), key.privateKey));
  if (raw) {
    // Tag without cut's own check (a release the maintainer side would refuse).
    rawTag(dir, `v${version}`, V.tagMessage(readFileSync(r.metaFile), readFileSync(sigFile)), r.commit);
    return { tag: `v${version}`, commit: r.commit, metaFile: r.metaFile, sigFile, meta: r.meta };
  }
  const keysDir = tmp('aura-rel-keys-');
  writeFileSync(join(keysDir, 'signer.pub'), key.pem);
  const t = CUT.tag({ repo: dir, meta: r.metaFile, sig: sigFile, keys: [keysDir] });
  return { ...t, metaFile: r.metaFile, sigFile, meta: r.meta };
}

/** An annotated tag with an arbitrary message (for tampering tests). */
export function rawTag(dir, name, message, commit = 'HEAD') {
  const f = join(tmp('aura-rel-msg-'), 'msg');
  writeFileSync(f, message);
  git(dir, 'tag', '-a', '--cleanup=verbatim', '-F', f, name, commit);
}

export const trustOf = (...keys) => V.addKeys(V.emptyTrust(), keys.map((k) => ({ pem: k.pem, source: 'test' })));
