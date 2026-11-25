// Where an address may load in the engine frame, and with which sandbox
// (src/lib/engine-policy.ts), plus the frame as the page ships it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BLANK_SANDBOX, ENGINE_REFERRER_POLICY, EXTERNAL_SANDBOX, classifyEngineUrl, desktopHostOf,
  readableLoadAllowed, sandboxFor,
} from '../src/lib/engine-policy.ts';

const SELF = 'http://browser48894422--10-201-1-2.nip.io:3000';
const SHELL = 'http://10-201-1-2.nip.io:3000';
const ctx = { selfOrigin: SELF, shellOrigin: SHELL };
const kind = (url, c = ctx) => classifyEngineUrl(url, c).kind;
const flags = (s) => s.split(/\s+/).filter(Boolean);

test('websites load on their own origin', () => {
  assert.equal(kind('https://duckduckgo.com/?q=AuraOS'), 'external');
  assert.equal(kind('http://example.com:8080/login'), 'external');
  assert.equal(kind('https://xn--bcher-kva.example/'), 'external', 'punycode is a website');
  // Another AuraOS (or this machine by another name) is not this desktop: its
  // own frame-ancestors decide, and its cookies are not this desktop's.
  assert.equal(kind('http://notes1234--10-9-9-9.nip.io:3000/'), 'external');
  assert.equal(kind('http://10.201.1.2:3000/'), 'external');
});

test('another Aura app on this desktop opens as its own window', () => {
  assert.equal(kind('http://notes1234--10-201-1-2.nip.io:3000/'), 'app');
  assert.equal(kind('http://NOTES1234--10-201-1-2.nip.io:3000/doc?x=1#y'), 'app');
  assert.equal(kind('https://notes1234--10-201-1-2.nip.io:3000/'), 'app', 'the scheme does not make it foreign');
});

test('the Browser itself and the shell never load', () => {
  assert.equal(kind(`${SELF}/`), 'self');
  assert.equal(kind(`${SELF}/api/history`), 'self');
  assert.equal(kind(`${SELF}/_aura/os/api/apps`), 'self');
  assert.equal(kind(`${SHELL}/`), 'shell');
  assert.equal(kind(`${SHELL}/api/proxy/com.aura.notepad/`), 'shell');
  assert.equal(kind('https://10-201-1-2.nip.io:3000/login'), 'shell');
});

test('non-web schemes and spoofed authorities are refused', () => {
  for (const url of [
    'about:blank', 'about:srcdoc', 'data:text/html,<script>parent.x=1</script>', `blob:${SELF}/0b2f`,
    'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/', 'chrome://settings', 'not a url', '',
    'http://user:pw@example.com/', `http://x@${SHELL.slice(7)}/`,
  ]) assert.equal(kind(url), 'refused', url);
});

test('without the runtime the shell is derived from the App Host name', () => {
  const noShell = { selfOrigin: SELF, shellOrigin: null };
  assert.equal(desktopHostOf(noShell), '10-201-1-2.nip.io:3000');
  assert.equal(kind(`${SHELL}/`, noShell), 'shell');
  assert.equal(kind('http://notes1234--10-201-1-2.nip.io:3000/', noShell), 'app');
  // Opened outside AuraOS altogether: only itself is special.
  const bare = { selfOrigin: 'http://localhost:4001', shellOrigin: null };
  assert.equal(kind('http://localhost:4001/', bare), 'self');
  assert.equal(kind('http://notes1234--10-201-1-2.nip.io:3000/', bare), 'external');
});

test('sandbox per case: only websites get scripts with their own origin', () => {
  assert.equal(sandboxFor('external'), EXTERNAL_SANDBOX);
  for (const k of ['app', 'self', 'shell', 'refused']) assert.equal(sandboxFor(k), null, k);
  const ext = flags(EXTERNAL_SANDBOX);
  for (const f of ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox']) {
    assert.ok(ext.includes(f), f);
  }
  assert.ok(!ext.some((f) => f.startsWith('allow-top-navigation')), 'a site never navigates the desktop');
  assert.deepEqual(flags(BLANK_SANDBOX), [], 'a reset frame runs nothing and has an opaque origin');
  assert.equal(ENGINE_REFERRER_POLICY, 'no-referrer');
});

test('a readable load may stay only as an about: document', () => {
  assert.equal(readableLoadAllowed('about:blank'), true);
  assert.equal(readableLoadAllowed(`${SELF}/`), false);
  assert.equal(readableLoadAllowed(`${SELF}/_aura/os/api/os/theme.css`), false);
  assert.equal(readableLoadAllowed(`blob:${SELF}/0b2f`), false);
});

test('the shipped engine frame starts empty and fully sandboxed', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const at = page.indexOf('id="engine"');
  const frame = page.slice(page.lastIndexOf('<iframe', at), page.indexOf('></iframe>', at));
  assert.match(frame, /\bsandbox=""/);
  assert.doesNotMatch(frame, /\bsrc=/, 'nothing loads before the policy classified it');
  assert.match(frame, new RegExp(`referrerpolicy="${ENGINE_REFERRER_POLICY}"`));
  assert.match(frame, /data-initial=\{INITIAL_URL\}/);
  // Every place that sets the engine's src sets its sandbox first.
  const script = page.slice(page.indexOf('<script is:inline>'));
  const srcSets = script.match(/engine\.setAttribute\('src'/g) ?? [];
  const sandboxSets = script.match(/engine\.setAttribute\('sandbox'/g) ?? [];
  assert.ok(srcSets.length > 0);
  assert.equal(sandboxSets.length, srcSets.length);
});
