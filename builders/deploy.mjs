#!/usr/bin/env node
/**
 * Deploy a builder from `builders/<id>/` into a mutable AuraOS scope.
 *
 * Builders are not workspace members and are not auto-registered (see
 * builders/README.md), so installing one means handing its files to the
 * shell's scaffold endpoint — the same route `aura dev new` uses, and the only
 * one that works from inside a container sandbox with a sliced /workspace/apps
 * bind.
 *
 *   node builders/deploy.mjs io.lakner.pocketbuilder [--scope user] [--dry-run]
 *
 * Existing installs are overwritten (`force: true`). Files the previous
 * version left behind are NOT removed — scaffold only writes. Pass --prune to
 * list what would be stale.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const OS_API = process.env.OS_API_BASE ?? 'http://127.0.0.1:3000';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const scope = typeof flag('--scope') === 'string' ? flag('--scope') : 'user';
const dryRun = flag('--dry-run') === true;

if (!id) {
  console.error('usage: node builders/deploy.mjs <builderId> [--scope user|global] [--dry-run]');
  process.exit(2);
}

/** Never ship build output or installed deps — the sandbox rebuilds those. */
const SKIP = new Set(['node_modules', 'dist', '.astro', '.git']);

const files = [];
const walk = (dir, rel) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const abs = join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    if (statSync(abs).isDirectory()) { walk(abs, relPath); continue; }
    files.push({
      relPath,
      content: readFileSync(abs, 'utf-8'),
      ...(entry.endsWith('.sh') ? { mode: 0o755 } : {}),
    });
  }
};
walk(join(ROOT, id), '');

const bytes = files.reduce((n, f) => n + f.content.length, 0);
console.log(`${id} → scope '${scope}': ${files.length} files, ${(bytes / 1024).toFixed(1)} KB`);
for (const f of files) console.log(`  ${f.relPath}`);

if (dryRun) { console.log('\n--dry-run: nothing sent.'); process.exit(0); }

const res = await fetch(`${OS_API}/api/admin/scaffold`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId: id, scope, files, force: true }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`\nscaffold failed — HTTP ${res.status}:`, JSON.stringify(body, null, 2));
  process.exit(1);
}
console.log(`\ndeployed to ${body.dest}`);
console.log('The app registry picks up the manifest automatically; restart a running');
console.log(`instance to apply manifest changes:  aura app restart ${id}`);
