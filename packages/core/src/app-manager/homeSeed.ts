/**
 * The onboarding files AuraOS ships for a Private Home (os/home-seed): what
 * `AppManager.seedPrivateHome` does at boot and when a Private Home is
 * resolved. App Homes are never seeded: they start empty (D65, Q15).
 *
 *   1. Every seed file the home lacks is copied (subdirectories mirrored).
 *      An existing file is the user's and is never overwritten.
 *   2. A section of the seed's AGENTS.md between
 *      `<!-- aura:section <name> -->` and `<!-- /aura:section <name> -->` that
 *      the home's AGENTS.md lacks (no start marker) is appended to it once,
 *      so homes seeded before the section existed get it too. The user's own
 *      text is left as it is. Once there, the section is the user's too:
 *      edits stay, and it is appended again only if its start marker is gone.
 *
 * The generic home-seeding contract (philosophy audit #2, 5b): the seeder
 * copies only. It never reads, rewrites or deletes a file because of what a
 * product does with it; which files exist and what they say is the seed's
 * (os/home-seed, an adapter), never the kernel's.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreWorkerPath } from '../system/workerPath.js';

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
}

/** Seed `home` from `seedDir`. Idempotent; see the file comment. */
export function seedHome(seedDir: string, home: string, warn: (msg: string) => void = () => undefined): HomeSeedResult {
  const result: HomeSeedResult = { copied: [], appended: [] };
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

  return result;
}

/**
 * Seed a home as its owner (D65, P5-2). A home owned by a user is the user's
 * to change, links included, so the shell never writes into it as root: a
 * planted symlink could aim a root write anywhere. The seed then runs in a
 * child process with the home's uid/gid (no capabilities beyond theirs), and
 * every file it creates is theirs. A root-owned home (before the ownership
 * apply) is seeded in-process, as before.
 */
export function seedHomeAs(seedDir: string, home: string, warn: (msg: string) => void = () => undefined): HomeSeedResult {
  let st;
  try { st = lstatSync(home); } catch { return { copied: [], appended: [] }; }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    warn(`${home} is not a directory; not seeded`);
    return { copied: [], appended: [] };
  }
  if (st.uid === 0) return seedHome(seedDir, home, warn);
  try {
    // Resolved at the call: core is also bundled as CommonJS (the CLI), which never seeds.
    const worker = coreWorkerPath(import.meta.url, 'homeSeedWorker.js', 'home-seed');
    const out = execFileSync(process.execPath, [worker, seedDir, home], {
      uid: st.uid, gid: st.gid, cwd: '/', env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf-8', timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const r = JSON.parse(out) as HomeSeedResult & { warnings?: string[] };
    for (const w of r.warnings ?? []) warn(w);
    return { copied: r.copied, appended: r.appended };
  } catch (err) {
    warn(`could not seed ${home} as its owner: ${(err as Error).message.split('\n')[0]}`);
    return { copied: [], appended: [] };
  }
}
