// Run the CLI unit tests: bundle each test/*.test.ts with the SAME esbuild
// settings as the CLI (the `.yaml` text loader in particular — lib/registry.ts
// imports one, which plain tsx cannot load), then hand them to `node --test`.
//
//   pnpm --filter @aura/cli test
import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, '..', '.test-dist');
const entries = readdirSync(here).filter((f) => f.endsWith('.test.ts')).map((f) => join(here, f));

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outdir,
  outExtension: { '.js': '.cjs' },
  loader: { '.yaml': 'text' },
  logLevel: 'warning',
});

const files = readdirSync(outdir).filter((f) => f.endsWith('.cjs')).map((f) => join(outdir, f));
const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status ?? 1);
