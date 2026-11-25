// The theme CSS every app links (/api/os/theme.css) is built from `os/theme` in KV, which apps holding
// the theme permission write: a color mode outside light/dark/auto never reaches the CSS text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThemeManager } from '../dist/index.js';

test('an unknown color mode falls back to the default instead of being written into the CSS', () => {
  const css = ThemeManager.toCss(ThemeManager.DEFAULT_THEME_ID_LIGHT, ThemeManager.DEFAULT_THEME_ID_DARK, 'dark;}body{background:url(//x.test/a)}:root{x:y');
  assert.doesNotMatch(css, /x\.test|body\{/);
  assert.match(css, new RegExp(`--aura-color-mode: ${ThemeManager.DEFAULT_COLOR_MODE};`));
  for (const mode of ['light', 'dark', 'auto']) {
    assert.match(ThemeManager.toCss(ThemeManager.DEFAULT_THEME_ID_LIGHT, ThemeManager.DEFAULT_THEME_ID_DARK, mode), new RegExp(`--aura-color-mode: ${mode};`));
  }
});
