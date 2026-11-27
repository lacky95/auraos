#!/usr/bin/env node
// The rendered infrastructure directory (D94 §4.1, §5.5): the adapters'
// non-secret output for the stored config, in /data/aura/infra/generated/<digest>/
// with an atomic `current` symlink. Re-applying the same config is a no-op
// (same digest, nothing written); no config removes `current`. The previous
// digest dir is kept for rollback, older ones are pruned. Dependency-free:
// os/boot.sh runs it before `pnpm install` (and before the kernel exists).
//
//   node os/infra/render.mjs apply [--data /data] [--system-bundle FILE]
//
// Files in a rendered dir:
//   <adapter files>   npmrc, gitconfig, ca-bundle.pem, apt/…, xdg/…
//   env               KEY=value lines (non-secret)
//   env.sh            the same as `export` lines
//   manifest.json     { v, digest, env, systemPaths, files }
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './config.mjs';
import { INFRA_ROOT, envFile, envSh, isEmptyRender, renderInfra } from './adapters/index.mjs';
import { readSystemBundle } from './adapters/trust.mjs';
import { infraDir, readStore } from './store.mjs';

export const RENDER_VERSION = 1;

/** The full rendered tree `{ relPath: content }` for a render result. */
export function renderTree(r) {
  const digest = `sha256:${createHash('sha256').update(canonicalJson({ v: RENDER_VERSION, ...r })).digest('hex')}`;
  const manifest = { v: RENDER_VERSION, digest, env: r.env, systemPaths: r.systemPaths, files: Object.keys(r.files) };
  return { digest, tree: { ...r.files, env: envFile(r.env), 'env.sh': envSh(r.env), 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n` } };
}

/** Writes `{ relPath: content }` under `dir` (dirs 0755, files 0644: public material only). */
export function writeTree(dir, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const f = join(dir, rel);
    mkdirSync(dirname(f), { recursive: true, mode: 0o755 });
    writeFileSync(f, content, { mode: 0o644 });
  }
}

const currentOf = (gen) => { try { return readlinkSync(join(gen, 'current')); } catch { return null; } };

/**
 * Renders the stored config of an infra dir into `generated/`. Returns
 * `{ digest|null, dir|null, changed }`.
 */
export function applyGenerated(dir, { systemBundle, noProxyExtra } = {}) {
  const gen = join(dir, 'generated');
  const store = readStore(dir);
  const r = store ? renderInfra(store.config, { root: INFRA_ROOT, files: store.files, systemBundle: systemBundle ?? readSystemBundle(), noProxyExtra }) : null;
  if (!r || isEmptyRender(r)) {
    const had = currentOf(gen) !== null;
    rmSync(join(gen, 'current'), { force: true });
    return { digest: null, dir: null, changed: had };
  }
  const { digest, tree } = renderTree(r);
  const name = digest.slice('sha256:'.length);
  const target = join(gen, name);
  const prev = currentOf(gen);
  if (prev === name && existsSync(target)) return { digest, dir: target, changed: false };
  mkdirSync(gen, { recursive: true, mode: 0o755 });
  if (!existsSync(target)) {
    const tmp = join(gen, `.tmp-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    writeTree(tmp, tree);
    renameSync(tmp, target);
  }
  const link = join(gen, `.current-${process.pid}`);
  rmSync(link, { force: true });
  symlinkSync(name, link);
  renameSync(link, join(gen, 'current'));
  for (const e of readdirSync(gen)) if (e !== 'current' && e !== name && e !== prev) rmSync(join(gen, e), { recursive: true, force: true });
  return { digest, dir: target, changed: true };
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[++i];
  if (cmd !== 'apply') { process.stderr.write('usage: render.mjs apply [--data DIR] [--system-bundle FILE]\n'); return 64; }
  try {
    const sys = a['system-bundle'] ? readFileSync(a['system-bundle'], 'utf8') : undefined;
    const r = applyGenerated(infraDir(a.data), { systemBundle: sys });
    process.stdout.write(r.digest ? `infra: ${r.digest} (${r.changed ? 'rendered' : 'unchanged'})\n` : 'infra: no configuration\n');
    return 0;
  } catch (e) {
    // Messages name fields and files, never values (the config holds no secret).
    process.stderr.write(`infra: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
