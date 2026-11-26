/**
 * The home import report (Q15; Phase 5 stream I). Read-only.
 *
 * App Homes start empty (Q15). This report lists, per installation, what in
 * today's shared home the app is likely to want, so the owner can copy it
 * selectively (`aura admin homes import`, appHomeAdmin.ts: it copies, never
 * moves, and leaves the Private Home untouched). It combines:
 *
 *   - a static table of known apps (Board, dev.box, TerminalX);
 *   - a heuristic: the dot-dirs the app's granted tools are known to use.
 *
 * It only `lstat`s the candidate paths (never opens or reads a file) and
 * never uses `atime` (relatime makes it unreliable). Personal credentials are
 * marked: copying them shares the owner's login with the app (D66: prefer a
 * fresh login in the app).
 */
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

/** Known apps and the home paths they use (phase5-plan.md stream I). */
export const IMPORT_STATIC_TABLE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'io.lakner.improvementboard': ['.claude.json', '.claude', '.codex'],
  'dev.box': ['.config/code-server', '.local/share/code-server', '.config/gh', '.config/glab-cli', '.gitconfig'],
  'io.lakner.terminalx': ['.gitconfig', '.config/glab-cli'],
});

/** Tool (capability) name → the home paths it keeps its state in. */
export const IMPORT_TOOL_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  claude: ['.claude.json', '.claude'],
  codex: ['.codex'],
  gh: ['.config/gh'],
  glab: ['.config/glab-cli'],
  git: ['.gitconfig'],
  ssh: ['.ssh'],
  npm: ['.npmrc'],
});

/** Paths whose contents are a personal login (prefix match on the relative path). */
const PERSONAL = ['.claude/.credentials.json', '.ssh', '.config/gh/hosts.yml', '.config/glab-cli/config.yml', '.npmrc', '.codex/auth.json'];
export const PERSONAL_NOTE = 'personal: copying shares your login with the app (D66: prefer a fresh login)';

export interface ImportReportInstallation {
  installationId: string;
  appId: string;
  /** The tools (capabilities) granted to the app. */
  tools?: readonly string[];
}

export interface ImportCandidate {
  /** Relative to the home. */
  path: string;
  source: 'static' | 'tool';
  /** The tool that suggested it (`source: tool`). */
  tool?: string;
  type: 'file' | 'dir' | 'link' | 'other';
  /** Files under a directory (bounded), or 1. */
  files: number;
  bytes: number;
  /** Personal credentials inside the candidate (relative paths); the candidate itself when it is one. */
  personal?: string[];
  note?: string;
}

export interface ImportReport {
  version: 1;
  generatedAt: string;
  home: string;
  installations: Array<{ installationId: string; appId: string; candidates: ImportCandidate[] }>;
}

const MAX_WALK = 50_000;

/** Whether a home-relative path is (inside) a personal login. */
export const isPersonalHomePath = (rel: string): boolean => PERSONAL.some((p) => rel === p || rel.startsWith(`${p}/`));
const isPersonal = isPersonalHomePath;

async function measure(home: string, rel: string): Promise<Omit<ImportCandidate, 'path' | 'source' | 'tool'> | null> {
  let st;
  try { st = await lstat(join(home, rel)); } catch { return null; }
  if (st.isSymbolicLink()) return { type: 'link', files: 0, bytes: 0 };
  if (!st.isDirectory()) {
    return { type: st.isFile() ? 'file' : 'other', files: 1, bytes: st.size, ...(isPersonal(rel) ? { personal: [rel] } : {}) };
  }
  let files = 0;
  let bytes = 0;
  const personal = new Set<string>();
  if (isPersonal(rel)) personal.add(rel);
  const stack = [rel];
  let truncated = false;
  while (stack.length && !truncated) {
    const dir = stack.pop()!;
    let handle;
    try { handle = await opendir(join(home, dir)); } catch { continue; }
    for await (const ent of handle) {
      if (files >= MAX_WALK) { truncated = true; break; }
      const r = `${dir}/${ent.name}`;
      if (isPersonal(r) && !isPersonal(dir)) personal.add(r);
      if (ent.isDirectory()) { stack.push(r); continue; }
      let s;
      try { s = await lstat(join(home, r)); } catch { continue; }
      files++;
      bytes += s.isFile() ? s.size : 0;
    }
  }
  return {
    type: 'dir', files, bytes,
    ...(personal.size ? { personal: [...personal].sort() } : {}),
    ...(truncated ? { note: `more than ${MAX_WALK} files; counts are lower bounds` } : {}),
  };
}

/** The candidates in `home` for each installation. Never writes, never reads a file's contents. */
export async function buildImportReport(
  home: string, installations: readonly ImportReportInstallation[], opts: { now?: () => number } = {},
): Promise<ImportReport> {
  const out: ImportReport = { version: 1, generatedAt: new Date((opts.now ?? Date.now)()).toISOString(), home, installations: [] };
  for (const inst of [...installations].sort((a, b) => a.appId.localeCompare(b.appId) || a.installationId.localeCompare(b.installationId))) {
    const wanted = new Map<string, { source: 'static' | 'tool'; tool?: string }>();
    for (const p of IMPORT_STATIC_TABLE[inst.appId] ?? []) wanted.set(p, { source: 'static' });
    for (const tool of [...(inst.tools ?? [])].sort()) {
      for (const p of IMPORT_TOOL_PATHS[tool] ?? []) if (!wanted.has(p)) wanted.set(p, { source: 'tool', tool });
    }
    const candidates: ImportCandidate[] = [];
    for (const [path, why] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
      const m = await measure(home, path);
      if (!m) continue;
      candidates.push({
        path, source: why.source, ...(why.tool ? { tool: why.tool } : {}), ...m,
        ...(m.personal?.length ? { note: m.note ? `${m.note}; ${PERSONAL_NOTE}` : PERSONAL_NOTE } : {}),
      });
    }
    out.installations.push({ installationId: inst.installationId, appId: inst.appId, candidates });
  }
  return out;
}
