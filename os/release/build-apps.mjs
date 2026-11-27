#!/usr/bin/env node
// System app builds in a release's staging tree (Phase 6 stream B, step 6).
// Runs inside the builder's throwaway container (no network) after the
// packages are built, with the SAME rules the running kernel uses, loaded from
// the staging tree's own fresh core build:
//   - the manifest is parsed with core's AppManifestSchema (an invalid system
//     app manifest fails the release);
//   - `build.release` (the app's own declaration) wins: its `command` (argv, no
//     shell) runs in its `cwd`, and every path in `outputs` must exist after;
//     `{}` = the app runs from its sources as is;
//   - else an Astro app prodCapability calls capable gets `astro build`, stamped
//     with appFingerprint, exactly like AppManager.buildApp;
//   - anything else is skipped (listed with the reason).
// No app-specific code here: an app's build is its manifest's business.
//
//   build-apps.mjs ROOT   one JSON summary line {"apps":[{id, built, via?, skipped?}]}; exit 1 if a build failed
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/workspace';
const dist = (rel) => import(pathToFileURL(join(root, 'packages/core/dist', rel)).href);
const ab = await dist('app-manager/appBuild.js');
const { AppManifestSchema } = await dist('types/manifest.js');
const appsDir = join(root, 'apps');
const out = [];
let failed = 0;
const fail = (entry) => { failed++; out.push({ built: false, failed: true, ...entry }); };

for (const id of readdirSync(appsDir).sort()) {
  const appDir = join(appsDir, id);
  const mf = join(appDir, 'app.manifest.json');
  if (!existsSync(mf)) continue;
  const parsed = AppManifestSchema.safeParse(JSON.parse(readFileSync(mf, 'utf8')));
  if (!parsed.success) {
    fail({ id, error: `invalid manifest: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
    continue;
  }
  const manifest = parsed.data;
  const env = { ...process.env, NODE_ENV: 'production', APP_ID: id };
  const rel = manifest.build?.release;
  if (rel) {
    if (rel.command) {
      process.stdout.write(`[release] app ${id}: ${rel.command.join(' ')}\n`);
      const r = spawnSync(rel.command[0], rel.command.slice(1), { cwd: join(appDir, rel.cwd ?? '.'), stdio: 'inherit', env });
      if (r.status !== 0) { fail({ id, via: 'build.release', error: `exit ${r.status ?? r.error?.message}` }); continue; }
    }
    const missing = (rel.outputs ?? []).filter((p) => !existsSync(join(appDir, p)));
    if (missing.length) { fail({ id, via: 'build.release', error: `missing outputs: ${missing.join(', ')}` }); continue; }
    out.push({ id, built: true, via: 'build.release', ...(rel.command ? { outputs: rel.outputs ?? [] } : { asIs: true }) });
    continue;
  }
  const cap = ab.prodCapability(appDir, manifest);
  if (!cap.capable) {
    out.push({ id, built: false, skipped: `${cap.reason}${cap.detail ? `: ${cap.detail}` : ''}` });
    continue;
  }
  const fingerprint = ab.appFingerprint(appDir, manifest.build?.ignore ?? []);
  const local = join(appDir, 'node_modules/.bin/astro');
  const astro = existsSync(local) ? local : join(root, 'node_modules/.bin/astro');
  process.stdout.write(`[release] app ${id}: astro build\n`);
  const r = spawnSync(astro, ['build'], { cwd: appDir, stdio: 'inherit', env });
  if (r.status !== 0) { fail({ id, via: 'astro', error: `exit ${r.status ?? r.error?.message}` }); continue; }
  ab.writeBuildStamp(appDir, fingerprint);
  out.push({ id, built: true, via: 'astro', fingerprint });
}
process.stdout.write(`${JSON.stringify({ apps: out })}\n`);
process.exitCode = failed ? 1 : 0;
