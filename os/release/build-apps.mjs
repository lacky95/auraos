#!/usr/bin/env node
// System app builds in a release's staging tree (Phase 6 stream B, step 6).
// Runs inside the builder's throwaway container after the packages are built,
// with the SAME rules the running kernel uses for an app's production build
// (packages/core app-manager/appBuild.ts, loaded from the staging tree's own
// fresh build): prodCapability decides whether an app runs from a build, and
// the stamp is appFingerprint of the sources it was made from. A release
// therefore ships every system app's build current, and the kernel never
// rebuilds into the read-only release tree.
//
//   build-apps.mjs ROOT     prints one JSON line per app, then a summary line
//                           {"apps":[{id, built, skipped?}]}; exit 1 if a build failed
//
// Apps with their own entrypoint (runtime raw, e.g. Docs' Next.js site) are
// not built here: they are listed `skipped: own-entrypoint` (Docs' release
// build hook is an open item of stream B).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/workspace';
const ab = await import(pathToFileURL(join(root, 'packages/core/dist/app-manager/appBuild.js')).href);
const appsDir = join(root, 'apps');
const out = [];
let failed = 0;
for (const id of readdirSync(appsDir).sort()) {
  const appDir = join(appsDir, id);
  const mf = join(appDir, 'app.manifest.json');
  if (!existsSync(mf)) continue;
  const raw = JSON.parse(readFileSync(mf, 'utf8'));
  const manifest = { ...raw, entrypoint: raw.entrypoint ?? 'entrypoint.sh' };
  const cap = ab.prodCapability(appDir, manifest);
  if (!cap.capable) {
    out.push({ id, built: false, skipped: `${cap.reason}${cap.detail ? `: ${cap.detail}` : ''}` });
    continue;
  }
  const fingerprint = ab.appFingerprint(appDir, manifest.build?.ignore ?? []);
  const local = join(appDir, 'node_modules/.bin/astro');
  const astro = existsSync(local) ? local : join(root, 'node_modules/.bin/astro');
  process.stdout.write(`[release] app ${id}: astro build\n`);
  const r = spawnSync(astro, ['build'], { cwd: appDir, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', APP_ID: id } });
  if (r.status !== 0) {
    failed++;
    out.push({ id, built: false, failed: true });
    continue;
  }
  ab.writeBuildStamp(appDir, fingerprint);
  out.push({ id, built: true, fingerprint });
}
process.stdout.write(`${JSON.stringify({ apps: out })}\n`);
process.exitCode = failed ? 1 : 0;
