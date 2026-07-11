// Regression tests for container-runner volume auto-discovery. Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/container-volume.test.mjs
//
// Background: sibling app containers must mount the SAME named volumes the
// shell uses for /data and /workspace/node_modules. The volume name is
// `<project>_<volume>`, which depends on the directory / COMPOSE_PROJECT_NAME.
// Hardcoding the prefix broke every spawned app when the dir was named
// `auraos` but the project was `aura` (apps mounted an empty auto-created
// volume). ContainerRunner now discovers the real name from the shell's own
// `docker inspect .Mounts`. pickVolumeByDestination is the pure selection at
// the heart of that — it must pick the named volume at a destination and
// ignore bind mounts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickVolumeByDestination } from '../dist/app-manager/ContainerRunner.js';

const MOUNTS = [
  { Type: 'volume', Name: 'aura_aura-app-data',     Destination: '/data' },
  { Type: 'volume', Name: 'aura_aura-node-modules', Destination: '/workspace/node_modules' },
  { Type: 'bind',   Source: '/workspace',           Destination: '/workspace' },
  { Type: 'bind',   Source: '/run/docker.sock',     Destination: '/var/run/docker.sock' },
];

test('picks the named volume attached at a destination', () => {
  assert.equal(pickVolumeByDestination(MOUNTS, '/data'), 'aura_aura-app-data');
  assert.equal(pickVolumeByDestination(MOUNTS, '/workspace/node_modules'), 'aura_aura-node-modules');
});

test('resolves the real name regardless of project prefix (auraos_ vs aura_)', () => {
  const auraosMounts = [
    { Type: 'volume', Name: 'auraos_aura-app-data', Destination: '/data' },
  ];
  assert.equal(pickVolumeByDestination(auraosMounts, '/data'), 'auraos_aura-app-data');
});

test('returns undefined for a bind mount (no volume name)', () => {
  // A bind-mounted /data (some mac dev setups) has no volume name — the caller
  // must fall back to env / legacy default rather than mount a bogus name.
  const bound = [{ Type: 'bind', Source: '/host/data', Destination: '/data' }];
  assert.equal(pickVolumeByDestination(bound, '/data'), undefined);
});

test('returns undefined when the destination is not mounted', () => {
  assert.equal(pickVolumeByDestination(MOUNTS, '/nope'), undefined);
});

test('returns undefined for an empty mounts array', () => {
  assert.equal(pickVolumeByDestination([], '/data'), undefined);
});

test('ignores a volume entry that is missing a Name', () => {
  const noName = [{ Type: 'volume', Destination: '/data' }];
  assert.equal(pickVolumeByDestination(noName, '/data'), undefined);
});
