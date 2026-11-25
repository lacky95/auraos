// A VIEW of an App Host address names the app that holds it (Aura Browser
// opens other apps as their own Activity this way), over a fake registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHostViewTarget, VIEW_ACTION } from '../src/lib/appHostIntent.ts';

const labels: Record<string, { status: string; record?: { appId: string } }> = {
  notes1234: { status: 'active', record: { appId: 'io.acme.notes' } },
  gone1234: { status: 'retired' },
};
const registry = async () => ({ resolveLabel: async (l: string) => labels[l] ?? { status: 'unknown' } });
const view = (uri: string, extra: Record<string, string> = {}) => appHostViewTarget({ action: VIEW_ACTION, uri, ...extra }, { registry });

test('an active App Host label on a desktop host resolves to its app', async () => {
  assert.equal(await view('http://notes1234--10-201-1-2.nip.io:3000/doc/1'), 'io.acme.notes');
  assert.equal(await view('http://notes1234--os.aura.localhost:3000/'), 'io.acme.notes');
});

test('anything else stays an ordinary web address', async () => {
  assert.equal(await view('https://example.com/'), null);
  assert.equal(await view('http://10-201-1-2.nip.io:3000/'), null, 'the desktop itself');
  assert.equal(await view('http://other1234--10-201-1-2.nip.io:3000/'), null, 'unknown label');
  assert.equal(await view('http://gone1234--10-201-1-2.nip.io:3000/'), null, 'retired label');
  assert.equal(await view('http://notes1234--unlisted.example/'), null, 'custom domain not in AURA_DESKTOP_HOSTS');
  assert.equal(await view('http://u:p@notes1234--10-201-1-2.nip.io:3000/'), null, 'credentials in the authority');
  assert.equal(await view('ftp://notes1234--10-201-1-2.nip.io/'), null);
  assert.equal(await view('not a url'), null);
});

test('only an implicit VIEW is resolved', async () => {
  const uri = 'http://notes1234--10-201-1-2.nip.io:3000/';
  assert.equal(await appHostViewTarget({ action: 'aura.intent.action.SEND', uri }, { registry }), null);
  assert.equal(await view(uri, { appId: 'io.other' }), null, 'an explicit target stays as named');
  assert.equal(await view(uri, { instanceId: 'io.other-1' }), null);
});

test('no registry, or a failing one, resolves nothing', async () => {
  const uri = 'http://notes1234--10-201-1-2.nip.io:3000/';
  assert.equal(await appHostViewTarget({ action: VIEW_ACTION, uri }, { registry: async () => null }), null);
  const failing = async () => ({ resolveLabel: async () => { throw new Error('kv down'); } });
  assert.equal(await appHostViewTarget({ action: VIEW_ACTION, uri }, { registry: failing }), null);
});

test('integration: a VIEW of a system app\'s App Host is refused like naming it (start.ts runs the lookup first)', async () => {
  const { explicitTargetRefusal } = await import('../src/lib/intentTarget.ts');
  const sysLabels: Record<string, { status: string; record?: { appId: string } }> = {
    settings1: { status: 'active', record: { appId: 'com.aura.settings' } },
  };
  const sysRegistry = async () => ({ resolveLabel: async (l: string) => sysLabels[l] ?? labels[l] ?? { status: 'unknown' } });
  const mgr = {
    getInstance: () => undefined,
    getManifest: (id: string) => ({ scopeId: id.startsWith('com.aura.') ? 'system' : 'user' }),
  };
  const intent: { action: string; uri: string; appId?: string } = { action: VIEW_ACTION, uri: 'http://settings1--10-201-1-2.nip.io:3000/' };
  const target = await appHostViewTarget(intent, { registry: sysRegistry });
  if (target) intent.appId = target;
  assert.match(String(explicitTargetRefusal(intent, { appId: 'com.aura.browser' }, mgr)), /may not name com\.aura\.settings/);
  // An ordinary app's App Host still opens.
  const notes: { action: string; uri: string; appId?: string } = { action: VIEW_ACTION, uri: 'http://notes1234--10-201-1-2.nip.io:3000/' };
  notes.appId = (await appHostViewTarget(notes, { registry: sysRegistry })) ?? undefined;
  assert.equal(explicitTargetRefusal(notes, { appId: 'com.aura.browser' }, mgr), null);
});
