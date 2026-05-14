import { build, context } from 'esbuild';
import { chmodSync } from 'node:fs';

const outfile = 'dist/aura.cjs';
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile,
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: 'inline',
  minify: false,
  external: [],
  loader: { '.yaml': 'text' },
  logLevel: 'info',
  plugins: [
    {
      name: 'chmod-after-build',
      setup(b) {
        b.onEnd((result) => {
          if (!result.errors.length) {
            chmodSync(outfile, 0o755);
            console.log(`[${new Date().toLocaleTimeString()}] Built ${outfile}`);
          }
        });
      },
    },
  ],
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching… edits to packages/aura-cli/src/ rebuild dist/aura.cjs in place.');
} else {
  await build(options);
}
