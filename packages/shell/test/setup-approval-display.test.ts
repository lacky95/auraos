// D108 P3: the dialog of an `app.setup.apply` request is built in the kernel (core
// setup/approval.ts); the wizard's preview is @aura/ui (P7 approvalSummary.ts). Same
// items, same wording, same high-risk order; core's class equals the preview's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@aura/core';
import type { SetupApplyPayload } from '@aura/core';

const ui = await import('../../ui/src/setup/index.ts');

const payload = (adds: Partial<SetupApplyPayload['adds']>): SetupApplyPayload => ({
  appId: 'com.example.app', installationId: 'i-1', profile: 'p', configDigest: `sha256:${'a'.repeat(64)}`, grantDigest: `sha256:${'b'.repeat(64)}`,
  adds: { permissions: [], tools: [], context: [], homePrivate: false, homePrivateSidecars: [], ...adds },
});

const CASES = [
  payload({ permissions: ['apps.mount', 'notifications.popup', 'plain.read', 'sidecars.privileged'], tools: ['git', 'docker', '*'], context: ['API_KEY'] }),
  payload({ homePrivate: true, homePrivateSidecars: ['terminal'], networks: { webui: 'instance' }, resources: { memory: '2g', cpus: 2 } }),
  payload({ runAsRoot: true, instanceScope: 'per-user', tools: ['#'] }),
  payload({ permissions: ['x.y'] }),
];

test('core and the wizard name every added privilege the same way, high-risk first', () => {
  for (const p of CASES) {
    assert.deepEqual(core.setupApprovalItems(p), ui.setupApprovalItems(p), JSON.stringify(p.adds));
    assert.equal(core.setupApplyClass(p) === 'forced', ui.setupApprovalNeedsPassword(p));
  }
});

test('the dialog display: title, high-risk items with their reasons, the bound digests; no requester words', () => {
  const p = CASES[1]!;
  const d = core.setupApplyDisplay(p, 'Open WebUI', 'Terminal (com.aura.terminal-1)');
  assert.equal(d.title, 'Approve the setup of Open WebUI (profile p)');
  assert.deepEqual(d.highRisk?.map((r) => r.item), ui.setupApprovalItems(p).filter((i) => i.highRisk).map((i) => i.item));
  assert.ok(d.details.at(-1)!.includes('aaaaaaaaaaaa') && d.details.at(-1)!.includes('bbbbbbbbbbbb'));
  assert.equal(d.reason, undefined);
  assert.equal(d.requestedBy, 'Terminal (com.aura.terminal-1)');
});
