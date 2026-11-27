#!/usr/bin/env node
// AuraOS release verifier (D71). Dependency-free: node:crypto, node:fs and the
// `git` binary only, so it runs before anything of a release is installed or
// built: from install.sh (the installer's own copy), the release builder (the
// running release's copy) and the host recovery script (rollback).
//
// Nothing from a candidate release runs before this said yes, and the keys it
// trusts never come from the candidate itself: they are the verifier side's
// own `os/release-keys/` (shipped with the installer or the running release),
// keys the host operator added or pinned, and successor keys introduced by a
// release that verified with those (rotation, see `extendTrust`).
//
// ── release-meta.json v1 ────────────────────────────────────────────────────
//   { "v": 1, "product": "auraos", "version": "0.1.0",
//     "commit": "<40|64 hex>", "gitTree": "<the commit's tree id>",
//     "maturity": "alpha" | "beta" | "stable", "publishedAt": "<ISO 8601 UTC>",
//     "securityUpdate": false, "severity"?: "low|medium|high|critical",
//     "advisories"?: ["AURA-2026-001"], "supersedes"?: ["0.0.9"],
//     "minFrom"?: "0.0.5", "notes"?: "…", "keyId": "<signing key id>" }
// `commit` and `gitTree` bind the signature to the exact revision and its
// contents; a staged tree (git archive, no .git) is checked with
// `gitTreeOfDir`. Unknown fields are refused (a new field means v2).
//
// ── Trust and maturity are separate (owner, Phase 8 decision 5) ─────────────
// Every release of every maturity is a signed tag. The channel says which
// trust an install follows: `signed` = signed release tags only (default),
// `main` = the unsigned development head (owner opt-in). Within the signed
// channel, `maturity` is a signed label that must match the version's
// prerelease part (`-alpha.N` → alpha, `-beta.N`/`-rc.N` → beta, none →
// stable); an install or update picks the newest signed release at or above
// its maturity floor. Selection reads the maturity from the tag NAME (which
// the signature binds through `version`), never from unverified bytes.
//
// ── release-meta.sig ────────────────────────────────────────────────────────
//   { "v": 1, "alg": "ed25519", "keyId": "<16 hex>", "sig": "<base64>" }
// The signature covers SIG_DOMAIN + the exact bytes of release-meta.json (no
// canonicalisation: the bytes are carried armored, so they cannot drift).
//
// ── Where they live ─────────────────────────────────────────────────────────
// Git stays the distribution. Both travel in the annotated release tag
// `v<version>` as two armored blocks (tools/release/cut.mjs writes them), so
// `main` carries no release files. They can also be passed as files.
//
// ── Keys ────────────────────────────────────────────────────────────────────
// Ed25519 public keys as PEM (SPKI) files `*.pub`; the key id is the first 16
// hex digits of sha256(raw 32-byte key), the fingerprint all 64. A directory's
// `revoked.txt` lists revoked key ids (one per line, `#` comments); a revoked
// key is never trusted again, whatever else lists it.
//
// CLI (exit 0 ok, 1 refused, 64 usage; JSON on stdout):
//   release-verify.mjs tag --repo DIR --tag vX.Y.Z [--keys DIR]... [--key FILE]... [--pin ID]... [--maturity FLOOR]
//   release-verify.mjs select --repo DIR [--channel signed|main] [--maturity alpha|beta|stable] [--ref REF] [--keys DIR]... [--key FILE]... [--pin ID]...
//   release-verify.mjs files --meta FILE --sig FILE [--commit SHA] [--tree SHA] [--keys DIR]... [--key FILE]...
//   release-verify.mjs tree DIR                 the git tree id of a plain directory (no .git needed)
//   release-verify.mjs fingerprint FILE...      key id and fingerprint of public key files
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const META_VERSION = 1;
export const SIG_DOMAIN = 'AURAOS-RELEASE-META-V1\n';
export const CHANNELS = Object.freeze(['signed', 'main']);
export const MATURITIES = Object.freeze(['alpha', 'beta', 'stable']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
export const PROVENANCES = Object.freeze(['upstream-signed', 'upstream-unsigned', 'locally-modified']);
export const ARMOR_META = 'AURAOS RELEASE META';
export const ARMOR_SIG = 'AURAOS RELEASE SIGNATURE';
/** Where a release tree keeps its trusted keys (relative to the repo root). */
export const TREE_KEYS_DIR = 'os/release-keys';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const HEX = /^[0-9a-f]+$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ADVISORY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const META_FIELDS = new Set(['v', 'product', 'version', 'commit', 'gitTree', 'maturity', 'publishedAt', 'securityUpdate',
  'severity', 'advisories', 'supersedes', 'minFrom', 'notes', 'keyId']);

/** A refusal: `code` is stable for callers and tests, `message` is for people. */
export class ReleaseVerifyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuse = (code, message) => { throw new ReleaseVerifyError(code, message); };

// ── semver ──────────────────────────────────────────────────────────────────

export const isSemver = (v) => typeof v === 'string' && SEMVER.test(v);

/** The maturity a version's prerelease part names, or null for a label no maturity covers. */
export function maturityOfVersion(v) {
  const m = SEMVER.exec(String(v).replace(/^v/, ''));
  if (!m) return null;
  if (!m[4]) return 'stable';
  const label = m[4].split('.')[0];
  if (label === 'alpha') return 'alpha';
  if (label === 'beta' || label === 'rc') return 'beta';
  return null;
}

/** True when `maturity` is at least `floor` (alpha < beta < stable). */
export const meetsMaturity = (maturity, floor = 'alpha') => MATURITIES.indexOf(maturity) >= MATURITIES.indexOf(floor) && MATURITIES.includes(maturity);

/** -1, 0, 1 like a sort comparator (prerelease < release, numeric ids numerically). */
export function compareSemver(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) throw new ReleaseVerifyError('malformed', `not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (!pa[4] && !pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  const xa = pa[4].split('.'), xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return Math.sign(d); continue; }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// ── keys and trust ──────────────────────────────────────────────────────────

/** A public key from PEM text: Ed25519 only. */
export function parsePublicKey(text) {
  let key;
  try { key = createPublicKey({ key: String(text), format: 'pem' }); }
  catch { refuse('bad-key', 'not a PEM public key'); }
  if (key.asymmetricKeyType !== 'ed25519') refuse('bad-key', `not an Ed25519 key (${key.asymmetricKeyType})`);
  const raw = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  return { key, keyId: fingerprint.slice(0, 16), fingerprint };
}

/** A key id or fingerprint as the operator typed it (any case, `:`/space separated). */
export function normalizeKeyRef(ref) {
  const s = String(ref).toLowerCase().replace(/^(?:sha256|ed25519):/, '').replace(/[\s:]/g, '');
  if (!/^[0-9a-f]{16}$|^[0-9a-f]{64}$/.test(s)) refuse('bad-key', `not a key id or fingerprint: ${ref}`);
  return s;
}

/** Key ids from a `revoked.txt` text. */
export function parseRevoked(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    const s = line.replace(/#.*/, '').trim();
    if (!s) continue;
    out.add(normalizeKeyRef(s).slice(0, 16));
  }
  return out;
}

/** An empty trust set. Trust sets are values: every change returns a new one. */
export function emptyTrust() {
  return Object.freeze({ keys: new Map(), revoked: new Set() });
}

function withKeys(trust, add = [], revoked = []) {
  const keys = new Map(trust.keys);
  const rev = new Set(trust.revoked);
  for (const id of revoked) rev.add(id);
  for (const k of add) if (!keys.has(k.keyId)) keys.set(k.keyId, k);
  for (const id of rev) keys.delete(id);
  return Object.freeze({ keys, revoked: rev });
}

/** Adds PEM key texts (each `{ pem, source }`) and revoked ids. */
export function addKeys(trust, entries = [], revoked = []) {
  const parsed = entries.map(({ pem, source }) => ({ ...parsePublicKey(pem), source: source ?? 'unknown' }));
  return withKeys(trust, parsed, revoked);
}

/** Every `*.pub` of a directory plus its `revoked.txt`. A missing directory adds nothing. */
export function addKeyDir(trust, dir, source = dir) {
  if (!existsSync(dir)) return trust;
  const entries = [];
  let revoked = new Set();
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    if (name === 'revoked.txt') revoked = parseRevoked(readFileSync(file, 'utf8'));
    else if (name.endsWith('.pub')) entries.push({ pem: readFileSync(file, 'utf8'), source: `${source}/${name}` });
  }
  return addKeys(trust, entries, revoked);
}

/**
 * Keeps only the keys the operator pinned (key id or fingerprint). Refuses
 * when a pin matches no key: pinning must never silently widen trust.
 */
export function pinTrust(trust, refs) {
  if (!refs?.length) return trust;
  const want = refs.map(normalizeKeyRef);
  const keys = new Map();
  for (const w of want) {
    const hit = [...trust.keys.values()].find((k) => (w.length === 16 ? k.keyId === w : k.fingerprint === w));
    if (!hit) refuse('untrusted-key', `pinned key ${w} is not among the available keys`);
    keys.set(hit.keyId, hit);
  }
  return Object.freeze({ keys, revoked: new Set(trust.revoked) });
}

/**
 * Rotation: a release that verified with the current trust may introduce its
 * successor keys and revoke old ones through its own `os/release-keys/`.
 * Only call this with the keys of a release that already verified; never
 * with the candidate being verified.
 */
export function extendTrust(trust, treeKeys) {
  return addKeys(trust, treeKeys.keys.map((pem, i) => ({ pem, source: treeKeys.sources?.[i] ?? 'release' })), treeKeys.revoked);
}

/** For display and JSON: the trusted keys without key objects. */
export const describeTrust = (trust) => ({
  keys: [...trust.keys.values()].map(({ keyId, fingerprint, source }) => ({ keyId, fingerprint, source })),
  revoked: [...trust.revoked],
});

// ── metadata ────────────────────────────────────────────────────────────────

const objectId = (v) => typeof v === 'string' && (v.length === 40 || v.length === 64) && HEX.test(v);

/** The parsed metadata, or a `malformed` refusal naming the first problem. */
export function parseMeta(bytes) {
  let meta;
  try { meta = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { refuse('malformed', 'release metadata is not JSON'); }
  validateMeta(meta);
  return meta;
}

export function validateMeta(meta) {
  const bad = (why) => refuse('malformed', `release metadata: ${why}`);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) bad('not an object');
  if (meta.v !== META_VERSION) bad(`v is ${JSON.stringify(meta.v)}; this verifier reads v${META_VERSION} (a newer AuraOS is needed)`);
  for (const k of Object.keys(meta)) if (!META_FIELDS.has(k)) bad(`unknown field ${JSON.stringify(k)}`);
  if (meta.product !== 'auraos') bad('product must be "auraos"');
  if (!isSemver(meta.version)) bad('version is not semver');
  if (!objectId(meta.commit)) bad('commit is not a full object id');
  if (!objectId(meta.gitTree) || meta.gitTree.length !== meta.commit.length) bad('gitTree is not a full object id');
  if (!MATURITIES.includes(meta.maturity)) bad(`maturity must be one of ${MATURITIES.join(', ')}`);
  if (maturityOfVersion(meta.version) !== meta.maturity) bad(`maturity ${meta.maturity} does not match version ${meta.version} (-alpha.N, -beta.N/-rc.N or none)`);
  if (typeof meta.publishedAt !== 'string' || !ISO_UTC.test(meta.publishedAt)) bad('publishedAt must be ISO 8601 UTC');
  if (typeof meta.securityUpdate !== 'boolean') bad('securityUpdate must be true or false');
  if (meta.securityUpdate && !SEVERITIES.includes(meta.severity)) bad('a security update needs a severity');
  if (meta.severity !== undefined && !SEVERITIES.includes(meta.severity)) bad(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (meta.advisories !== undefined && !(Array.isArray(meta.advisories) && meta.advisories.every((a) => typeof a === 'string' && ADVISORY.test(a)))) bad('advisories must be a list of ids');
  if (meta.supersedes !== undefined && !(Array.isArray(meta.supersedes) && meta.supersedes.every(isSemver))) bad('supersedes must be a list of versions');
  if (meta.minFrom !== undefined && !isSemver(meta.minFrom)) bad('minFrom is not semver');
  if (meta.notes !== undefined && !(typeof meta.notes === 'string' && meta.notes.length <= 4000)) bad('notes must be text (at most 4000 characters)');
  if (typeof meta.keyId !== 'string' || !KEY_ID.test(meta.keyId)) bad('keyId must be 16 hex digits');
  return meta;
}

export function parseSig(bytes) {
  let sig;
  try { sig = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { refuse('malformed', 'release signature is not JSON'); }
  if (!sig || sig.v !== 1 || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || !KEY_ID.test(sig.keyId)
    || typeof sig.sig !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig.sig)) {
    refuse('malformed', 'release signature: expected {v:1, alg:"ed25519", keyId, sig}');
  }
  const raw = Buffer.from(sig.sig, 'base64');
  if (raw.length !== 64) refuse('malformed', 'release signature: not a 64-byte Ed25519 signature');
  return { ...sig, raw };
}

/** The bytes a signature covers. */
export const signedMessage = (metaBytes) => Buffer.concat([Buffer.from(SIG_DOMAIN, 'utf8'), Buffer.from(metaBytes)]);

export const metaDigest = (metaBytes) => `sha256:${createHash('sha256').update(Buffer.from(metaBytes)).digest('hex')}`;

/**
 * Verifies metadata bytes and signature bytes against a trust set, then the
 * expectations (`commit`, `gitTree`, `maturity` (a floor), `version`). Returns
 * `{ meta, keyId, fingerprint, keySource, metaDigest }`; throws a
 * ReleaseVerifyError (code: no-signature, malformed, untrusted-key,
 * revoked-key, bad-signature, commit-mismatch, tree-mismatch,
 * maturity-mismatch, version-mismatch) otherwise.
 */
export function verifyMeta(metaBytes, sigBytes, trust, expect = {}) {
  if (metaBytes == null || !Buffer.from(metaBytes).length) refuse('no-signature', 'no release metadata');
  if (sigBytes == null || !Buffer.from(sigBytes).length) refuse('no-signature', 'the release metadata is not signed');
  const sig = parseSig(sigBytes);
  if (trust.revoked.has(sig.keyId)) refuse('revoked-key', `signed with revoked key ${sig.keyId}`);
  const k = trust.keys.get(sig.keyId);
  if (!k) refuse('untrusted-key', `signed with key ${sig.keyId}, which is not trusted here`);
  if (!edVerify(null, signedMessage(metaBytes), k.key, sig.raw)) refuse('bad-signature', 'the signature does not match the release metadata');
  // Only signed bytes are interpreted.
  const meta = parseMeta(metaBytes);
  if (meta.keyId !== sig.keyId) refuse('bad-signature', 'the metadata names another signing key than its signature');
  if (expect.commit && meta.commit !== expect.commit) refuse('commit-mismatch', `metadata is for commit ${meta.commit}, not ${expect.commit}`);
  if (expect.gitTree && meta.gitTree !== expect.gitTree) refuse('tree-mismatch', `metadata is for tree ${meta.gitTree}, not ${expect.gitTree}`);
  if (expect.maturity && !meetsMaturity(meta.maturity, expect.maturity)) refuse('maturity-mismatch', `${meta.version} is a ${meta.maturity} release; this install follows ${expect.maturity} or later`);
  if (expect.version && meta.version !== expect.version) refuse('version-mismatch', `metadata is for version ${meta.version}, not ${expect.version}`);
  return { meta, keyId: k.keyId, fingerprint: k.fingerprint, keySource: k.source, metaDigest: metaDigest(metaBytes) };
}

// ── armor (the tag message) ─────────────────────────────────────────────────

export function armor(label, bytes) {
  const b64 = Buffer.from(bytes).toString('base64').replace(/(.{76})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** The bytes of one armored block, or null when the text has none. */
export function dearmor(text, label) {
  const m = new RegExp(`-----BEGIN ${label}-----\\n([A-Za-z0-9+/=\\n]+?)\\n?-----END ${label}-----`).exec(String(text));
  return m ? Buffer.from(m[1].replace(/\n/g, ''), 'base64') : null;
}

/** The tag message `tools/release/cut.mjs tag` writes. */
export function tagMessage(metaBytes, sigBytes) {
  const meta = parseMeta(metaBytes);
  return `AuraOS ${meta.version} (${meta.maturity}, signed${meta.securityUpdate ? `, security update: ${meta.severity}` : ''})\n\n`
    + armor(ARMOR_META, metaBytes) + armor(ARMOR_SIG, sigBytes);
}

// ── git ─────────────────────────────────────────────────────────────────────

const TAG_NAME = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const isReleaseTagName = (name) => typeof name === 'string' && TAG_NAME.test(name);

function git(repo, args, { buffer = false } = {}) {
  // safe.directory: the repo may belong to another uid (an installer helper
  // container reading the operator's mirror); it is only read here.
  const out = execFileSync('git', ['-c', 'safe.directory=*', '-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return buffer ? out : out.toString('utf8').trim();
}

const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

/** The commit and tree a ref resolves to. */
export function resolveCommit(repo, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) refuse('malformed', `not a ref: ${ref}`);
  const commit = tryGit(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (!commit) refuse('not-found', `${ref} is not a commit in ${repo}`);
  return { commit, gitTree: git(repo, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`]) };
}

/** An annotated tag's message, or null for a lightweight or missing tag. */
export function readTagMessage(repo, tag) {
  if (!isReleaseTagName(tag)) refuse('malformed', `not a release tag name: ${tag}`);
  if (tryGit(repo, ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') return null;
  const raw = git(repo, ['cat-file', 'tag', `refs/tags/${tag}`]);
  const cut = raw.indexOf('\n\n');
  return cut < 0 ? '' : raw.slice(cut + 2);
}

/** Release tags (`vX.Y.Z[-pre]`), newest first. */
export function listReleaseTags(repo) {
  const out = tryGit(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/tags/v*']) ?? '';
  return out.split('\n').filter(isReleaseTagName).sort((a, b) => compareSemver(b.slice(1), a.slice(1)));
}

/** The `os/release-keys/` of a commit: `{ keys: [pem], sources: [path], revoked: Set }`. */
export function readTreeKeys(repo, commit) {
  const out = { keys: [], sources: [], revoked: new Set() };
  const ls = git(repo, ['ls-tree', '-z', '--full-tree', commit, '--', `${TREE_KEYS_DIR}/`], { buffer: true }).toString('utf8');
  for (const entry of ls.split('\0').filter(Boolean)) {
    const [info, path] = entry.split('\t');
    const [, type, sha] = info.split(' ');
    if (type !== 'blob') continue;
    const text = git(repo, ['cat-file', 'blob', sha]);
    if (path.endsWith('/revoked.txt')) out.revoked = parseRevoked(text);
    else if (path.endsWith('.pub')) { out.keys.push(text); out.sources.push(`${commit.slice(0, 12)}:${path}`); }
  }
  return out;
}

/** The keys of a plain release tree (no .git): `os/release-keys/` read from disk. */
export function readDirKeys(root) {
  const dir = join(root, TREE_KEYS_DIR);
  const out = { keys: [], sources: [], revoked: new Set() };
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === 'revoked.txt') out.revoked = parseRevoked(readFileSync(join(dir, name), 'utf8'));
    else if (name.endsWith('.pub')) { out.keys.push(readFileSync(join(dir, name), 'utf8')); out.sources.push(`${TREE_KEYS_DIR}/${name}`); }
  }
  return out;
}

/** Metadata and signature bytes carried by a tag (either may be null). */
export function readTagRelease(repo, tag) {
  const msg = readTagMessage(repo, tag);
  return { metaBytes: msg ? dearmor(msg, ARMOR_META) : null, sigBytes: msg ? dearmor(msg, ARMOR_SIG) : null };
}

/**
 * Verifies a release tag: its signed metadata, and that the tag points at
 * exactly `meta.commit` whose tree is `meta.gitTree`, and that the tag is
 * named after `meta.version`.
 */
export function verifyTag(repo, tag, trust, expect = {}) {
  const { metaBytes, sigBytes } = readTagRelease(repo, tag);
  if (!metaBytes) refuse('no-signature', `${tag} carries no release metadata (not a release tag)`);
  const { commit, gitTree } = resolveCommit(repo, `refs/tags/${tag}`);
  const r = verifyMeta(metaBytes, sigBytes, trust, { ...expect, commit, gitTree, version: tag.slice(1) });
  return { ...r, tag, commit, gitTree };
}

/**
 * verifyTag, plus rotation: when the candidate's key is not trusted yet, the
 * older release tags are walked oldest first, and every one that verifies
 * with the trust so far contributes its own `os/release-keys/` (successor
 * keys, revocations). The candidate's own keys are never used for itself.
 */
export function verifyTagWithChain(repo, tag, trust, expect = {}) {
  try {
    return { ...verifyTag(repo, tag, trust, expect), chain: [] };
  } catch (e) {
    if (e.code !== 'untrusted-key') throw e;
  }
  const target = tag.slice(1);
  const older = listReleaseTags(repo).filter((t) => compareSemver(t.slice(1), target) < 0).reverse();
  let t = trust;
  const chain = [];
  for (const o of older) {
    let r;
    try { r = verifyTag(repo, o, t); } catch { continue; }
    t = extendTrust(t, readTreeKeys(repo, r.commit));
    chain.push({ tag: o, keyId: r.keyId });
  }
  return { ...verifyTag(repo, tag, t, expect), chain };
}

/**
 * Picks the release to install or update to.
 *  signed, no ref: the newest release tag at or above the maturity floor (by
 *    its name) that carries release metadata. It must verify: there is no
 *    fallback to an older or an unsigned one (no silent downgrade); name an
 *    older one with `ref`.
 *  signed, ref:    that release tag, any maturity (an explicit choice); verified the
 *    same way. A bare commit is refused.
 *  main:           `ref` (default: the branch head `refs/heads/main`), unsigned.
 * Returns `{ channel, maturity, ref, commit, gitTree, signed, provenance, meta?, keyId?, metaDigest?, chain? }`.
 */
export function selectRelease(repo, { channel = 'signed', maturity = 'alpha', ref, trust }) {
  if (!CHANNELS.includes(channel)) refuse('malformed', `unknown channel ${channel}`);
  if (!MATURITIES.includes(maturity)) refuse('malformed', `unknown maturity ${maturity}`);
  // The default floor is alpha while only alpha releases exist; it rises once beta/stable releases do (owner, 2026-11-27).
  if (channel === 'main') {
    const r = ref ?? 'refs/heads/main';
    const { commit, gitTree } = resolveCommit(repo, r);
    return { channel, maturity: null, ref: r, commit, gitTree, signed: false, provenance: provenanceOf({ channel, signed: false }) };
  }
  let tag = ref;
  if (tag === undefined) {
    const all = listReleaseTags(repo).filter((t) => readTagRelease(repo, t).metaBytes);
    tag = all.find((t) => meetsMaturity(maturityOfVersion(t), maturity));
    if (!tag) {
      refuse('no-release', all.length
        ? `no release at maturity ${maturity} or later (newest: ${all[0]}); choose a lower maturity floor or name a release`
        : 'no signed release tag found in the source');
    }
  } else if (!isReleaseTagName(tag)) {
    refuse('no-signature', `the signed channel installs signed release tags only (vX.Y.Z), not ${tag}; use the main channel for unsigned revisions`);
  }
  const r = verifyTagWithChain(repo, tag, trust, ref === undefined ? { maturity } : {});
  return {
    channel, maturity: r.meta.maturity, ref: tag, commit: r.commit, gitTree: r.gitTree, signed: true, provenance: provenanceOf({ channel, signed: true }),
    meta: r.meta, keyId: r.keyId, fingerprint: r.fingerprint, metaDigest: r.metaDigest, chain: r.chain,
  };
}

// ── git tree of a plain directory ───────────────────────────────────────────

/**
 * The git tree id of a directory, computed like `git write-tree` would for
 * its files (blobs, 100644/100755, symlinks; empty directories and `.git`
 * left out). The builder checks a `git archive` extraction with it, so a
 * release tree is bound to `meta.gitTree` without carrying a .git. `skip`
 * leaves out top-level names (the builder's `treeDigest` skips the release
 * record files it describes).
 */
export function gitTreeOfDir(dir, { algo = 'sha1', skip = [] } = {}) {
  const hash = (type, body) => createHash(algo).update(`${type} ${body.length}\0`).update(body).digest();
  const walk = (d) => {
    const entries = [];
    for (const name of readdirSync(d)) {
      if (name === '.git' || (d === dir && skip.includes(name))) continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) entries.push({ name, mode: '120000', id: hash('blob', Buffer.from(readlinkSync(p, { encoding: 'buffer' }))) });
      else if (st.isDirectory()) { const id = walk(p); if (id) entries.push({ name, mode: '40000', id, dir: true }); }
      else if (st.isFile()) entries.push({ name, mode: st.mode & 0o100 ? '100755' : '100644', id: hash('blob', readFileSync(p)) });
    }
    if (!entries.length) return null;
    const key = (e) => Buffer.from(e.dir ? `${e.name}/` : e.name, 'utf8');
    entries.sort((a, b) => Buffer.compare(key(a), key(b)));
    const body = Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), e.id]));
    return hash('tree', body);
  };
  const id = walk(dir);
  return (id ?? hash('tree', Buffer.alloc(0))).toString('hex');
}

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * upstream-signed    a verified signed release (any maturity), unchanged (empty patch series)
 * upstream-unsigned  the main channel (or anything else not verified)
 * locally-modified   any local change: a non-empty system patch series, or a
 *                    build from a Developer checkout (dirty or not)
 * A locally modified build is never shown as maintainer-signed (D71).
 */
export function provenanceOf({ channel, signed, seriesLength = 0, developerCheckout = false }) {
  if (developerCheckout || seriesLength > 0) return 'locally-modified';
  return channel === 'signed' && signed === true ? 'upstream-signed' : 'upstream-unsigned';
}

/** True only for what may be labelled "signed" anywhere. */
export const showsAsSigned = (provenance) => provenance === 'upstream-signed';

/** One line for `aura status`, Settings → About, diagnostics and the installer. */
export function provenanceLabel({ provenance, version, baseVersion, patches = 0 }) {
  if (provenance === 'upstream-signed') return `${version}, signed upstream release`;
  if (provenance === 'locally-modified') {
    const base = baseVersion ? `based on ${baseVersion}, ` : '';
    return `${base}locally modified${patches ? ` (${patches} patch${patches === 1 ? '' : 'es'})` : ' (Developer checkout)'}; not a signed release`;
  }
  return `${version ?? 'unreleased revision'}, unsigned (main channel)`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** Trust from CLI-style options: `keys` dirs, `key` files, then `pin`. */
export function trustFrom({ keys = [], key = [], pin = [] } = {}) {
  let t = emptyTrust();
  for (const d of keys) t = addKeyDir(t, d);
  t = addKeys(t, key.map((f) => ({ pem: readFileSync(f, 'utf8'), source: f })));
  return pinTrust(t, pin);
}

export function parseArgs(argv, multi = ['keys', 'key', 'pin']) {
  const out = { _: [] };
  for (const m of multi) out[m] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    const value = inline ?? (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    if (multi.includes(name)) out[name].push(value); else out[name] = value;
  }
  return out;
}

const jsonOut = (o) => process.stdout.write(`${JSON.stringify(o, (k, v) => (v instanceof Set ? [...v] : v), 2)}\n`);

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  const [cmd, ...rest] = a._;
  const usage = () => { process.stderr.write('usage: release-verify.mjs tag|select|files|tree|fingerprint … (see the file header)\n'); return 64; };
  try {
    switch (cmd) {
      case 'tag': {
        if (!a.repo || !a.tag) return usage();
        const r = verifyTagWithChain(a.repo, a.tag, trustFrom(a), a.maturity ? { maturity: a.maturity } : {});
        jsonOut({ ok: true, ...r, provenance: provenanceOf({ channel: 'signed', signed: true }) });
        return 0;
      }
      case 'select': {
        if (!a.repo) return usage();
        const channel = a.channel ?? 'signed';
        const r = selectRelease(a.repo, { channel, maturity: a.maturity ?? 'alpha', ref: a.ref === true ? undefined : a.ref, trust: channel === 'main' ? emptyTrust() : trustFrom(a) });
        jsonOut({ ok: true, ...r });
        return 0;
      }
      case 'files': {
        if (!a.meta || !a.sig) return usage();
        const r = verifyMeta(readFileSync(a.meta), readFileSync(a.sig), trustFrom(a),
          { ...(a.commit ? { commit: a.commit } : {}), ...(a.tree ? { gitTree: a.tree } : {}), ...(a.maturity ? { maturity: a.maturity } : {}) });
        jsonOut({ ok: true, ...r });
        return 0;
      }
      case 'tree': {
        if (rest.length !== 1) return usage();
        jsonOut({ ok: true, gitTree: gitTreeOfDir(rest[0], { algo: a.algo === 'sha256' ? 'sha256' : 'sha1' }) });
        return 0;
      }
      case 'fingerprint': {
        if (!rest.length) return usage();
        jsonOut({ ok: true, keys: rest.map((f) => { const k = parsePublicKey(readFileSync(f, 'utf8')); return { file: f, keyId: k.keyId, fingerprint: k.fingerprint }; }) });
        return 0;
      }
      default: return usage();
    }
  } catch (e) {
    if (!(e instanceof ReleaseVerifyError)) throw e;
    jsonOut({ ok: false, code: e.code, error: e.message });
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
