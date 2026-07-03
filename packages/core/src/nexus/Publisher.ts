/**
 * Nexus publisher. v1 = Git publish working end-to-end; OCI publish is a
 * thin shell-out to `oras push` when the binary is available.
 *
 * Git flow:
 *   1. Validate the local manifest at `<path>/app.manifest.json`.
 *   2. Pick the target git repo URL (`--repo` flag → manifest.publish.repo
 *      → `git remote get-url origin` of the local repo).
 *   3. Stage the source into `data/nexus/publish-staging/<id>-<ts>/`
 *      respecting `.gitignore` + `manifest.publish.ignore[]`.
 *   4. Initialise or clone the target repo into the staging dir.
 *   5. Sync source on top, commit, tag, push.
 *
 * No tokens stored — relies on the user's existing `git` credentials
 * (~/.gitconfig, ssh keys, GitHub CLI auth, etc.). For v1 that's the
 * simplest auth surface; per-Nexus tokens land in v2 with cosign.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { validateStagedDir } from './Validator.js';
import { APP_ARTIFACT_TYPE, APP_REPO_PREFIX, buildStoreAnnotations } from './ociMetadata.js';
import type { AppManifest } from '../types/manifest.js';

export interface PublishGitOpts {
  /** Local app dir to publish. */
  appPath:   string;
  /** Target git repo (https URL, `github.com/user/repo`, or `git@…`). */
  repo?:     string;
  /** Branch to push (default `main`). */
  branch?:   string;
  /** Version tag — default: manifest.version prefixed with `v`. */
  tag?:      string;
  /** Channel label (extra tag pushed alongside, e.g. `stable`). */
  channel?:  string;
  /** Where staging happens. */
  dataDir:   string;
  /** Stream progress lines to the caller. */
  onMessage?: (msg: string) => void;
}

export interface PublishGitResult {
  manifest:  AppManifest;
  repoUrl:   string;
  tag:       string;
  commit:    string;
  installCmd: string;
}

export async function publishGit(opts: PublishGitOpts): Promise<PublishGitResult> {
  const log = (m: string) => opts.onMessage?.(m);
  const appPath = resolve(opts.appPath);

  // 1. Validate manifest.
  log('validating manifest...');
  const manifest = validateStagedDir(appPath);
  const tag = opts.tag ?? `v${manifest.version}`;
  const branch = opts.branch ?? 'main';

  // 2. Resolve target repo.
  const repoUrl = resolveTargetRepo(appPath, opts.repo, manifest);
  log(`target repo: ${repoUrl}`);

  // 3. Stage.
  const ts = Date.now();
  const stagingDir = join(opts.dataDir, 'nexus', 'publish-staging', `${manifest.id}-${ts}`);
  mkdirSync(stagingDir, { recursive: true });

  // 4. Init or clone target.
  log('preparing work tree...');
  const remoteExists = repoExistsRemotely(repoUrl);
  if (remoteExists) {
    execFileSync('git', ['clone', '--depth', '1', repoUrl, stagingDir],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } else {
    execFileSync('git', ['init', '-b', branch, stagingDir],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('git', ['-C', stagingDir, 'remote', 'add', 'origin', repoUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // 5. Clobber working tree with the local source (respecting ignore list).
  log('staging source...');
  syncWorkTree(appPath, stagingDir, manifest);

  // 6. Commit + tag + push.
  log('committing...');
  configureGitIdentity(stagingDir);
  execFileSync('git', ['-C', stagingDir, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // `--allow-empty` so re-publishing the same source still tags the
  // current HEAD — useful for forcing a channel re-tag without bumping
  // the manifest version.
  execFileSync('git', ['-C', stagingDir, 'commit', '--allow-empty',
                       '-m', `release: ${manifest.id} ${tag}`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', stagingDir, 'tag', '-f', tag],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  if (opts.channel) {
    execFileSync('git', ['-C', stagingDir, 'tag', '-f', opts.channel],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  log('pushing...');
  execFileSync('git', ['-C', stagingDir, 'push', '-u', 'origin', branch, '--tags'],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });

  const commit = execFileSync('git', ['-C', stagingDir, 'rev-parse', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  // 7. Build the install command we'll print to the user.
  const installCmd = `aura nexus install ${shortRepoRef(repoUrl)}#${tag}`;

  log('done.');
  return {
    manifest,
    repoUrl,
    tag,
    commit,
    installCmd,
  };
}

/** Decide which git URL the user is publishing to. */
function resolveTargetRepo(appPath: string, flag: string | undefined, manifest: AppManifest): string {
  if (flag) return normaliseRepo(flag);
  if (manifest.publish?.repo) return normaliseRepo(manifest.publish.repo);
  // Try to read `git remote get-url origin` for the LOCAL repo containing
  // this app. Works for monorepo apps + standalone repos alike.
  try {
    const url = execFileSync('git', ['-C', appPath, 'remote', 'get-url', 'origin'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }).toString().trim();
    if (url) return normaliseRepo(url);
  } catch { /* not a git repo */ }
  throw new Error(
    '[NexusPublish] no target repo configured. Pass --repo or set ' +
    'manifest.publish.repo, or run inside a git repo with a configured origin.',
  );
}

/** Accept `github.com/user/repo`, `https://…`, or `git@…` and normalise. */
function normaliseRepo(s: string): string {
  if (/^https?:\/\//.test(s) || s.startsWith('git@')) return s;
  return `https://${s}`;
}

/** Pretty short ref the user should run to install — drops https://. */
function shortRepoRef(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '');
}

function repoExistsRemotely(url: string): boolean {
  try {
    execFileSync('git', ['ls-remote', url],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Configure local-only git identity so `git commit` doesn't fail when the
 *  user hasn't set a global identity. Inherits global if present. */
function configureGitIdentity(repoDir: string): void {
  const setLocal = (key: string, val: string) => {
    try {
      execFileSync('git', ['-C', repoDir, 'config', '--local', key, val],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { /* best-effort */ }
  };
  // Only set local if global isn't configured.
  try {
    execFileSync('git', ['-C', repoDir, 'config', 'user.name'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    setLocal('user.name',  'AuraOS Nexus');
    setLocal('user.email', 'nexus@aura.local');
  }
}

/**
 * Sync `src` → `dst` excluding ignored paths. Preserves the `.git/`
 * directory in `dst` (cloned earlier).
 */
function syncWorkTree(src: string, dst: string, manifest: AppManifest): void {
  const ignore = [
    '.git', // keep dst's .git (cloned target) intact
    ...manifest.publish?.ignore ?? [
      'node_modules', '.next', 'dist', '.astro', '.turbo', '.cache',
    ],
  ];
  // Remove everything in dst EXCEPT .git
  try {
    const entries = readdirSafe(dst);
    for (const e of entries) {
      if (e === '.git') continue;
      rmSync(join(dst, e), { recursive: true, force: true });
    }
  } catch { /* dst empty */ }

  // Copy src → dst, skipping ignore list.
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const rel = s.slice(src.length).replace(/^\/+/, '');
      const top = rel.split('/')[0] ?? '';
      return !ignore.includes(top);
    },
  });

  // Write a marker so updates can detect Nexus publishes (not load-bearing
  // for v1, but cheap and useful for diagnostics).
  const marker = {
    publishedBy: 'aura-nexus',
    publishedAt: new Date().toISOString(),
    publishedVersion: manifest.version,
  };
  writeFileSync(join(dst, '.nexus-published.json'), JSON.stringify(marker, null, 2));
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Optional OCI publish — shells out to `oras push` when available. v1
 * stretch goal: returns a clear "needs oras" error when missing.
 */
export interface PublishOciOpts {
  appPath:   string;
  /** Either a full registry path (`ghcr.io/user/app`) or a bare name
   *  registered in RegistryConfig (`local`, `my-private-mirror`). When a
   *  bare name is used, `registryResolver` must translate it to a full
   *  URL, from which the path component becomes the OCI repo. */
  registry:  string;
  tag:       string;
  channel?:  string;
  dataDir:   string;
  onMessage?: (msg: string) => void;
  /** When `opts.registry` is a bare name (no `/`), call this to resolve
   *  the full URL. Returns null when unknown — the caller then falls back
   *  to treating `opts.registry` as a literal path. */
  registryResolver?: (bareName: string) => string | null;
  /** When `opts.registry` resolves to a bare name, the actual OCI repo path
   *  has to come from somewhere. Defaults to `aura-apps/<manifestId>` (the app
   *  store prefix — kept distinct from the `aura/<pkg>` SDK artifacts); callers
   *  can override. */
  repoPathForName?: string;
}

export async function publishOci(opts: PublishOciOpts): Promise<{ ref: string }> {
  const log = (m: string) => opts.onMessage?.(m);
  try {
    execFileSync('oras', ['version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
  } catch {
    throw new Error("[NexusPublish] OCI publish needs `oras` on PATH. Install via `aura cap install oras` or use git source for v1.");
  }
  log('validating manifest...');
  const manifest = validateStagedDir(opts.appPath);

  // Pack the source into a tar.gz that `oras push` ingests.
  log('packing tarball...');
  const ts = Date.now();
  const stagingDir = join(opts.dataDir, 'nexus', 'publish-staging', `${manifest.id}-${ts}`);
  mkdirSync(stagingDir, { recursive: true });
  // Keep the tar basename relative: `oras push` runs with cwd=stagingDir and
  // (as of 1.2.0) REJECTS absolute file args unless --disable-path-validation.
  // A relative name also keeps the OCI layer title clean (`bundle.tar.gz`,
  // not a leaked tmp path).
  const tarName = 'bundle.tar.gz';
  const tarPath = join(stagingDir, tarName);

  // Build an --exclude list from manifest.publish.ignore.
  const ignores = manifest.publish?.ignore ?? [
    'node_modules', '.next', 'dist', '.astro', '.turbo', '.cache',
  ];
  const tarArgs = ['-czf', tarPath, '-C', opts.appPath];
  for (const i of ignores) tarArgs.push(`--exclude=${i}`);
  tarArgs.push('.');
  execFileSync('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

  // Resolve a bare-name registry through the RegistryConfig before pushing.
  // Bare = no `/` AND no `:` — looks like a label, not a URL/path. When it
  // resolves to a URL, strip the scheme + use the URL's host as the registry
  // and the configured repo path (default `aura/<manifestId>`) as the OCI
  // repo. Plain-HTTP URLs get `--plain-http` added to every oras call.
  const isBareName = !opts.registry.includes('/') && !opts.registry.includes(':');
  let registryPath = opts.registry;
  let extraFlags: string[] = [];
  if (isBareName && opts.registryResolver) {
    const url = opts.registryResolver(opts.registry);
    if (!url) {
      throw new Error(`[NexusPublish] registry '${opts.registry}' isn't a URL and isn't a configured registry name.`);
    }
    const { orasHostFromUrl, orasFlagsForUrl } = await import('./RegistryConfig.js');
    const host = orasHostFromUrl(url);
    const repo = opts.repoPathForName ?? `${APP_REPO_PREFIX}/${manifest.id}`;
    registryPath = `${host}/${repo}`;
    extraFlags = orasFlagsForUrl(url);
  }

  // Embed storefront metadata as OCI manifest annotations so the catalog
  // aggregator can read it back with a single `oras manifest fetch` — no
  // bundle pull needed to list the app.
  const annotations = buildStoreAnnotations(manifest, { createdAt: new Date().toISOString() });
  const annotationFlags: string[] = [];
  for (const [k, v] of Object.entries(annotations)) {
    annotationFlags.push('--annotation', `${k}=${v}`);
  }

  // Push as a single layer with the app config blob inline.
  log('pushing oci artifact...');
  const ref = `${registryPath}:${opts.tag}`;
  execFileSync('oras', [
    'push', ref,
    `${tarName}:application/vnd.aura.app.bundle.v1.tar+gzip`,
    '--artifact-type', APP_ARTIFACT_TYPE,
    ...annotationFlags,
    ...extraFlags,
  ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, cwd: stagingDir });

  // Tag additional refs. `latest` is what the catalog aggregator anchors on
  // when listing a repo; the channel label (e.g. `stable`) lets installs pin
  // a track. Both best-effort — a failed extra tag doesn't fail the publish.
  const extraTags = new Set<string>(['latest']);
  if (opts.channel) extraTags.add(opts.channel);
  extraTags.delete(opts.tag);   // already pushed as the primary ref
  for (const t of extraTags) {
    log(`tagging '${t}'...`);
    try {
      execFileSync('oras', ['tag', ref, t, ...extraFlags],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    } catch { /* tag is best-effort */ }
  }

  // Verify the just-pushed ref exists.
  log('verifying...');
  execFileSync('oras', ['manifest', 'fetch', ref, ...extraFlags],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

  // Clean up the staging dir.
  try { rmSync(stagingDir, { recursive: true, force: true }); }
  catch { /* leave it */ }

  log('done.');
  return { ref };
}
