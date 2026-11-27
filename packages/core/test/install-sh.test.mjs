// Phase 6 stream I (+ D94 IC-2): install.sh, driven with a fake `docker` and
// `curl` (they record their argv) and real git and node. Checks the preflight,
// the refusal paths (nothing is fetched, built or started when something is
// wrong), release verification before anything runs, and that no credential
// reaches argv, stdout or the install log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, V, commitAll, git, makeRepo, release, throwawayKey, tmp, write } from './release-fixtures.mjs';
import { CANARY, EXAMPLE, exampleFixture } from './infra-fixtures.mjs';
import { auraSource, fakeDocker } from './release-builder-fixtures.mjs';

function fakeBin({ dockerVersion = '27.3.1', composeVersion = '2.29.7' } = {}) {
  // docker: the release builder tests' fake (records argv, simulates images and build containers).
  const bin = tmp('aura-fakebin-');
  const log = join(bin, 'calls.log');
  const data = tmp('aura-fakedata-');
  const docker = fakeDocker(data, { bin });
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
printf 'curl %s\\n' "$*" >> '${log}'
for a in "$@"; do case "$a" in -K) k=1 ;; *) [ -n "\${k:-}" ] && { cat "$a" >> '${log}.curlrc'; k=; } ;; esac; done
printf 200
`);
  chmodSync(join(bin, 'curl'), 0o755);
  return {
    bin, log, data,
    env: { ...docker.env, FAKE_DOCKER_STATE: bin, FAKE_DOCKER_VERSION: dockerVersion, FAKE_COMPOSE_VERSION: composeVersion },
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

function install(args, { fake = fakeBin(), env = {} } = {}) {
  const state = env.STATE ?? join(tmp('aura-inst-'), 'state');
  const r = spawnSync('sh', [join(ROOT, 'install.sh'), '--state-dir', state, ...args], {
    encoding: 'utf8', input: '',
    env: { ...process.env, ...fake.env, HOME: tmp(), GIT_CONFIG_NOSYSTEM: '1', AURA_INSTALL_MIN_DISK_GB: '0', AURA_INSTALL_READY_TIMEOUT: '30', ...env },
  });
  const logs = existsSync(join(state, 'logs')) ? readdirSync(join(state, 'logs')).map((f) => readFileSync(join(state, 'logs', f), 'utf8')).join('') : '';
  return { ...r, out: r.stdout + r.stderr, state, calls: fake.calls(), log: logs };
}

/** A source repo with a signed release; returns { url, key, keyFile }. */
function signedSource({ tamper = false, version = '0.1.0' } = {}) {
  const key = throwawayKey();
  const dir = makeRepo();
  write(dir, 'docker-compose.yml', 'services: {}\n');
  commitAll(dir);
  const r = release(dir, version, key);
  if (tamper) {
    // Re-point the release tag at a commit with other contents, same signed message.
    write(dir, 'evil.sh', 'x\n');
    commitAll(dir, 'evil');
    const msg = git(dir, 'cat-file', 'tag', `v${version}`).split('\n\n').slice(1).join('\n\n');
    git(dir, 'tag', '-d', `v${version}`);
    const f = join(tmp(), 'm');
    writeFileSync(f, `${msg}\n`);
    git(dir, 'tag', '-a', '--cleanup=verbatim', '-F', f, `v${version}`, 'HEAD');
  }
  const keyFile = join(tmp(), 'release.pub');
  writeFileSync(keyFile, key.pem);
  return { url: `file://${dir}`, dir, key, keyFile, commit: r.commit };
}

/** A system patch series directory (saved form) on `commit` of `srcDir`: one edit per [subject, path, text]. */
function seriesOn(srcDir, commit, edits) {
  const work = tmp('aura-inst-series-work-');
  git(work, 'clone', '-q', srcDir, '.');
  git(work, 'checkout', '-q', commit);
  for (const [subject, path, text] of edits) { write(work, path, text); git(work, 'add', '-A'); git(work, '-c', 'user.name=t', '-c', 'user.email=t@x.invalid', 'commit', '-qm', subject); }
  const out = tmp('aura-inst-series-out-');
  git(work, 'format-patch', '-q', '--zero-commit', '--no-signature', '--no-numbered', '-o', out, `${commit}..HEAD`);
  const dir = tmp('aura-inst-series-');
  mkdirSync(join(dir, 'patches'));
  const patches = readdirSync(out).sort().map((f, i) => {
    const content = readFileSync(join(out, f), 'utf8');
    writeFileSync(join(dir, 'patches', f), content);
    return { file: `patches/${f}`, subject: edits[i][0], sha256: createHash('sha256').update(content).digest('hex'), enabled: true };
  });
  writeFileSync(join(dir, 'aura-patches.yaml'), `${JSON.stringify({ v: 2, target: { kind: 'system' }, base: { commit }, patches }, null, 2)}\n`);
  return dir;
}

test('--patches: argument rules (Normal Mode only, a pinned commit for git URLs)', () => {
  assert.equal(install(['--developer', '--patches', tmp()]).status, 64);
  assert.match(install(['--patches', 'https://example.invalid/p.git']).out, /needs --patches-ref <commit>/);
  assert.match(install(['--patches', 'https://example.invalid/p.git', '--patches-ref', 'main']).out, /full commit hash/);
  assert.equal(install(['--patches-ref', 'a'.repeat(40)]).status, 64);
  assert.equal(install(['--patches', '/nonexistent-dir']).status, 64);
});

test('--patches: validated and authorized before any build; the patched first release and the store with history', () => {
  const key = throwawayKey();
  const src = auraSource(key, { extra: (d) => write(d, 'packages/core/src/probe/probe.ts', 'export const PROBE = "upstream";\n') });
  const keyFile = join(tmp(), 'release.pub');
  writeFileSync(keyFile, key.pem);
  const series = seriesOn(src.dir, src.commit, [['probe: patched', 'packages/core/src/probe/probe.ts', 'export const PROBE = "patched";\n']]);
  const base = ['--source', `file://${src.dir}`, '--trusted-key', keyFile, '--patches', series];
  // Unattended without the digest: refused, nothing built.
  const f1 = fakeBin();
  const r1 = install(base, { fake: f1 });
  assert.equal(r1.status, 3, r1.out);
  const digest = /unattended: authorize the series with --accept-patches (sha256:[0-9a-f]{64})/.exec(r1.out)?.[1];
  assert.ok(digest, r1.out);
  assert.match(r1.out, /patch +probe: patched/);
  assert.doesNotMatch(r1.calls, /builder\.mjs build /, 'nothing built before the authorization');
  // A wrong digest: refused before any build.
  const r2 = install([...base, '--accept-patches', `sha256:${'0'.repeat(64)}`]);
  assert.equal(r2.status, 3);
  assert.match(r2.out, /does not match the series digest/);
  assert.doesNotMatch(r2.calls, /builder\.mjs build /);
  // Authorized: the first release is patched, locally-modified, and the store keeps the series as approved + active.
  const f3 = fakeBin();
  const r3 = install([...base, '--accept-patches', digest], { fake: f3 });
  assert.equal(r3.status, 3, r3.out);
  assert.match(r3.out, /patch series authorized \(sha256:[0-9a-f]{64}\) and stored as revision [0-9a-f]{40}/);
  assert.match(r3.out, /release \S+ built \(read-only, current\)/);
  const ptr = JSON.parse(readFileSync(join(f3.data, 'aura/release/pointer.json'), 'utf8'));
  const rec = JSON.parse(readFileSync(join(f3.data, 'releases', ptr.current, 'release.json'), 'utf8'));
  assert.equal(rec.provenance, 'locally-modified');
  assert.equal(rec.series.digest, digest);
  assert.equal(rec.basedOn.signed, true);
  assert.match(readFileSync(join(f3.data, 'releases', ptr.current, 'packages/core/src/probe/probe.ts'), 'utf8'), /patched/);
  const store = join(f3.data, 'patches/system');
  const rev = git(store, 'rev-parse', 'HEAD');
  assert.equal(git(store, 'rev-parse', 'refs/aura/active'), rev);
  assert.equal(git(store, 'rev-parse', 'refs/aura/approved/1'), rev);
  assert.match(git(store, 'log', '-1', '--format=%s'), /install: imported from .* by the operator/);
  const hand = JSON.parse(readFileSync(join(f3.data, 'aura/install/patches-authorization.json'), 'utf8'));
  assert.equal(hand.digest, digest);
  assert.equal(hand.rev, rev);
});

test('--patches: a series on another base aborts; a refused or failing series leaves no active release', () => {
  const key = throwawayKey();
  const src = auraSource(key);
  const keyFile = join(tmp(), 'release.pub');
  writeFileSync(keyFile, key.pem);
  const other = seriesOn(src.dir, git(src.dir, 'rev-parse', 'HEAD~1'), [['x', 'README.md', 'other\n']]);
  const r = install(['--source', `file://${src.dir}`, '--trusted-key', keyFile, '--patches', other, '--accept-patches', 'sha256:00']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /is based on [0-9a-f]{40}, not on the selected release/);
  const anchor = seriesOn(src.dir, src.commit, [['key', 'os/release-keys/evil.pub', 'x\n']]);
  const r2 = install(['--source', `file://${src.dir}`, '--trusted-key', keyFile, '--patches', anchor, '--accept-patches', 'sha256:00']);
  assert.equal(r2.status, 3, r2.out);
  assert.match(r2.out, /patch series was refused/);
  assert.match(r2.out, /trust anchor/);
  const ok = seriesOn(src.dir, src.commit, [['p', 'README.md', 'patched\n']]);
  const f = fakeBin();
  const plan = install(['--source', `file://${src.dir}`, '--trusted-key', keyFile, '--patches', ok], { fake: f });
  const digest = /--accept-patches (sha256:[0-9a-f]{64})/.exec(plan.out)[1];
  const f2 = fakeBin();
  const r3 = install(['--source', `file://${src.dir}`, '--trusted-key', keyFile, '--patches', ok, '--accept-patches', digest], { fake: f2, env: { FAKE_FAIL_BUILD: '1' } });
  assert.equal(r3.status, 1, r3.out);
  assert.match(r3.out, /store is kept for inspection/);
  assert.equal(existsSync(join(f2.data, 'aura/release/pointer.json')), false, 'no active release');
  assert.ok(existsSync(join(f2.data, 'patches/system/aura-patches.yaml')));
});

test('--check-only: a green preflight writes nothing', () => {
  const src = signedSource();
  const r = install(['--check-only', '--source', src.url]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ok +Docker Engine 27\.3\.1/);
  assert.match(r.out, /git source reachable/);
  assert.match(r.out, /Preflight passed/);
  assert.equal(existsSync(r.state), false, 'check-only writes no state');
  assert.doesNotMatch(r.calls, /docker (compose .* up|build |buildx build|run )/);
});

test('preflight failures name the category, the endpoint and the fix', () => {
  const src = signedSource();
  const r = install(['--check-only', '--source', src.url], { fake: fakeBin({ dockerVersion: '24.0.7', composeVersion: '2.20.0' }) });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /FAIL +\[docker\] Docker Engine 24\.0\.7\n +fix: upgrade to Docker Engine >= 26/);
  assert.match(r.out, /FAIL +\[docker\] Docker Compose 2\.20\.0/);
  const r2 = install(['--check-only', '--source', 'file:///nonexistent/repo.git']);
  assert.equal(r2.status, 2);
  assert.match(r2.out, /FAIL +\[git\] file:\/\/\/nonexistent/);
});

test('an invalid config stops before any download, build or fetch', () => {
  const src = signedSource();
  const f = exampleFixture(EXAMPLE.replace('http://proxy.corp.example:3128        #', 'http://u:p@proxy.corp.example:3128 #'));
  const r = install(['--config', f.file, '--credentials-dir', f.creds, '--source', src.url, '--trusted-key', src.keyFile, '--developer', '--dir', join(tmp(), 'aura')]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /no user:password in URLs/);
  assert.match(r.out, /FAIL +\[config\]/);
  assert.doesNotMatch(r.calls, /docker (compose .* up|build |buildx build|run )|curl /);
  assert.equal(existsSync(join(r.state, 'source.git')), false);
});

test('a group-readable credential file is refused, naming the file but no value', () => {
  const src = signedSource();
  const f = exampleFixture();
  chmodSync(join(f.creds, 'proxy'), 0o644);
  const r = install(['--check-only', '--config', f.file, '--credentials-dir', f.creds, '--source', src.url]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /bootstrap:proxy: .*must be mode 0600/);
  assert.doesNotMatch(r.out, /CANARY/);
});

test('with a config: endpoints probed through the proxy and CA; no credential in argv, output or log', () => {
  const src = signedSource();
  const f = exampleFixture(EXAMPLE.replace('publicFallback: deny', 'publicFallback: allow'));
  const fake = fakeBin();
  const r = install(['--config', f.file, '--credentials-dir', f.creds, '--source', src.url, '--trusted-key', src.keyFile], { fake });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /ok +npm reachable: https:\/\/artifactory\.corp\.example\/api\/npm\/npm-remote\/ \(HTTP 200\)/);
  assert.match(r.calls, /curl -K \S+curlrc .*--cert \S+client-artifactory-mtls\.crt --key \S+client-artifactory-mtls\.key https:\/\/artifactory\.corp\.example/);
  const rc = readFileSync(`${fake.log}.curlrc`, 'utf8');
  assert.match(rc, /^proxy = "http:\/\/proxy\.corp\.example:3128"$/m);
  assert.match(rc, /^proxy-user = /m, 'the proxy credential reaches curl only through its 0600 config file');
  assert.match(rc, /^cacert = /m);
  for (const v of Object.values(CANARY)) {
    const secret = v.split(':')[1];
    assert.ok(!r.calls.includes(secret), 'not in argv');
    assert.ok(!r.out.includes(secret), 'not on stdout/stderr');
    assert.ok(!r.log.includes(secret), 'not in the install log');
  }
  assert.ok(r.log.length > 0, 'the install log exists');
  // Staged for the build: the seed and the non-secret override; per-build secrets are gone after the run.
  assert.ok(existsSync(join(r.state, 'seed/config.yaml')));
  assert.ok(existsSync(join(r.state, 'compose.infra.yml')));
  assert.equal(existsSync(join(r.state, 'rendered/secrets')), false);
  assert.equal(existsSync(join(r.state, 'compose.secrets.yml')), false);
});

test('the signed channel without a trust anchor is refused when unattended', () => {
  const src = signedSource();
  const r = install(['--source', src.url]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /ships no release key yet: pass --trusted-key/);
  assert.doesNotMatch(r.calls, /docker (compose .* up|run )/);
});

test('a tampered release is refused before anything from it runs', () => {
  const src = signedSource({ tamper: true });
  const r = install(['--source', src.url, '--trusted-key', src.keyFile, '--developer', '--dir', join(tmp(), 'aura')]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /release verification refused \(commit-mismatch\)/);
  assert.doesNotMatch(r.calls, /docker (compose .* up|run )/);
});

test('a wrong pinned key is refused', () => {
  const src = signedSource();
  const r = install(['--source', src.url, '--trusted-key', throwawayKey().keyId]);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /refused \(untrusted-key\)/);
});

test('Normal Mode (default): the release builder builds the verified release, then stops before the runtime (stream L)', () => {
  const key = throwawayKey();
  const src = auraSource(key);
  const keyFile = join(tmp(), 'release.pub');
  writeFileSync(keyFile, key.pem);
  const fake = fakeBin();
  const r = install(['--source', `file://${src.dir}`, '--trusted-key', keyFile], { fake });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Verified stable release 0\.1\.0 \(v0\.1\.0\): commit [0-9a-f]{40}/);
  assert.match(r.out, /ok +release builder runner aura-release-runner:[0-9a-f]{16} built/);
  assert.match(r.calls, /docker buildx build --load -t aura-release-runner:[0-9a-f]{16} --build-arg NODE_IMAGE=node:22\.23\.5-bookworm --build-arg DOCKER_CLI_IMAGE=docker:29\.3\.1-cli -f \S+os\/release\/runner\/Dockerfile \S+\/os$/m);
  const runner = r.calls.split('\n').find((l) => / aura-release-runner:\S+ node \S+os\/release\/builder\.mjs build /.test(l));
  assert.match(runner, /^docker run --rm --network none --name aura-release-builder .*-v \S+:\/var\/run\/docker\.sock -v aura[a-z0-9_-]*_aura-app-data:\/data /);
  assert.match(runner, /--data-root \/data --data-volume \S+_aura-app-data .*--expect-commit [0-9a-f]{40} .*--first-install/);
  assert.match(r.out, /stage: staged tree = verified tree/);
  assert.match(r.out, /release (0\.1\.0-[0-9a-f]{12}-[0-9a-f]{8}) built \(read-only, current\)/);
  assert.match(r.out, /the Normal-mode runtime \(Phase 6 stream L\) is not there yet: nothing was started/);
  const lines = r.calls.split('\n');
  const handoff = lines.findIndex((l) => / write-data --data \/data .*--system-mode normal --source-json /.test(l));
  const firstBuild = lines.findIndex((l) => /^docker (buildx build --load --target|run .*os\/release\/build\.sh)/.test(l));
  assert.ok(handoff >= 0 && firstBuild > handoff, r.calls);
  assert.doesNotMatch(r.calls, /docker compose .* up/, 'nothing started');
  // The release and the first pointer are on the data volume; no staging copy on the host.
  const ptr = JSON.parse(readFileSync(join(fake.data, 'aura/release/pointer.json'), 'utf8'));
  assert.equal(ptr.previous, null);
  assert.ok(existsSync(join(fake.data, 'releases', ptr.current, '.complete')));
  assert.equal(JSON.parse(readFileSync(join(fake.data, 'releases', ptr.current, 'release.json'), 'utf8')).provenance, 'upstream-signed');
  assert.deepEqual(readdirSync(r.state).filter((n) => n.startsWith('staging-')), []);
});

test('maturity floor: an alpha-only source is refused for --maturity stable, installed by default', () => {
  const src = signedSource({ version: '0.1.0-alpha.1' });
  const r = install(['--source', src.url, '--trusted-key', src.keyFile, '--maturity', 'stable']);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /no release at maturity stable or later \(newest: v0\.1\.0-alpha\.1\)/);
  assert.equal(install(['--maturity', 'nightly']).status, 64);
  assert.equal(install(['--channel', 'stable']).status, 64, 'stable is a maturity, not a channel');
});

test('Developer layout: verified checkout, first-boot handoff, then compose up', () => {
  const src = signedSource({ version: '0.1.0-alpha.1' });
  const dir = join(tmp(), 'aura-dev');
  const f = exampleFixture(EXAMPLE.replace('publicFallback: deny', 'publicFallback: allow'));
  const r = install(['--source', src.url, '--trusted-key', src.keyFile, '--developer', '--dir', dir, '--config', f.file, '--credentials-dir', f.creds]);
  assert.equal(r.status, 0, r.out);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), src.commit);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(dir, 'remote', 'get-url', 'origin'), src.url);
  const lines = r.calls.split('\n');
  const handoff = lines.findIndex((l) => / write-data --data \/data --seed .* --system-mode developer --source-json /.test(l));
  const up = lines.findIndex((l) => /^docker compose -p aura-dev --project-directory .* -f .*compose\.infra\.yml -f .*compose\.secrets\.yml up -d --build$/.test(l));
  assert.ok(handoff >= 0 && up > handoff, r.calls);
  assert.match(lines[handoff], /--network none/);
  assert.match(r.calls, /docker volume create --label com\.docker\.compose\.project=aura-dev --label com\.docker\.compose\.volume=aura-app-data aura-dev_aura-app-data/);
  assert.match(r.out, /Verified alpha release 0\.1\.0-alpha\.1/);
  assert.match(r.out, /AuraOS 0\.1\.0-alpha\.1 is running \(Developer Mode, locally-modified\)/);
  assert.match(r.out, /kept in .*credentials: this release does not import them/);
  for (const v of Object.values(CANARY)) assert.ok(!r.calls.includes(v.split(':')[1]) && !r.log.includes(v.split(':')[1]));
  assert.equal(existsSync(join(r.state, 'rendered/secrets')), false, 'build secrets removed after the build');
});

test('main channel: unsigned revisions only on explicit opt-in, shown as such', () => {
  const src = signedSource();
  const dir = join(tmp(), 'aura-main');
  const r = install(['--source', src.url, '--channel', 'main', '--developer', '--dir', dir]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /UNSIGNED development revision/);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(src.dir, 'rev-parse', 'main'));
});

test('the verifier the installer runs is its own copy, and the shipped key dir holds no private key', () => {
  const keysDir = join(ROOT, 'os/release-keys');
  for (const f of readdirSync(keysDir)) assert.doesNotMatch(readFileSync(join(keysDir, f), 'utf8'), /PRIVATE KEY/);
  const sh = readFileSync(join(ROOT, 'install.sh'), 'utf8');
  assert.match(sh, /HELPER="\$INSTALLER_ROOT\/os\/install\/installer\.mjs"/);
  assert.doesNotMatch(sh, /\$(STAGING|DIR)\/os\/(install|release-verify)/, 'never runs helpers from the candidate');
  assert.ok(V.isReleaseTagName('v1.2.3') && !V.isReleaseTagName('--upload-pack=x'));
});
