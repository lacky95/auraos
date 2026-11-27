// `aura dev validate`'s app contract checks (D48, lib/apphost-lint.ts
// `lintContract`) and the contract report printer.
//
//   pnpm --filter @aura/cli test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppManifestSchema, AURA_CONTRACT } from '@aura/core';
import { lintContract, lintReleaseBuild } from '../src/lib/apphost-lint.js';
import { printContractReport } from '../src/commands/admin.js';

const root = mkdtempSync(join(tmpdir(), 'aura-contract-lint-'));
after(() => rmSync(root, { recursive: true, force: true }));

function app(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'src'), { recursive: true });
  const text = JSON.stringify({ id: `com.example.${name}`, name, version: '1.0.0', ...manifest }, null, 2);
  writeFileSync(join(dir, 'app.manifest.json'), text);
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  const file = join(dir, 'app.manifest.json');
  return { file, text, parsed: AppManifestSchema.parse(JSON.parse(text)) };
}

test('a manifest on the contract with matching source is quiet', () => {
  const a = app('clean', { auraContract: AURA_CONTRACT, context: ['API_KEY'], permissions: ['user.confirm'] }, {
    'src/server.ts': "const k = await osClient.context.get('API_KEY');\nawait osClient.user.confirm({ action: 'x' });\n",
  });
  assert.deepEqual(lintContract(a.file, a.text, a.parsed), []);
});

test('an auraContract newer than this AuraOS is an error (D48: refused), at its line', () => {
  const a = app('future', { auraContract: AURA_CONTRACT + 1 });
  const f = lintContract(a.file, a.text, a.parsed, { source: false });
  assert.equal(f.length, 1);
  assert.equal(f[0]!.severity, 'error', 'aura dev validate exits 1');
  assert.equal(f[0]!.line, 5);
  assert.equal(f[0]!.message, `com.example.future is built for Aura contract ${AURA_CONTRACT + 1}; this AuraOS implements ${AURA_CONTRACT}. Update AuraOS or install a version built for contract ${AURA_CONTRACT}.`);
});

test('missing contract version, undeclared Context key and permission, raw Context: file:line warnings', () => {
  const a = app('dirty', { services: [{ name: 'db', image: 'postgres:16', privileged: true }] }, {
    'src/server.ts': "const k = await osClient.context.get('API_KEY');\nconst raw = readFileSync('/run/context/API_KEY');\n",
  });
  const f = lintContract(a.file, a.text, a.parsed);
  assert.ok(f.every((x) => x.rule === 'contract' && x.severity === 'warn'));
  const at = f.map((x) => [x.file.replace(root, ''), x.line, x.message.split(':')[0]]);
  assert.deepEqual(at.map((x) => x[0]), ['/dirty/app.manifest.json', '/dirty/app.manifest.json', '/dirty/app.manifest.json', '/dirty/src/server.ts', '/dirty/src/server.ts']);
  assert.match(f[0]!.message, /auraContract/);
  assert.equal(f[0]!.line, 1, 'auraContract is absent: the top of the manifest');
  assert.match(f[1]!.message, /sidecars\.privileged/);
  assert.ok(f[1]!.line > 1, 'points at services');
  assert.match(f[3]!.message, /context\[\]/);
  assert.equal(f[3]!.line, 1);
  assert.match(f[4]!.message, /raw mounted Context/);
  assert.equal(lintContract(a.file, a.text, a.parsed, { source: false }).length, 3, '--no-source: the manifest checks only');
});

test('printContractReport prints a table and the details', () => {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  try {
    printContractReport({
      contract: 1, summary: { apps: 1, noContract: 1 },
      apps: [{
        appId: 'com.example.x', scope: 'user', contract: { version: null, status: 'none' },
        findings: [{ code: 'contract-missing', message: 'no auraContract' }],
        source: [{ file: 'src/a.ts', line: 3, code: 'context-raw', message: 'reads /run/context' }],
        signals: { 'context-undeclared': 2 }, readsRawContext: true,
      }],
    });
  } finally { console.log = log; }
  const text = out.join('\n');
  assert.match(text, /com\.example\.x/);
  assert.match(text, /context-undeclared=2/);
  assert.match(text, /src\/a\.ts:3: reads \/run\/context/);
  assert.match(text, /contract 1: apps=1 noContract=1/);
});

test('build.release: paths stay in the app dir, cwd and command exist, raw apps without it get a note', () => {
  const bad = AppManifestSchema.safeParse({ id: 'com.example.esc', name: 'x', version: '1.0.0', build: { release: { cwd: '../x', outputs: ['/etc'] } } });
  assert.equal(bad.success, false);
  assert.match(JSON.stringify(bad.error!.issues), /inside the app dir/);
  const raw = app('rawnobuild', { runtime: 'raw' }, { 'entrypoint.sh': '#!/bin/sh\n' });
  const n = lintReleaseBuild(raw.file, raw.text, raw.parsed);
  assert.deepEqual(n.map((f) => [f.severity, f.rule]), [['info', 'release-build']]);
  assert.match(n[0]!.message, /own-entrypoint/);
  const asIs = app('rawasis', { runtime: 'raw', build: { release: {} } }, { 'entrypoint.sh': '#!/bin/sh\n' });
  assert.deepEqual(lintReleaseBuild(asIs.file, asIs.text, asIs.parsed), []);
  const missing = app('rawmissing', { runtime: 'raw', build: { release: { command: ['./build.mjs'], cwd: 'site' } } }, { 'entrypoint.sh': '#!/bin/sh\n' });
  const m = lintReleaseBuild(missing.file, missing.text, missing.parsed);
  assert.deepEqual(m.map((f) => f.severity), ['error', 'error', 'warn']);
  assert.match(m[0]!.message, /cwd site does not exist/);
  assert.match(m[2]!.message, /no outputs/);
});
