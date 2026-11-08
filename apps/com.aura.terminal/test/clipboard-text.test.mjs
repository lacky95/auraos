// iOS turns clipboard text that parses as a URL into a URL item that pastes
// percent-encoded; the guard adds one zero-width space only when that would
// happen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZWSP, clipboardSafeText, detectIOS, looksLikeUrlToIOS } from '../src/clipboard-text.ts';

const CREDS = '  Username: gitlab+deploy-token-16772151\n  - Token: gldt-abc\n  - Can do: read_registry only';

test('"Word: …" text is what iOS mistakes for a URL; bullets and plain words are not', () => {
  assert.equal(looksLikeUrlToIOS(CREDS), true);
  assert.equal(looksLikeUrlToIOS('Token: x'), true);
  assert.equal(looksLikeUrlToIOS('https://example.com/a b'), true);
  assert.equal(looksLikeUrlToIOS('- Token: x'), false);
  assert.equal(looksLikeUrlToIOS('gldt-abc'), false);
  assert.equal(looksLikeUrlToIOS('ls -la /tmp'), false);
  assert.equal(looksLikeUrlToIOS('1password: no'), false, 'a scheme cannot start with a digit');
});

test('on iOS, URL-looking text with whitespace gets one invisible prefix; nothing else changes', () => {
  assert.equal(clipboardSafeText(CREDS, true), ZWSP + CREDS);
  assert.equal(clipboardSafeText('Token: gldt-abc', true), ZWSP + 'Token: gldt-abc');
  assert.equal(clipboardSafeText('https://example.com/path?q=1', true), 'https://example.com/path?q=1', 'a real URL stays exact');
  assert.equal(clipboardSafeText('gldt-abc', true), 'gldt-abc');
  assert.equal(clipboardSafeText('- Token: x\n- y', true), '- Token: x\n- y');
  assert.equal(clipboardSafeText('', true), '');
});

test('off iOS the text is never touched', () => {
  assert.equal(clipboardSafeText(CREDS, false), CREDS);
});

test('detectIOS: iPhone, iPad-as-Mac-with-touch, and not a desktop Mac or Android', () => {
  assert.equal(detectIOS({ platform: 'iPhone', maxTouchPoints: 5 }), true);
  assert.equal(detectIOS({ platform: 'MacIntel', maxTouchPoints: 5 }), true, 'iPadOS desktop-class UA');
  assert.equal(detectIOS({ platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(detectIOS({ platform: 'Linux armv8l', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  assert.equal(detectIOS({ platform: '', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }), true);
});
