// "Delete app" purges the app's data, trash and kept data, and retires its
// App Hosts (core nexus/removeApp.ts). Settings' confirmation must say so in
// the words of D20, "Delete app data". (The CLI's wording is tested in
// packages/aura-cli/test/kubectl.test.ts.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the Settings confirmation says the app data goes, and names no wrong path', () => {
  const page = readFileSync(new URL('../../../apps/com.aura.settings/src/pages/apps.astro', import.meta.url), 'utf8');
  const dialog = page.slice(page.indexOf('<dialog id="confirm-dialog"'), page.indexOf('</dialog>'));
  assert.match(dialog, /DELETE APP DATA/);
  assert.match(dialog, />Delete app data<\/button>/);
  for (const word of [/all its data/, /trash copies/, /kept from earlier installs/, /retired and never reused/, /can't be undone/]) {
    assert.match(dialog, word);
  }
  assert.doesNotMatch(page, /\/workspace\/apps\/\$\{appId\}/, 'a user app does not live there');
});
