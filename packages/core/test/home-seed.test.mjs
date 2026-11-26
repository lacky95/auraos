// The user home seed (app-manager/homeSeed.ts): missing files are copied,
// new marked AGENTS.md sections reach homes seeded before they existed, user
// edits are never overwritten, and the legacy ~/CLAUDE.md pointer goes once
// ~/.claude/CLAUDE.md loads AGENTS.md everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_HOME_CLAUDE_MD, seedHome, seedSections } from '../dist/app-manager/homeSeed.js';

const REAL_SEED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'os', 'home-seed');
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const SECTION = '<!-- aura:section working-on-aura-apps -->\n## Working on Aura apps\n\nRun `aura dev status <app>`.\n<!-- /aura:section working-on-aura-apps -->\n';

function world() {
  const root = mkdtempSync(join(tmpdir(), 'aura-home-seed-'));
  const seed = join(root, 'seed');
  const home = join(root, 'home');
  put(join(seed, 'AGENTS.md'), `# AuraOS\n\nIntro.\n\n${SECTION}\n## Your notes\n`);
  put(join(seed, '.claude', 'CLAUDE.md'), '# AuraOS\n\n@~/AGENTS.md\n');
  mkdirSync(home, { recursive: true });
  return { seed, home };
}

test('a fresh home gets every seed file, and nothing is appended twice', () => {
  const { seed, home } = world();
  const r = seedHome(seed, home);
  assert.deepEqual(r.copied.sort(), ['.claude/CLAUDE.md', 'AGENTS.md']);
  assert.deepEqual(r.appended, []);
  const again = seedHome(seed, home);
  assert.deepEqual([again.copied, again.appended], [[], []]);
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf-8'), readFileSync(join(seed, 'AGENTS.md'), 'utf-8'));
});

test('an existing home: the section is appended once after the user\'s text; ~/.claude/CLAUDE.md is created; the legacy ~/CLAUDE.md goes', () => {
  const { seed, home } = world();
  const mine = '# AuraOS — agent primer\n\nOld text.\n\n## Your notes\n\n- my convention\n';
  put(join(home, 'AGENTS.md'), mine);
  put(join(home, 'CLAUDE.md'), LEGACY_HOME_CLAUDE_MD);
  const r = seedHome(seed, home);
  assert.deepEqual(r.copied, ['.claude/CLAUDE.md']);
  assert.deepEqual(r.appended, ['working-on-aura-apps']);
  assert.equal(r.removedLegacyClaudeMd, true);
  assert.equal(existsSync(join(home, 'CLAUDE.md')), false);
  const after = readFileSync(join(home, 'AGENTS.md'), 'utf-8');
  assert.ok(after.startsWith(mine), 'the user\'s text is untouched');
  assert.equal(after, `${mine}\n${SECTION}`);

  // Idempotent, and the user's later edits inside the section stay.
  writeFileSync(join(home, 'AGENTS.md'), after.replace('Run `aura dev status <app>`.', 'My own wording.'));
  const again = seedHome(seed, home);
  assert.deepEqual([again.copied, again.appended, again.removedLegacyClaudeMd], [[], [], false]);
  assert.match(readFileSync(join(home, 'AGENTS.md'), 'utf-8'), /My own wording\./);
});

test('user edits are never overwritten: an edited ~/CLAUDE.md stays, an own ~/.claude/CLAUDE.md is not replaced', () => {
  const { seed, home } = world();
  put(join(home, 'AGENTS.md'), 'mine, no trailing newline');
  put(join(home, 'CLAUDE.md'), `${LEGACY_HOME_CLAUDE_MD}\n- also my rule\n`);
  put(join(home, '.claude', 'CLAUDE.md'), '# my global rules\n');
  const r = seedHome(seed, home);
  assert.deepEqual(r.copied, []);
  assert.equal(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8'), '# my global rules\n');
  assert.equal(r.removedLegacyClaudeMd, false);
  assert.ok(existsSync(join(home, 'CLAUDE.md')), 'edited: kept');
  assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf-8'), `mine, no trailing newline\n\n${SECTION}`);

  // An unedited legacy pointer stays too while ~/.claude/CLAUDE.md does not load AGENTS.md (no second copy then).
  writeFileSync(join(home, 'CLAUDE.md'), LEGACY_HOME_CLAUDE_MD);
  assert.equal(seedHome(seed, home).removedLegacyClaudeMd, false);
  assert.ok(existsSync(join(home, 'CLAUDE.md')));
});

test('the shipped seed: AGENTS.md has the marked sections, ~/.claude/CLAUDE.md imports it, no ~/CLAUDE.md', () => {
  const sections = seedSections(readFileSync(join(REAL_SEED, 'AGENTS.md'), 'utf-8'));
  // "Working on Aura apps" (Track P) and the MCP token by reference (D89 B5, phase5/d28-b457).
  assert.deepEqual(sections.map((s) => s.name), ['working-on-aura-apps', 'mcp-token-by-reference']);
  assert.match(sections[1].text, /^<!-- aura:section mcp-token-by-reference -->\n[\s\S]*AURA_INSTANCE_TOKEN/);
  assert.match(sections[0].text, /^<!-- aura:section working-on-aura-apps -->\n## Working on Aura apps\n/);
  assert.match(sections[0].text, /aura dev status <app>/);
  assert.match(readFileSync(join(REAL_SEED, '.claude', 'CLAUDE.md'), 'utf-8'), /^@~\/AGENTS\.md$/m);
  assert.equal(existsSync(join(REAL_SEED, 'CLAUDE.md')), false);
});
