/**
 * The onboarding files AuraOS ships for the user home (os/home-seed): what
 * `AppManager.seedUserHome` does at boot.
 *
 *   1. Every seed file the home lacks is copied (subdirectories mirrored).
 *      An existing file is the user's and is never overwritten.
 *   2. A section of the seed's AGENTS.md between
 *      `<!-- aura:section <name> -->` and `<!-- /aura:section <name> -->` that
 *      the home's AGENTS.md lacks (no start marker) is appended to it once,
 *      so homes seeded before the section existed get it too. The user's own
 *      text is left as it is. Once there, the section is the user's too:
 *      edits stay, and it is appended again only if its start marker is gone.
 *   3. `~/CLAUDE.md` exactly as an older AuraOS seeded it (`@AGENTS.md`) is
 *      removed once `~/.claude/CLAUDE.md` imports `~/AGENTS.md`: Claude loads
 *      the user memory in every directory, `~` included, so the home pointer
 *      only repeated it. Edited, it stays. Codex reads `~/AGENTS.md` itself.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `~/CLAUDE.md` as the seed shipped it before `~/.claude/CLAUDE.md` existed. */
export const LEGACY_HOME_CLAUDE_MD =
  '# AuraOS\n\nThe single source of truth for this home is AGENTS.md (Codex reads it too). Edit that file, not this one.\n\n@AGENTS.md\n';

const SECTION = /<!-- aura:section ([a-z0-9-]+) -->\n[\s\S]*?<!-- \/aura:section \1 -->\n?/g;

/** The marked sections of a seed AGENTS.md, by name. */
export function seedSections(text: string): Array<{ name: string; text: string }> {
  return [...text.matchAll(SECTION)].map((m) => ({ name: m[1]!, text: m[0].endsWith('\n') ? m[0] : `${m[0]}\n` }));
}

export interface HomeSeedResult {
  /** Seed files copied because the home lacked them. */
  copied: string[];
  /** Sections appended to an existing ~/AGENTS.md. */
  appended: string[];
  /** Whether the legacy ~/CLAUDE.md pointer was removed. */
  removedLegacyClaudeMd: boolean;
}

/** Seed `home` from `seedDir`. Idempotent; see the file comment. */
export function seedHome(seedDir: string, home: string, warn: (msg: string) => void = () => undefined): HomeSeedResult {
  const result: HomeSeedResult = { copied: [], appended: [], removedLegacyClaudeMd: false };
  const agents = join(home, 'AGENTS.md');
  const hadAgents = existsSync(agents);

  for (const name of readdirSync(seedDir, { recursive: true }) as string[]) {
    const src = join(seedDir, name);
    const dst = join(home, name);
    if (!lstatSync(src).isFile() || existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      result.copied.push(name);
    } catch (err) {
      warn(`could not seed ${name} into ${home}: ${(err as Error).message}`);
    }
  }

  const seedAgents = join(seedDir, 'AGENTS.md');
  if (hadAgents && existsSync(seedAgents)) {
    try {
      const mine = readFileSync(agents, 'utf-8');
      const missing = seedSections(readFileSync(seedAgents, 'utf-8'))
        .filter((s) => !mine.includes(`<!-- aura:section ${s.name} -->`));
      if (missing.length) {
        const sep = mine.length === 0 || mine.endsWith('\n\n') ? '' : mine.endsWith('\n') ? '\n' : '\n\n';
        writeFileSync(agents, mine + sep + missing.map((s) => s.text).join('\n'));
        result.appended = missing.map((s) => s.name);
      }
    } catch (err) {
      warn(`could not update ${agents}: ${(err as Error).message}`);
    }
  }

  const homeClaude = join(home, 'CLAUDE.md');
  try {
    const user = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8');
    if (/^@~\/AGENTS\.md\s*$/m.test(user) && readFileSync(homeClaude, 'utf-8') === LEGACY_HOME_CLAUDE_MD) {
      unlinkSync(homeClaude);
      result.removedLegacyClaudeMd = true;
    }
  } catch { /* one of them is missing: nothing to tidy */ }
  return result;
}
