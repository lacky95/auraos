// App host rules: names, parsing, desktop classification, reserved paths, and
// that the SDK and the shell router can't drift from the one definition.
//
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/host-rules.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as rules from '../dist/app-hosts/hostRules.js';
import * as coreHosts from '../dist/app-hosts/appHosts.js';

const {
  appHostCookieName, appHostNameForSlot, buildAppHost, classifyDesktopHost, desktopPart,
  isAuraReservedPath, isProtectedHostName, isRawIpHost, isValidHostName, parseAppHost,
  proposeAppHostName, suggestAppHostAddress, supportsAppHosts, webkitSendsSiblingCookies,
  AURA_RESERVED_PATHS, MAX_APP_HOST_SLOT, RESERVED_HOST_NAMES, SYSTEM_APP_HOST_NAMES,
} = rules;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ORIGIN = 'b61b5559-5176-4c11-9f8e-0123456789ab';
const INSTALL = '1a2b3c4d-5e6f-4a0b-8c1d-fedcba987654';
const name = (appId, extra = {}) => proposeAppHostName({ appId, originId: ORIGIN, installationId: INSTALL, isSystemApp: false, ...extra });

// ── generated names ─────────────────────────────────────────────────────────

test('generated name: last id part + first 8 of originId', () => {
  assert.equal(name('com.aura.nexus', { isSystemApp: true }), 'nexusb61b5559');
  assert.equal(name('io.acme.Note-Pad2'), 'notepad2b61b5559');
});

test('generated name: app part stops at 19 characters, name at 27', () => {
  const n = name('io.acme.abcdefghijklmnopqrstuvwxyz');
  assert.equal(n, 'abcdefghijklmnopqrsb61b5559');
  assert.equal(n.length, 27);
  assert.ok(isValidHostName(n));
});

test('generated name: no usable originId falls back to the installation id', () => {
  for (const originId of [undefined, null, '', 'not-hex-at-all', 'b61b']) {
    assert.equal(name('io.acme.notes', { originId }), 'notes1a2b3c4d');
  }
});

test('generated name: a retry never reuses originId and walks the installation id', () => {
  assert.equal(name('io.acme.notes', { attempt: 1 }), 'notes1a2b3c4d');
  assert.equal(name('io.acme.notes', { attempt: 2 }), 'notesa2b3c4d5');
  assert.equal(name('io.acme.notes', { originId: null, attempt: 1 }), 'notesa2b3c4d5');
  assert.equal(name('io.acme.notes', { attempt: 25 }).length, 13);
  assert.throws(() => name('io.acme.notes', { attempt: 26 }), RangeError);
  assert.throws(() => name('io.acme.notes', { attempt: -1 }), RangeError);
});

test('generated name: rejects a non-UUID installation id', () => {
  assert.throws(() => name('io.acme.notes', { installationId: 'nope' }), TypeError);
});

test('look-alikes of system apps and reserved names get the neutral prefix', () => {
  for (const id of ['com.evil.settings', 'com.evil.Set-Tings', 'com.evil.terminal', 'com.evil.shell', 'com.evil.aura', 'settings']) {
    assert.equal(name(id), 'appb61b5559', id);
  }
  assert.equal(name('com.aura.settings', { isSystemApp: true }), 'settingsb61b5559');
  assert.equal(name('com.acme.terminalx'), 'terminalxb61b5559');
});

test('an id part with no leading letter still produces a valid name', () => {
  assert.equal(name('io.acme.3d'), 'app3db61b5559');
  assert.equal(name('io.acme.---'), 'appb61b5559');
  assert.ok(isValidHostName(name('io.acme.123456789012345678901234')));
});

test('slot suffix: slot 1 is the name, N >= 2 adds xN, within 31 characters', () => {
  const n = name('io.acme.abcdefghijklmnopqrstuvwxyz');
  assert.equal(appHostNameForSlot(n, 1), n);
  assert.equal(appHostNameForSlot(n, 2), `${n}x2`);
  const longest = appHostNameForSlot(n, MAX_APP_HOST_SLOT);
  assert.equal(longest.length, 31);
  assert.ok(isValidHostName(longest));
  for (const bad of [0, -1, 1.5, MAX_APP_HOST_SLOT + 1]) assert.throws(() => appHostNameForSlot(n, bad), RangeError);
  assert.throws(() => appHostNameForSlot('a'.repeat(30), 2), RangeError);
});

// ── reserved names ──────────────────────────────────────────────────────────

test('reserved names are unchanged and system names are protected separately', () => {
  assert.deepEqual([...RESERVED_HOST_NAMES].sort(), ['admin', 'api', 'app', 'apps', 'aura', 'os', 'shell', 'www', 'xn']);
  for (const r of RESERVED_HOST_NAMES) { assert.equal(isValidHostName(r), false); assert.ok(isProtectedHostName(r)); }
  // Not enforced on manifests yet: this step must not change what installs.
  for (const s of SYSTEM_APP_HOST_NAMES) { assert.equal(isValidHostName(s), true); assert.ok(isProtectedHostName(s)); }
  assert.equal(isProtectedHostName('notes'), false);
});

test('every app shipped in apps/ has its name protected, and nothing else is listed', () => {
  const shipped = readdirSync(join(ROOT, 'apps')).filter((d) => d.startsWith('com.aura.')).map((d) => d.split('.').pop());
  assert.deepEqual([...SYSTEM_APP_HOST_NAMES].sort(), shipped.sort());
});

// ── parsing and building ────────────────────────────────────────────────────

test('parseAppHost splits name and base', () => {
  assert.deepEqual(parseAppHost('NexusB61B5559--10-201-1-2.nip.io:3000'), { name: 'nexusb61b5559', base: '10-201-1-2.nip.io:3000' });
  for (const bad of [null, undefined, '', 'desk.example', '--desk.example', 'a-b--desk.example', 'os--desk.example', 'x--', 'x--.desk', 'x--:3000', 'xn--bcher.example']) {
    assert.equal(parseAppHost(bad), null, String(bad));
  }
});

test('buildAppHost round-trips and respects the 63-character label', () => {
  assert.equal(buildAppHost('notes', '10-1-2-3.nip.io:3000'), 'notes--10-1-2-3.nip.io:3000');
  assert.equal(buildAppHost('notes', 'OS.aura.localhost:3000'), 'notes--os.aura.localhost:3000');
  assert.deepEqual(parseAppHost(buildAppHost('notes', 'box.aura.example.com')), { name: 'notes', base: 'box.aura.example.com' });

  const at63 = `${'a'.repeat(56)}.example.com`;  // 5 + 2 + 56 = 63
  assert.ok(buildAppHost('notes', at63));
  assert.equal(buildAppHost('notes', `${'a'.repeat(57)}.example.com`), null);
});

test('buildAppHost refuses reserved names and hosts with no App Host base', () => {
  assert.equal(buildAppHost('os', 'box.example.com'), null);
  for (const d of ['10.0.0.2:3000', '[::1]:3000', 'localhost:3000', 'aura.localhost:3000', 'aura-shell:3000', 'x--box.example.com']) {
    assert.equal(buildAppHost('notes', d), null, d);
  }
});

// ── classification ──────────────────────────────────────────────────────────

const kind = (h) => classifyDesktopHost(h).kind;

test('IPv4 literals', () => {
  assert.deepEqual(classifyDesktopHost('10.201.1.2:3000'), { kind: 'ip', hostname: '10.201.1.2', port: 3000, family: 4, loopback: false, isPrivate: true });
  assert.equal(classifyDesktopHost('127.0.0.1').loopback, true);
  assert.equal(classifyDesktopHost('127.8.9.1').loopback, true);
  for (const p of ['10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '100.127.0.1', '169.254.1.1']) {
    assert.equal(classifyDesktopHost(p).isPrivate, true, p);
  }
  for (const p of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.167.1.1']) {
    assert.equal(classifyDesktopHost(p).isPrivate, false, p);
  }
  for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '127.1', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:03000']) {
    assert.equal(kind(bad), 'invalid', bad);
  }
});

test('IPv6 literals', () => {
  for (const lo of ['[::1]', '[::1]:3000', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]:3000', '[::ffff:7f00:1]']) {
    const c = classifyDesktopHost(lo);
    assert.equal(c.kind, 'ip', lo);
    assert.equal(c.family, 6, lo);
    assert.equal(c.loopback, true, lo);
  }
  for (const other of ['[2001:db8::1]', '[fe80::1]:3000', '[::]', '[1:2:3:4:5:6:7:8]', '[::ffff:10.0.0.2]', '[64:ff9b::1.2.3.4]']) {
    const c = classifyDesktopHost(other);
    assert.equal(c.kind, 'ip', other);
    assert.equal(c.loopback, false, other);
  }
  for (const bad of ['::1', '[::1', '[]', '[1::2::3]', '[1:2:3:4:5:6:7:8:9]', '[1:2:3:4:5:6:7]', '[12345::]', '[fe80::1%25eth0]', '[::1.2.3]', '[1:2:3:4:5:6:7::8]']) {
    assert.equal(kind(bad), 'invalid', bad);
  }
});

test('loopback names and os.aura.localhost (D44)', () => {
  assert.equal(kind('os.aura.localhost:3000'), 'local-aura');
  for (const h of ['localhost', 'localhost:3000', 'aura.localhost', 'aura.localhost:3000', 'foo.localhost', 'a.os.aura.localhost']) {
    assert.equal(kind(h), 'loopback-name', h);
  }
  assert.equal(supportsAppHosts(classifyDesktopHost('aura.localhost:3000')), false);
  assert.equal(supportsAppHosts(classifyDesktopHost('os.aura.localhost:3000')), true);
});

test('nip.io', () => {
  assert.deepEqual(classifyDesktopHost('10-201-1-2.nip.io:3000'), { kind: 'nip', hostname: '10-201-1-2.nip.io', port: 3000, ipv4: '10.201.1.2', loopback: false });
  assert.equal(classifyDesktopHost('127-0-0-1.nip.io').loopback, true);
  assert.equal(kind('999-1-1-1.nip.io'), 'invalid');
  assert.equal(kind('10.0.0.2.nip.io'), 'custom');
});

test('custom domains and what is not one', () => {
  assert.deepEqual(classifyDesktopHost('Box.Aura.Example.COM:8443'), { kind: 'custom', hostname: 'box.aura.example.com', port: 8443, publicSuffix: true });
  assert.equal(classifyDesktopHost('box.test').publicSuffix, false);
  assert.equal(classifyDesktopHost('xn--bcher-kva.example.com').kind, 'custom');
  for (const bad of [null, undefined, '', ' ', 'aura-shell:3000', 'box', 'box.example.com.', '.example.com', 'a..b', '-a.example.com', 'a-.example.com',
    'x--box.example.com', 'http://box.example.com', 'box.example.com/x', 'u@box.example.com', 'box.example.com:abc', `${'a'.repeat(64)}.example.com`, `${'a.'.repeat(127)}com`]) {
    assert.equal(kind(bad), 'invalid', String(bad));
  }
});

test('WebKit sibling cookies (D44)', () => {
  const sends = (h) => webkitSendsSiblingCookies(classifyDesktopHost(h));
  assert.equal(sends('os.aura.localhost:3000'), false);
  assert.equal(sends('box.test'), false);
  assert.equal(sends('127-0-0-1.nip.io:3000'), true);
  assert.equal(sends('box.aura.example.com'), true);
});

test('suggested address', () => {
  const local = { kind: 'switch', address: 'os.aura.localhost:3000', webkitFallback: '127-0-0-1.nip.io:3000' };
  for (const h of ['127.0.0.1:3000', '[::1]:3000', 'localhost:3000', 'aura.localhost:3000']) assert.deepEqual(suggestAppHostAddress(h), local, h);
  assert.deepEqual(suggestAppHostAddress('10.201.1.2:3000'), { kind: 'switch', address: '10-201-1-2.nip.io:3000' });
  assert.deepEqual(suggestAppHostAddress('192.168.1.5'), { kind: 'switch', address: '192-168-1-5.nip.io' });
  assert.deepEqual(suggestAppHostAddress('os.aura.localhost:3000'), { kind: 'current', address: 'os.aura.localhost:3000', webkitFallback: '127-0-0-1.nip.io:3000' });
  assert.deepEqual(suggestAppHostAddress('10-1-2-3.nip.io:3000'), { kind: 'current', address: '10-1-2-3.nip.io:3000' });
  assert.deepEqual(suggestAppHostAddress('box.example.com'), { kind: 'current', address: 'box.example.com' });
  for (const h of ['8.8.8.8:3000', '[2001:db8::1]:3000', 'aura-shell:3000', '']) assert.deepEqual(suggestAppHostAddress(h), { kind: 'custom-domain' }, h);
});

// ── reserved paths and names ────────────────────────────────────────────────

test('reserved paths', () => {
  assert.deepEqual(AURA_RESERVED_PATHS, { handoff: '/_aura/handoff', runtime: '/_aura/runtime.js', os: '/_aura/os/', hostProbe: '/_aura/host-probe' });
  for (const p of Object.values(AURA_RESERVED_PATHS)) assert.ok(isAuraReservedPath(p), p);
});

test('reserved path check survives path tricks', () => {
  for (const p of ['/_aura', '/_aura/', '/_aura/os/x?y=1', '//_aura/os', '/x/../_aura/os', '/./_aura/os', '/%5Faura/os', '/_AURA/os', '/_aura%2Fos', '/%2e/_aura/os', '\\_aura\\os', '/x/%2e%2e/_aura', '/%zz']) {
    assert.equal(isAuraReservedPath(p), true, p);
  }
  for (const p of ['/', '/index.html', '/_aurora/x', '/x/_aura/os', '/aura/os', '/_auraos']) {
    assert.equal(isAuraReservedPath(p), false, p);
  }
});

test('app cookie is __Host- on HTTPS', () => {
  assert.equal(appHostCookieName(true), '__Host-aura_app');
  assert.equal(appHostCookieName(false), 'aura_app');
});

// ── no drift ────────────────────────────────────────────────────────────────

test('the SDK copy of the rules is byte-identical', () => {
  assert.equal(
    readFileSync(join(ROOT, 'packages/app-sdk/src/hostRules.ts'), 'utf-8'),
    readFileSync(join(ROOT, 'packages/core/src/app-hosts/hostRules.ts'), 'utf-8'),
  );
});

test('the rules module has no imports', () => {
  const src = readFileSync(join(ROOT, 'packages/core/src/app-hosts/hostRules.ts'), 'utf-8');
  assert.doesNotMatch(src, /^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m);
});

test('core re-exports the same functions, and no consumer redefines the rule', () => {
  for (const k of ['parseAppHost', 'isValidHostName', 'isRawIpHost', 'HOST_NAME_RE', 'RESERVED_HOST_NAMES']) {
    assert.equal(coreHosts[k], rules[k], k);
  }
  for (const f of ['packages/shell/server/app-hosts.mjs', 'packages/app-sdk/src/hosts.ts', 'packages/core/src/app-hosts/appHosts.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    assert.doesNotMatch(src, /\[a-z\]\[a-z0-9\]\{0,30\}/, `${f} redefines the host name pattern`);
    assert.doesNotMatch(src, /'shell',\s*'os',\s*'api'/, `${f} redefines the reserved names`);
  }
});

test('legacy desktop-part rule keeps its syntax-only behaviour', () => {
  assert.equal(desktopPart('x--desk.example:3000'), 'desk.example:3000');
  assert.equal(desktopPart('os--desk.example'), 'desk.example');   // reserved, still stripped
  assert.equal(desktopPart('a-b--desk.example'), 'a-b--desk.example');
  assert.equal(isRawIpHost('[::1]:3000'), true);
});
