// App hosts: the host-name rule, the manifest's `hosts[]`, the registry's
// `http/host` entries and the install-time conflict check.
//
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/app-hosts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appHostUrl, hostConflicts, isRawIpHost, isValidHostName, parseAppHost,
} from '../dist/app-hosts/appHosts.js';
import { InterfaceRegistry } from '../dist/interfaces/InterfaceRegistry.js';
import { AppManifestSchema } from '../dist/types/manifest.js';

function manifest(over = {}) {
  return AppManifestSchema.parse({
    id: 'io.acme.notes',
    name: 'Notes',
    version: '1.0.0',
    entrypoint: 'index.js',
    ...over,
  });
}

const WORKER = { name: 'worker', image: 'acme/worker:1', port: 8787 };

// ── names ───────────────────────────────────────────────────────────────────

test('host names: letters and digits, not reserved', () => {
  for (const ok of ['marklayer', 'a', 'app2', 'x'.repeat(31)]) assert.ok(isValidHostName(ok), ok);
  for (const bad of ['', 'Mark', 'mark-layer', '2app', 'x'.repeat(32), 'aura', 'api', 'xn', 'www']) {
    assert.ok(!isValidHostName(bad), bad);
  }
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('parseAppHost splits the first label at --', () => {
  assert.deepEqual(parseAppHost('marklayer--lukas-01.aura.int.lakner.io'), { name: 'marklayer', base: 'lukas-01.aura.int.lakner.io' });
  assert.deepEqual(parseAppHost('MarkLayer--10-201-1-2.nip.io:3000'), { name: 'marklayer', base: '10-201-1-2.nip.io:3000' });
});

test('parseAppHost leaves desktop hosts alone', () => {
  for (const h of [
    'lukas-01.aura.int.lakner.io', '10-201-1-2.nip.io:3000', '10.0.0.2:3000', 'aura-shell:3000',
    'xn--bcher-kva.example',        // punycode: `xn` is reserved
    'my-box--x.lan',                // a hyphen before -- is never a host name
    'api--lukas-01.example',        // reserved
    'notes--', 'notes--.example', 'notes--:3000', '--x.example', '', null, undefined,
  ]) assert.equal(parseAppHost(h), null, String(h));
});

// ── URLs ────────────────────────────────────────────────────────────────────

test('appHostUrl prepends name-- to the desktop host, keeping scheme and port', () => {
  assert.equal(appHostUrl('marklayer', { scheme: 'https', host: 'lukas-01.aura.int.lakner.io' }),
    'https://marklayer--lukas-01.aura.int.lakner.io');
  assert.equal(appHostUrl('marklayer', { scheme: 'http:', host: '10-201-1-2.nip.io:3000' }),
    'http://marklayer--10-201-1-2.nip.io:3000');
});

test('appHostUrl from a request that is already on an app host', () => {
  assert.equal(appHostUrl('notes', { scheme: 'http', host: 'marklayer--10-201-1-2.nip.io:3000' }),
    'http://notes--10-201-1-2.nip.io:3000');
});

test('appHostUrl is null where no label can be prepended', () => {
  for (const host of ['10.201.1.2:3000', '10.201.1.2', 'localhost:3000', 'aura-shell:3000', '[::1]:3000']) {
    assert.ok(isRawIpHost(host), host);
    assert.equal(appHostUrl('marklayer', { scheme: 'http', host }), null, host);
  }
  assert.equal(appHostUrl('bad-name', { scheme: 'http', host: 'x.example' }), null);
});

// ── manifest ────────────────────────────────────────────────────────────────

test('manifest: hosts default to [] and parse with a service target', () => {
  assert.deepEqual(manifest().hosts, []);
  const m = manifest({ services: [WORKER], hosts: [{ name: 'notes', service: 'worker' }, { name: 'notesapp' }] });
  assert.equal(m.hosts.length, 2);
});

test('manifest: invalid hosts are refused', () => {
  const bad = [
    { hosts: [{ name: 'my-notes' }] },                                          // hyphen
    { hosts: [{ name: 'aura' }] },                                              // reserved
    { hosts: [{ name: 'notes' }, { name: 'notes' }] },                          // duplicate
    { hosts: [{ name: 'notes', service: 'nope' }] },                            // unknown template
    { services: [{ name: 'db', image: 'pg' }], hosts: [{ name: 'db', service: 'db' }] }, // no port anywhere
    { provides: [{ name: 'notes', kind: 'mcp', address: '/mcp' }], hosts: [{ name: 'notes' }] }, // clashes with provides
    { provides: [{ name: 'x', kind: 'http/host', address: 'x' }] },             // http/host only via hosts[]
  ];
  for (const over of bad) assert.throws(() => manifest(over), JSON.stringify(over));
  // A port on the host itself makes a port-less template fine.
  manifest({ services: [{ name: 'db', image: 'pg' }], hosts: [{ name: 'db', service: 'db', port: 5432 }] });
});

// ── registry ────────────────────────────────────────────────────────────────

test('registry lists each host as an app-scoped http/host entry', () => {
  const reg = new InterfaceRegistry();
  reg.reload([manifest({ services: [WORKER], hosts: [{ name: 'notes', service: 'worker', description: 'the editor' }] })]);
  const [v] = reg.list({ kind: 'http/host' });
  assert.equal(v.id, 'io.acme.notes/notes');
  assert.equal(v.address, 'notes');
  assert.equal(v.scope, 'app');
  assert.equal(v.status, 'catalog');
  assert.equal(v.description, 'the editor');
  assert.equal(v.url, '/api/apps/io.acme.notes/hosts/notes');
  assert.equal(reg.resolve('notes')?.kind, 'http/host');
});

test('registry: a host is live while its app runs', () => {
  const reg = new InterfaceRegistry();
  const m = manifest({ hosts: [{ name: 'notes' }] });
  reg.reload([m]);
  reg.registerInstance({
    instanceId: 'io.acme.notes', appId: 'io.acme.notes', state: 'resumed', pid: 1, port: 4100,
    startedAt: new Date(), lastTransitionAt: new Date(), restartCount: 0,
  }, m);
  assert.equal(reg.list({ kind: 'http/host' })[0].status, 'live');
});

// ── conflicts ───────────────────────────────────────────────────────────────

test('hostConflicts: another app holding a name conflicts; the same app never does', () => {
  const installed = [
    { appId: 'io.lakner.marklayer', hosts: [{ name: 'marklayer' }] },
    { appId: 'io.acme.notes', hosts: [{ name: 'notes' }] },
  ];
  assert.deepEqual(
    hostConflicts({ appId: 'io.other.copy', hosts: [{ name: 'marklayer' }, { name: 'fresh' }] }, installed),
    [{ name: 'marklayer', heldBy: 'io.lakner.marklayer' }],
  );
  assert.deepEqual(hostConflicts({ appId: 'io.acme.notes', hosts: [{ name: 'notes' }] }, installed), []);
});
