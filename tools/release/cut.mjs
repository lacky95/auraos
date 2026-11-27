#!/usr/bin/env node
// Cuts an AuraOS release (D71). Replaces the .githooks version bumps (D36): the
// version moves once, when a release is cut, not on every commit to main.
// See tools/release/README.md for the whole flow (cut → sign → tag → push).
//
//   cut.mjs <version> --key-id ID [--security --severity low|medium|high|critical]
//           [--advisory ID]... [--supersedes VERSION]... [--min-from VERSION] [--notes-file FILE]
//           [--out DIR] [--repo DIR] [--allow-branch] [--no-commit]
//       Sets package.json "version", commits "release: v<version>" (hooks off: AURA_NO_BUMP=1),
//       writes <out>/release-meta.json (unsigned) for the exact commit and tree. The maturity comes from
//       the version: 0.1.0-alpha.1 → alpha, 0.1.0-beta.1 / -rc.1 → beta, 0.1.0 → stable (all signed).
//   cut.mjs tag --meta release-meta.json --sig release-meta.sig [--repo DIR] [--keys DIR]...
//       Verifies the signature (keys: the release's own os/release-keys/ plus --keys), then creates
//       the annotated tag v<version> carrying both. It never pushes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SEVERITIES, addKeyDir, maturityOfVersion, compareSemver, emptyTrust, extendTrust, isSemver, parseArgs, readTreeKeys,
  resolveCommit, tagMessage, validateMeta, verifyMeta, verifyTag,
} from '../../os/release-verify.mjs';

export class CutRefused extends Error { constructor(code, message) { super(message); this.code = code; } }
const refuse = (code, message) => { throw new CutRefused(code, message); };

const git = (repo, args, env = {}) => execFileSync('git', ['-C', repo, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
}).toString().trim();

const VERSION_LINE = /("version"\s*:\s*")([^"]*)(")/;

/** package.json text with only the first "version" value replaced (formatting kept). */
export function withVersion(pkgText, version) {
  if (!VERSION_LINE.test(pkgText)) refuse('no-version', 'package.json has no "version"');
  return pkgText.replace(VERSION_LINE, `$1${version}$3`);
}

/** The metadata object for a commit (validated). */
export function buildMeta({ version, commit, gitTree, keyId, securityUpdate = false, severity,
  advisories, supersedes, minFrom, notes, publishedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z') }) {
  const meta = { v: 1, product: 'auraos', version, commit, gitTree, maturity: maturityOfVersion(version), publishedAt, securityUpdate };
  if (severity) meta.severity = severity;
  if (advisories?.length) meta.advisories = advisories;
  if (supersedes?.length) meta.supersedes = supersedes;
  if (minFrom) meta.minFrom = minFrom;
  if (notes) meta.notes = notes;
  meta.keyId = keyId;
  return validateMeta(meta);
}

export function cut(opts) {
  const repo = realpathSync(opts.repo ?? '.');
  const { version } = opts;
  if (!isSemver(version)) refuse('usage', `not a version: ${version}`);
  if (!maturityOfVersion(version)) refuse('usage', `${version}: the prerelease part must be alpha.N, beta.N or rc.N (or none for stable)`);
  if (opts.securityUpdate && !SEVERITIES.includes(opts.severity)) refuse('usage', `--security needs --severity ${SEVERITIES.join('|')}`);
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (git(top, ['status', '--porcelain'])) refuse('dirty', 'the working tree has changes: commit or stash them first');
  const branch = git(top, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (branch !== 'main' && !opts.allowBranch) refuse('branch', `releases are cut on main (this is ${branch || 'a detached HEAD'}); --allow-branch to override`);
  if (existsSync(join(top, '.git')) && git(top, ['tag', '-l', `v${version}`])) refuse('exists', `tag v${version} exists already`);

  const out = resolve(opts.out ?? join(top, '..', `auraos-release-v${version}`));
  if (out === top || out.startsWith(`${top}/`)) refuse('out-in-repo', `--out ${out} is inside the checkout; release files stay out of the tree`);

  const pkgFile = join(top, 'package.json');
  const pkgText = readFileSync(pkgFile, 'utf8');
  const current = JSON.parse(pkgText).version;
  if (opts.noCommit) {
    if (current !== version) refuse('usage', `--no-commit needs package.json at ${version} already (it is ${current})`);
  } else {
    if (isSemver(current) && compareSemver(version, current) <= 0) refuse('downgrade', `${version} is not newer than package.json ${current}`);
    writeFileSync(pkgFile, withVersion(pkgText, version));
    git(top, ['add', '--', 'package.json']);
    // The legacy bump hooks must not move the version again (D36: cut owns it now).
    git(top, ['commit', '-q', '--no-verify', '-m', `release: v${version}`], { AURA_NO_BUMP: '1' });
  }
  const { commit, gitTree } = resolveCommit(top, 'HEAD');
  const meta = buildMeta({ ...opts, version, commit, gitTree, notes: opts.notesFile ? readFileSync(opts.notesFile, 'utf8') : undefined });
  mkdirSync(out, { recursive: true });
  const metaFile = join(out, 'release-meta.json');
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return { commit, gitTree, metaFile, meta };
}

export function tag({ repo = '.', meta: metaFile, sig: sigFile, keys = [] }) {
  const top = git(realpathSync(repo), ['rev-parse', '--show-toplevel']);
  const metaBytes = readFileSync(metaFile);
  const sigBytes = readFileSync(sigFile);
  const meta = validateMeta(JSON.parse(metaBytes.toString('utf8')));
  const { commit, gitTree } = resolveCommit(top, meta.commit);
  let trust = extendTrust(emptyTrust(), readTreeKeys(top, commit));
  for (const d of keys) trust = addKeyDir(trust, d);
  verifyMeta(metaBytes, sigBytes, trust, { commit, gitTree });
  const name = `v${meta.version}`;
  const msgFile = join(tmpdir(), `auraos-tag-${process.pid}.txt`);
  writeFileSync(msgFile, tagMessage(metaBytes, sigBytes));
  git(top, ['tag', '-a', '--cleanup=verbatim', '-F', msgFile, name, commit]);
  verifyTag(top, name, trust);
  return { tag: name, commit };
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv, ['advisory', 'supersedes', 'keys']);
  try {
    if (a._[0] === 'tag') {
      if (!a.meta || !a.sig) { process.stderr.write('usage: cut.mjs tag --meta FILE --sig FILE [--repo DIR] [--keys DIR]...\n'); return 64; }
      const r = tag({ repo: a.repo, meta: a.meta, sig: a.sig, keys: a.keys });
      process.stdout.write(`tagged ${r.tag} at ${r.commit}\npublish: git push origin main ${r.tag}\n`);
      return 0;
    }
    const version = a._[0];
    if (!version || !a['key-id']) { process.stderr.write('usage: cut.mjs <version> --key-id ID [options] (see the file header)\n'); return 64; }
    const r = cut({
      repo: a.repo, version, keyId: a['key-id'], securityUpdate: a.security === true,
      severity: a.severity, advisories: a.advisory, supersedes: a.supersedes, minFrom: a['min-from'],
      notesFile: a['notes-file'], out: a.out, allowBranch: a['allow-branch'] === true, noCommit: a['no-commit'] === true,
    });
    process.stdout.write(`release v${version}: commit ${r.commit}, tree ${r.gitTree}\nmetadata → ${r.metaFile}\n`
      + `next (on the maintainer machine): node tools/release/sign.mjs --key <private.pem> --meta ${r.metaFile}\n`);
    return 0;
  } catch (e) {
    if (!e.code) throw e;
    process.stderr.write(`cut: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
