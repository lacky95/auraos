// D108 P8: the change-management components (@aura/ui/setup changePlan.ts)
// and Settings → Apps → Configuration (apps/…settings components/appConfigView.ts)
// in happy-dom: the privilege diff, the approval it asks for, the data that
// stays behind (never copied), the restore with its "data not rolled back"
// notice, the Private Home revoke; the Settings view calls only the setup API
// and never puts a secret value in the DOM.
//
//   node tools/run-tests.mjs --only=shell
import { dom, resetDom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA_STAYS_NOTE, RESTORE_NOTICE } from '@aura/core';
import type { SetupChangePlan } from '@aura/core';

const ui = await import('../../ui/src/setup/index.ts');
const { renderAppConfig } = await import('../../../apps/com.aura.settings/src/components/appConfigView.ts');
// Every import before the first test: the DOM closes when the file's top level is done.

const doc = dom.document as unknown as Document;
const root = (): HTMLElement => { resetDom('<div id="r"></div>'); return doc.getElementById('r') as HTMLElement; };
const APP = 'com.example.mailer';

const plan = (over: Partial<SetupChangePlan> = {}): SetupChangePlan => ({
  appId: APP, from: { profile: 'personal', configDigest: 'a', grantDigest: 'g' }, to: { profile: 'personal-private', configDigest: 'b', grantDigest: 'h' },
  unchanged: false, valuesOnly: false,
  grantDiff: { added: ['home:private', 'home-sidecar:terminal'], removed: ['home:app'], changed: true },
  approval: { appId: APP, installationId: 'i', profile: 'personal-private', configDigest: 'b', grantDigest: 'h', adds: { permissions: [], tools: [], context: [], homePrivate: true, homePrivateSidecars: ['terminal'] } },
  compatibility: [], blocking: [],
  dataStaysBehind: [{ kind: 'app-home', where: 'Mailer\'s App Home', why: 'kept, not copied' }, { kind: 'instance-data', where: 'Mailer\'s instance data', why: 'keeps its owner', ownership: { writtenAs: 'app', runsAs: 'user', migrated: false } }],
  note: DATA_STAYS_NOTE, ...over,
});

test('change plan: added and given-up privileges, the approval summary, data that stays behind with the note', () => {
  const r = root();
  ui.renderChangePlan(r, { plan: plan(), appName: 'Mailer' });
  const diff = [...r.querySelectorAll<HTMLElement>('[data-diff]')].map((e) => e.dataset['diff']);
  assert.deepEqual(diff, ['added:home:private', 'added:home-sidecar:terminal', 'removed:home:app']);
  assert.ok(r.querySelector('[data-add="home:private"][data-risk="high"]'), 'the approval summary of the plan');
  assert.deepEqual([...r.querySelectorAll<HTMLElement>('[data-stays-behind]')].map((e) => e.dataset['staysBehind']), ['app-home', 'instance-data']);
  assert.ok(r.textContent!.includes(DATA_STAYS_NOTE));
  ui.renderChangePlan(r, { plan: plan({ unchanged: true }) });
  assert.match(r.textContent!, /Nothing changes/);
  ui.renderChangePlan(r, { plan: plan({ valuesOnly: true, approval: null, grantDiff: { added: [], removed: [], changed: false }, dataStaysBehind: [] }) });
  assert.match(r.textContent!, /no approval is needed/);
});

test('last applied: secrets by name only, the notice that data is not rolled back, restore disabled when current', () => {
  const r = root();
  let restored = 0;
  const view = { appId: APP, profile: 'personal', configDigest: 'd', appliedAt: '2026-11-27', current: false, values: { smtpHost: 'h' }, secretFields: ['password'], notice: RESTORE_NOTICE };
  ui.renderLastApplied(r, { view }, { restore() { restored++; } });
  assert.ok(r.textContent!.includes(RESTORE_NOTICE));
  assert.match(r.textContent!, /password: \(secret, kept in the vault\)/);
  r.querySelector<HTMLButtonElement>('[data-action="restore-last"]')!.click();
  assert.equal(restored, 1);
  ui.renderLastApplied(r, { view: { ...view, current: true } }, { restore() { restored++; } });
  assert.equal(r.querySelector<HTMLButtonElement>('[data-action="restore-last"]')!.disabled, true);
});

test('Private Home grants: one revoke per grant (the app, each sidecar)', () => {
  const r = root();
  const revoked: Array<string | undefined> = [];
  ui.renderPrivateHomeGrants(r, { grants: [{ permission: 'home.private' }, { permission: 'home.private.sidecar:terminal', sidecar: 'terminal' }] }, { revoke(s) { revoked.push(s); } });
  for (const b of r.querySelectorAll<HTMLButtonElement>('[data-action="revoke-private-home"]')) b.click();
  assert.deepEqual(revoked, [undefined, 'terminal']);
});

test('Settings → Apps → Configuration: reads the setup API, previews the change, applies, restores and revokes through it; no secret value', async () => {
  const r = root();
  const reads: Array<[string, unknown]> = [];
  const changes: Array<[string, string, unknown]> = [];
  const SECRET = 'hunter2-value';
  const io = {
    async read<T>(path: string, body?: unknown): Promise<T> {
      reads.push([path, body]);
      if (path.endsWith('/plan')) {
        return {
          appId: APP, state: { appId: APP, installationId: 'i', declares: true, state: 'ready', profile: 'personal', step: 'done', configDigest: 'a', degraded: [] },
          steps: [], approval: null, blocking: [], degraded: [], configDigest: 'a', grantDigest: 'g', requirements: [],
          profiles: [{ id: 'personal', title: 'Personal', recommended: true, available: true, reasons: [] }, { id: 'personal-private', title: 'Private', recommended: false, available: true, reasons: [] }],
          fields: [{ name: 'smtpHost', field: { type: 'string', title: 'SMTP host' }, value: 'h' }, { name: 'password', field: { type: 'secret', title: 'Password', secret: { source: 'vault' } }, hasSecret: true }],
        } as T;
      }
      if (path.endsWith('/change')) return plan() as T;
      if (path.endsWith('/restore')) return { lastApplied: { appId: APP, profile: 'personal', configDigest: 'z', appliedAt: 't', current: false, values: {}, secretFields: ['password'], notice: RESTORE_NOTICE } } as T;
      if (path.endsWith('/home-private')) return [{ permission: 'home.private' }] as T;
      throw new Error(`unexpected ${path}`);
    },
    async change(path: string, method: string, body?: unknown) {
      changes.push([path, method, body]);
      return { status: 202, body: { status: 'on-hold', state: {}, approvalId: 'apr_1', ...(path.endsWith('/restore') ? { notice: RESTORE_NOTICE } : {}) } };
    },
  };
  await renderAppConfig(r, APP, io);
  assert.match(r.querySelector('[data-state]')!.textContent!, /ready · profile personal/);
  // Pick the other profile → the change plan is previewed (read-only POST …/change with the proposal).
  const radio = r.querySelector<HTMLInputElement>('[data-profile="personal-private"] input[type="radio"]');
  assert.ok(radio, 'the profile selector renders the profiles');
  radio.checked = true;
  radio.dispatchEvent(new dom.Event('change') as unknown as Event);
  await new Promise((res) => setTimeout(res, 10));
  const changeReads = reads.filter(([p]) => p.endsWith('/change'));
  assert.equal(changeReads.length, 1);
  assert.equal((changeReads[0]![1] as { profile?: string }).profile, 'personal-private');
  assert.ok(r.querySelector('[data-stays-behind="app-home"]'));
  r.querySelector<HTMLButtonElement>('[data-action="apply"]')!.click();
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(changes[0]?.slice(0, 2), [`/api/apps/${APP}/setup/reconfigure`, 'POST']);
  assert.match(r.textContent!, /Waiting for your approval/);
  r.querySelector<HTMLButtonElement>('[data-action="restore-last"]')!.click();
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(changes[1]?.slice(0, 2), [`/api/apps/${APP}/setup/restore`, 'POST']);
  assert.ok(r.textContent!.includes(RESTORE_NOTICE));
  r.querySelector<HTMLButtonElement>('[data-action="revoke-private-home"]')!.click();
  await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(changes[2]?.slice(0, 2), [`/api/apps/${APP}/setup/home-private`, 'DELETE']);
  assert.ok(!r.innerHTML.includes(SECRET));
});
