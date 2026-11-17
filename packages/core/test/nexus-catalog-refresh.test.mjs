// Store catalog freshness. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/nexus-catalog-refresh.test.mjs
//
// The catalog is cached per source and served stale while it revalidates.
// An install must not fail on an app the cache does not list yet, and a
// registry read that fails for one app must not drop that app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Resolver } from '../dist/nexus/Resolver.js';
import { CatalogAggregator } from '../dist/nexus/CatalogAggregator.js';

test('resolve: an id the cached catalog lacks gets one forced refresh before "not found"', async () => {
  const entry = { id: 'io.x.app', name: 'X', sources: { oci: { ref: 'reg.example/aura-apps/io.x.app' } } };
  let refreshed = 0;
  const catalog = {
    lookup: async () => (refreshed ? entry : null),
    lookupIn: async () => null,
    refresh: async () => { refreshed++; },
  };
  // The OCI digest lookup after it needs a registry: a stand-in `oras` that
  // fails at once (no digest) keeps this offline.
  const bin = mkdtempSync(join(tmpdir(), 'aura-oras-'));
  writeFileSync(join(bin, 'oras'), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, 'oras'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  let res;
  try { res = await new Resolver({ catalog }).resolve('io.x.app'); }
  finally { process.env.PATH = oldPath; }
  assert.equal(refreshed, 1);
  assert.deepEqual([res.source, res.address], ['index', 'oci://reg.example/aura-apps/io.x.app:latest']);

  const empty = { lookup: async () => null, lookupIn: async () => null, refresh: async () => { refreshed++; } };
  await assert.rejects(() => new Resolver({ catalog: empty }).resolve('io.y.app'), /'io\.y\.app' not found in any registered source/);
  assert.equal(refreshed, 2, 'still missing after one refresh: not found, no loop');
});

test('OCI source: an app whose manifest cannot be read right now keeps its last listing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-cat-'));
  const fake = join(root, 'fake'); const bin = join(root, 'bin');
  mkdirSync(fake); mkdirSync(bin);
  // A stand-in `oras`: no catalog artifact, `repo ls` lists two apps, and each
  // app's :latest manifest comes from <name>.json unless <name>.fail exists.
  writeFileSync(join(bin, 'oras'), `#!/bin/sh
if [ "$1 $2" = "repo ls" ]; then printf 'aura-apps/io.a.one\\naura-apps/io.a.two\\n'; exit 0; fi
if [ "$1 $2" = "manifest fetch" ]; then
  ref="$3"; tag="\${ref##*:}"; name="\${ref%:*}"; name="\${name##*/}"
  [ "$tag" = latest ] || exit 1
  [ -f "${fake}/$name.fail" ] && { echo "timeout" >&2; exit 1; }
  cat "${fake}/$name.json" 2>/dev/null || exit 1; exit 0
fi
exit 1
`);
  chmodSync(join(bin, 'oras'), 0o755);
  const manifest = (id) => JSON.stringify({ artifactType: 'application/vnd.aura.app.manifest.v1+json',
    annotations: { 'app.aura.id': id, 'org.opencontainers.image.title': id, 'org.opencontainers.image.version': '1.0.0' } });
  writeFileSync(join(fake, 'io.a.one.json'), manifest('io.a.one'));
  writeFileSync(join(fake, 'io.a.two.json'), manifest('io.a.two'));

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const agg = new CatalogAggregator({
      rootDataDir: root,
      getSources: () => ({ schema: 1, sources: [{ name: 'reg', kind: 'oci', url: 'https://reg.example', priority: 0 }] }),
    });
    const ids = (c) => c.apps.filter((a) => a.sourceName === 'reg').map((a) => a.id).sort();
    assert.deepEqual(ids(await agg.refresh()), ['io.a.one', 'io.a.two']);

    // io.a.two's registry read fails: it stays listed from the last read.
    writeFileSync(join(fake, 'io.a.two.fail'), '');
    assert.deepEqual(ids(await agg.refresh()), ['io.a.one', 'io.a.two']);

    // A repo that is no longer listed is gone, failing read or not.
    rmSync(join(fake, 'io.a.two.json'));
    writeFileSync(join(bin, 'oras'), `#!/bin/sh
if [ "$1 $2" = "repo ls" ]; then printf 'aura-apps/io.a.one\\n'; exit 0; fi
if [ "$1 $2" = "manifest fetch" ]; then cat "${fake}/io.a.one.json"; exit 0; fi
exit 1
`);
    assert.deepEqual(ids(await agg.refresh()), ['io.a.one']);
  } finally {
    process.env.PATH = oldPath;
  }
});
