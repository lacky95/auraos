/**
 * What an app's own source uses of the app contract (D48), so `aura dev
 * validate` and the shell's contract report can name undeclared use with
 * file:line. A best-effort text scan of the app's source files (no build
 * output, no dependencies): it finds the usual spellings, not every one.
 *
 *   context-undeclared   `context.get('KEY')` with KEY missing from `context[]`
 *   context-raw          a read of the raw mounted Context (`/run/context`), or,
 *                        when the live keys are given, of a Context key from
 *                        the env. Works until Phase 5, not the contract.
 *   permission-undeclared an SDK call whose permission isn't in `permissions[]`
 *   docker-undeclared    the docker CLI or socket without "docker" in `tools[]`
 *   interface-undeclared `interfaces.resolve('…')` of a name `consumes[]` lacks
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { contractDeclarations } from './appContract.js';

export interface ContractSourceFinding {
  /** Relative to the app dir. */
  file: string;
  line: number;
  severity: 'warn' | 'info';
  code: 'context-undeclared' | 'context-raw' | 'permission-undeclared' | 'docker-undeclared' | 'interface-undeclared';
  message: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.next', '.git', '.turbo', '.cache', '.output', '.svelte-kit']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.astro', '.vue', '.svelte', '.py', '.sh']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 4000;

function sourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(e)) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && SOURCE_EXTS.has(extname(e)) && st.size <= MAX_FILE_BYTES && !e.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(appDir);
  return out.sort();
}

const isComment = (l: string): boolean => /^\s*(\/\/|\*|\/\*|<!--|#(?!!))/.test(l);

/** SDK calls and the permission each needs (D48 contract checklist). */
const PERMISSION_USES: ReadonlyArray<{ re: RegExp; permission: string; what: string }> = [
  { re: /\buser\.confirm\s*\(/, permission: 'user.confirm', what: 'osClient.user.confirm' },
  { re: /\bcredentials\.request\s*\(/, permission: 'credentials.request', what: 'osClient.credentials.request' },
  { re: /\bosClient\.storage\b|\bstorage\.shared\.(get|set|delete)\s*\(/, permission: 'storage.read', what: 'osClient.storage' },
  { re: /\bosSidecars\s*\(/, permission: 'sidecars.spawn', what: 'osSidecars()' },
  { re: /\bsendNotification\s*\(|\bnotifications\.create\s*\(/, permission: 'system.notifications', what: 'notifications' },
];
const DOCKER_RE = /\/var\/run\/docker\.sock|\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`]docker\b|^\s*docker\s+(run|exec|ps|pull|rm|build)\b/;
const CONTEXT_GET_RE = /\bcontext\.get\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]/g;
const RAW_CONTEXT_RE = /(^|[\s'"`(=])\/run\/context\b/;
const RESOLVE_RE = /\binterfaces\.resolve\(\s*['"`]([^'"`]+)['"`]/g;

type ScanManifest = Pick<AppManifest, 'permissions' | 'tools' | 'services' | 'consumes' | 'auraContract'> & { context?: string[] };

/** Findings in one file's text. `contextKeys`: the live Context keys, to spot env reads of them. */
export function scanContractText(rel: string, text: string, m: ScanManifest, contextKeys: readonly string[] = []): ContractSourceFinding[] {
  const d = contractDeclarations(m);
  const out: ContractSourceFinding[] = [];
  const envKeyRe = contextKeys.length
    ? new RegExp(`\\bprocess\\.env(?:\\.|\\[\\s*['"\`])(${contextKeys.map((k) => k.replace(/[^A-Z0-9_]/g, '')).join('|')})\\b|\\bos\\.environ(?:\\.get\\(\\s*|\\[\\s*)['"](${contextKeys.join('|')})['"]`)
    : null;
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (isComment(l)) return;
    const line = i + 1;
    for (const match of l.matchAll(CONTEXT_GET_RE)) {
      if (!d.context.includes(match[1]!)) {
        out.push({ file: rel, line, severity: 'warn', code: 'context-undeclared',
          message: `context.get('${match[1]}') needs "${match[1]}" in the manifest's context[]: AuraOS refuses undeclared keys` });
      }
    }
    if (RAW_CONTEXT_RE.test(l)) {
      out.push({ file: rel, line, severity: 'warn', code: 'context-raw',
        message: 'reads the raw mounted Context (/run/context): use osClient.context.get(key) and declare the key in context[]; the mount goes in Phase 5' });
    } else if (envKeyRe) {
      const m2 = envKeyRe.exec(l);
      if (m2) {
        const key = m2[1] ?? m2[2];
        out.push({ file: rel, line, severity: 'warn', code: 'context-raw',
          message: `reads the Context key ${key} from the env: use osClient.context.get('${key}') and declare it in context[]; the injection goes in Phase 5` });
      }
    }
    for (const u of PERMISSION_USES) {
      if (u.re.test(l) && !d.permissions.includes(u.permission)) {
        out.push({ file: rel, line, severity: 'warn', code: 'permission-undeclared',
          message: `${u.what} needs the permission ${u.permission} in permissions[]` });
      }
    }
    if (!d.docker && DOCKER_RE.test(l)) {
      out.push({ file: rel, line, severity: 'warn', code: 'docker-undeclared',
        message: 'uses the docker CLI or socket: declare "docker" in tools[] (or run sidecars through osSidecars and services[])' });
    }
    for (const match of l.matchAll(RESOLVE_RE)) {
      const ref = match[1]!;
      const name = ref.slice(ref.lastIndexOf('/') + 1);
      if (!(m.consumes ?? []).some((c) => c.name === name)) {
        out.push({ file: rel, line, severity: 'warn', code: 'interface-undeclared',
          message: `interfaces.resolve('${ref}'): declare it in consumes[] so AuraOS can report and check the dependency` });
      }
    }
  });
  return out;
}

/** Every contract finding in an app dir's source. */
export function scanContractSources(appDir: string, m: ScanManifest, contextKeys: readonly string[] = []): ContractSourceFinding[] {
  const out: ContractSourceFinding[] = [];
  for (const file of sourceFiles(appDir)) {
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    out.push(...scanContractText(relative(appDir, file), text, m, contextKeys));
  }
  return out;
}
