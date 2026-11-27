/**
 * App Host contract checks for `aura dev validate`.
 *
 * Since the Phase 2 cutover every UI app is served from `/` on its own App
 * Host origin, and `window.AuraRuntimeBootstrap` (from `/_aura/runtime.js`) is
 * the one source of identity and theme. Code written against the old proxied
 * model keeps compiling and then breaks quietly: a removed SDK export crashes
 * the page, a `meta[name="aura-…"]` read returns null, a `/api/proxy/…` URL
 * in a page is refused with 403, a manifest key zod no longer knows is
 * dropped without a word. These checks find those spots with `file:line`.
 *
 * Contract: apps/com.aura.docs/fumadocs-site/content/docs/building-for-app-hosts.mdx
 *
 * Pure functions over the file system; `dev.ts` prints the findings.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { contractFindings, runtimeDataIgnoreLines, scanContractSources, trackedRuntimeData, type AppManifest } from '@aura/core';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  rule: 'manifest-key' | 'sdk-import' | 'removed-global' | 'proxy-path' | 'upgrade-catch-all' | 'hmr-off' | 'contract' | 'runtime-data';
  message: string;
}

export const DOCS_HINT = 'Aura Docs: "Building an app for App Hosts" (building-for-app-hosts)';

// ─── manifest keys ──────────────────────────────────────────────────────────

/** Top-level keys editors and tooling add that are not manifest fields. */
const IGNORED_MANIFEST_KEYS = new Set(['$schema']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Paths of keys present in the raw manifest JSON but missing from the parsed
 * result, i.e. the ones zod stripped. Walks objects and arrays in lockstep.
 */
export function strippedKeyPaths(raw: unknown, parsed: unknown, path: string[] = []): string[][] {
  const out: string[][] = [];
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    raw.forEach((v, i) => { if (i < parsed.length) out.push(...strippedKeyPaths(v, parsed[i], [...path, String(i)])); });
    return out;
  }
  if (!isPlainObject(raw) || !isPlainObject(parsed)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (path.length === 0 && IGNORED_MANIFEST_KEYS.has(k)) continue;
    if (!(k in parsed)) out.push([...path, k]);
    else out.push(...strippedKeyPaths(v, parsed[k], [...path, k]));
  }
  return out;
}

/** 1-based line of a JSON key path in the manifest text (best effort: each segment searched after its parent). */
function jsonKeyLine(lines: string[], path: string[]): number {
  let at = 0;
  for (const seg of path) {
    if (/^\d+$/.test(seg)) continue;
    const re = new RegExp(`"${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
    const i = lines.findIndex((l, n) => n >= at && re.test(l));
    if (i >= 0) at = i;
  }
  return at + 1;
}

/**
 * Removed and unknown manifest keys: those the schema dropped while parsing.
 * `removed` maps a dotted path to why it went (dev.ts REMOVED_MANIFEST_KEYS);
 * any other stripped key is reported as unknown.
 */
export function lintManifestKeys(file: string, text: string, raw: unknown, parsed: unknown, removed: Record<string, string> = {}): Finding[] {
  const lines = text.split('\n');
  return strippedKeyPaths(raw, parsed).map((p) => {
    const dotted = p.filter((s) => !/^\d+$/.test(s)).join('.');
    const why = removed[dotted];
    return {
      file, line: jsonKeyLine(lines, p), severity: 'warn' as const, rule: 'manifest-key' as const,
      message: why
        ? `manifest key "${p.join('.')}" was ${why}; delete it`
        : `unknown manifest key "${p.join('.')}": the schema drops it silently (typo, or a field this AuraOS doesn't have)`,
    };
  });
}

// ─── source walk ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.next', '.git']);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.astro', '.vue', '.svelte', '.html', '.htm']);
/** Bigger files are bundles or vendored libraries, not the app's own code. */
const MAX_FILE_BYTES = 512 * 1024;

export function listSourceFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
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

function isCommentLine(l: string): boolean {
  const t = l.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// ─── @aura/app-sdk exports ──────────────────────────────────────────────────

export interface SdkExports {
  /** Where the SDK was found. */
  dir: string;
  /** Names each subpath ('.', './proxy', …) exports, values and types alike. */
  subpaths: Map<string, Set<string>>;
}

/** The SDK the app resolves: the nearest `node_modules/@aura/app-sdk` at or above the app dir. */
export function findAppSdkDir(appDir: string): string | null {
  let d = resolve(appDir);
  for (;;) {
    const c = join(d, 'node_modules', '@aura', 'app-sdk');
    if (existsSync(join(c, 'package.json'))) { try { return realpathSync(c); } catch { return c; } }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The workspace SDK, for apps without their own copy. */
export function findWorkspaceSdkDir(): string | null {
  const candidates = [
    process.env['AURA_APP_SDK_DIR'],
    // dist/aura.cjs (and .test-dist) sit two levels below packages/
    typeof __dirname === 'string' ? resolve(__dirname, '../../app-sdk') : undefined,
    '/workspace/packages/app-sdk',
  ];
  for (const c of candidates) if (c && existsSync(join(c, 'package.json')) && existsSync(join(c, 'dist'))) return c;
  return null;
}

/** Names a module file exports, following `export *` into relative files. Comments are ignored. */
export function collectExports(file: string, seen: Set<string> = new Set()): Set<string> {
  const names = new Set<string>();
  if (seen.has(file)) return names;
  seen.add(file);
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return names; }
  text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const decl = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(decl)) names.add(m[1]!);
  if (/\bexport\s+default\b/.test(text)) names.add('default');
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const spec of m[1]!.split(',')) {
      const s = spec.trim().replace(/^type\s+/, '');
      if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] ?? as[0])!.trim());
    }
  }
  for (const m of text.matchAll(/\bexport\s+\*\s+as\s+([\w$]+)\s+from/g)) names.add(m[1]!);
  for (const m of text.matchAll(/\bexport\s+\*\s+from\s*['"](\.[^'"]+)['"]/g)) {
    const target = resolveRelativeModule(dirname(file), m[1]!, file.endsWith('.d.ts'));
    if (target) for (const n of collectExports(target, seen)) names.add(n);
  }
  return names;
}

function resolveRelativeModule(dir: string, spec: string, preferTypes: boolean): string | null {
  const base = resolve(dir, spec);
  const noExt = base.replace(/\.(m|c)?js$/, '');
  const tries = preferTypes
    ? [`${noExt}.d.ts`, `${noExt}.d.mts`, base, `${base}.js`, join(base, 'index.d.ts')]
    : [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')];
  return tries.find((t) => existsSync(t) && statSync(t).isFile()) ?? null;
}

/** Every file an export condition can point at, types first (they list type names too). */
function exportTargets(entry: unknown): string[] {
  if (typeof entry === 'string') return [entry];
  if (!isPlainObject(entry)) return [];
  const out: string[] = [];
  for (const k of ['types', 'import', 'default', 'require', 'node']) out.push(...exportTargets(entry[k]));
  return out;
}

const sdkCache = new Map<string, SdkExports>();

/** Read an installed SDK's subpaths and what each exports, from its package.json `exports` and built files. */
export function readSdkExports(sdkDir: string): SdkExports {
  const hit = sdkCache.get(sdkDir);
  if (hit) return hit;
  const subpaths = new Map<string, Set<string>>();
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf-8')) as Record<string, unknown>; } catch { /* empty */ }
  const exp = pkg['exports'];
  const map: Record<string, unknown> = isPlainObject(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
    ? exp
    : { '.': exp ?? { types: pkg['types'], import: pkg['module'] ?? pkg['main'] } };
  for (const [sub, entry] of Object.entries(map)) {
    const names = new Set<string>();
    for (const t of exportTargets(entry)) {
      const f = join(sdkDir, t);
      if (existsSync(f)) for (const n of collectExports(f)) names.add(n);
    }
    subpaths.set(sub, names);
  }
  const res = { dir: sdkDir, subpaths };
  sdkCache.set(sdkDir, res);
  return res;
}

const SDK_SPEC = String.raw`@aura/app-sdk(?:/[^'"\s]*)?`;

/**
 * `@aura/app-sdk[/subpath]` imports the SDK doesn't provide. A missing value
 * import is an error (the page or server throws at module load); a missing
 * type-only import fails typecheck but runs, so it is a warning.
 * `upcoming` is a second SDK (the workspace one) to warn against when the
 * app's own copy still has a name the current SDK dropped.
 */
export function lintSdkImports(file: string, text: string, sdk: SdkExports, upcoming?: SdkExports): Finding[] {
  const out: Finding[] = [];
  const subOf = (spec: string) => (spec === '@aura/app-sdk' ? '.' : `.${spec.slice('@aura/app-sdk'.length)}`);
  const where = (s: SdkExports) => s.dir;

  // Every module specifier: a subpath the package doesn't export can't be resolved at all.
  const specRe = new RegExp(String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](${SDK_SPEC})['"]`, 'g');
  for (const m of text.matchAll(specRe)) {
    const spec = m[1]!;
    if (!sdk.subpaths.has(subOf(spec))) {
      out.push({ file, line: lineAt(text, m.index!), severity: 'error', rule: 'sdk-import',
        message: `"${spec}" is not exported by the installed SDK (${where(sdk)}): the import throws at load` });
    }
  }

  const namedRe = new RegExp(String.raw`\b(?:import|export)\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"](${SDK_SPEC})['"]`, 'g');
  for (const m of text.matchAll(namedRe)) {
    const typeOnlyStmt = Boolean(m[1]);
    const names = sdk.subpaths.get(subOf(m[3]!));
    if (!names) continue; // reported above
    const next = upcoming?.subpaths.get(subOf(m[3]!));
    const braceStart = m.index! + m[0].indexOf('{') + 1;
    let offset = 0;
    for (const raw of m[2]!.split(',')) {
      const here = braceStart + offset;
      offset += raw.length + 1;
      let s = raw.trim();
      if (!s) continue;
      const typeOnly = typeOnlyStmt || /^type\s+/.test(s);
      s = s.replace(/^type\s+/, '');
      const name = s.split(/\s+as\s+/)[0]!.trim();
      const line = lineAt(text, here + (raw.length - raw.trimStart().length));
      if (!names.has(name)) {
        out.push({ file, line, severity: typeOnly ? 'warn' : 'error', rule: 'sdk-import',
          message: typeOnly
            ? `type "${name}" is not exported by "${m[3]}" (${where(sdk)}): typecheck fails`
            : `"${name}" is not exported by "${m[3]}" (${where(sdk)}): the module throws at load${name === 'getAppBasePath' ? ' (apps are served from /; drop the base path)' : ''}` });
      } else if (next && upcoming && upcoming.dir !== sdk.dir && !next.has(name)) {
        out.push({ file, line, severity: 'warn', rule: 'sdk-import',
          message: `"${name}" comes from this app's own SDK copy; the current SDK (${where(upcoming)}) no longer exports it, so the app breaks on its next SDK update` });
      }
    }
  }
  return out;
}

// ─── removed globals and meta tags ──────────────────────────────────────────

const REMOVED_GLOBAL_RE = /\bAURA_(APP_BASE_PATH|APP_ID|INSTANCE_ID)\b/g;
const AURA_META_RE = /meta\s*\[\s*name\s*[~|^$*]?=\s*\\?["']?(aura-[\w-]+)|getElementsByName\(\s*['"](aura-[\w-]+)/g;

/** Reads of the AURA_* globals and the aura-* meta tags runtime.js no longer writes. */
export function lintRemovedGlobals(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split('\n');
  for (const m of text.matchAll(REMOVED_GLOBAL_RE)) {
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    if (/env\s*(?:\.\s*|\[\s*['"])$/.test(before)) continue;          // process.env.AURA_APP_ID: an env var, not the global
    const line = lineAt(text, m.index!);
    const src = lines[line - 1] ?? '';
    if (isCommentLine(src) || /\b(?:process|import\.meta)\.env\b/.test(src)) continue; // const { AURA_APP_ID } = process.env
    const fix = m[1] === 'APP_BASE_PATH' ? 'apps are served from /, so drop the base path' : `use appHostRuntime()?.${m[1] === 'APP_ID' ? 'appId' : 'instanceId'}`;
    out.push({ file, line, severity: 'warn', rule: 'removed-global',
      message: `reads the AURA_${m[1]} global, which runtime.js no longer sets: ${fix}` });
  }
  for (const m of text.matchAll(AURA_META_RE)) {
    const name = m[1] ?? m[2]!;
    const line = lineAt(text, m.index!);
    if (isCommentLine(lines[line - 1] ?? '')) continue;
    out.push({ file, line, severity: 'warn', rule: 'removed-global',
      message: `reads the <meta name="${name}"> tag; App Hosts serve no aura-* meta tags: use appHostRuntime() (appId, instanceId, theme.resolvedMode)` });
  }
  return out;
}

// ─── /api/proxy in browser-served files ─────────────────────────────────────

const CLIENT_DIRS = ['src/components/', 'src/layouts/', 'src/scripts/', 'src/client/', 'src/islands/'];
const CLIENT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte']);

/**
 * Which lines of a file the browser loads, or null for a server-only file.
 * `public/`, client component dirs, React/Vue/Svelte components and
 * `'use client'` modules count whole; an `.astro` file counts from the end of
 * its frontmatter (the frontmatter runs on the server).
 */
export function browserLineRange(rel: string, text: string): { from: number } | null {
  const r = rel.split(sep).join('/');
  const ext = extname(r);
  if (r.startsWith('public/')) return ['.html', '.htm', '.js', '.mjs'].includes(ext) ? { from: 1 } : null;
  if (ext === '.astro') {
    const fm = /^\s*---\r?\n[\s\S]*?\r?\n---/.exec(text);
    return { from: fm ? lineAt(text, fm[0].length) + 1 : 1 };
  }
  if (r.startsWith('src/pages/api/') || /(^|\/)(server|api|mcp|lib\/server)\//.test(r)) return null;
  if (/^\s*['"]use client['"]/.test(text)) return { from: 1 };
  if (!CLIENT_EXTS.has(ext)) return null;
  if (CLIENT_DIRS.some((d) => r.startsWith(d))) return { from: 1 };
  if (r.startsWith('src/') && ['.tsx', '.jsx', '.vue', '.svelte'].includes(ext)) return { from: 1 };
  return null;
}

/** `/api/proxy` URLs in code a browser runs. Server-side machine calls are not flagged. */
export function lintProxyPaths(file: string, rel: string, text: string): Finding[] {
  const range = browserLineRange(rel, text);
  if (!range) return [];
  const out: Finding[] = [];
  text.split('\n').forEach((l, i) => {
    if (i + 1 < range.from) return;
    if (isCommentLine(l)) return;
    const hit = /\/api\/proxy(?:\/|['"`$])/.exec(l);
    if (!hit) return;
    // `${OS_API_BASE}/api/proxy/<id>`: an address shown to agents (machine path), not one the page loads.
    if (/(?:OS_API_BASE|osApiBase)\}?\s*$/.test(l.slice(0, hit.index))) return;
    out.push({ file, line: i + 1, severity: 'warn', rule: 'proxy-path',
      message: 'browser code uses /api/proxy/…: a page on its App Host is served from /, and the proxy refuses browser pages (403). Use root-absolute URLs for your own app; call another app from your server' });
  });
  return out;
}

// ─── upgrade handlers and HMR ───────────────────────────────────────────────

/** Text of the call starting at `open` (an index just past `(`) up to its closing paren. */
function balancedCall(text: string, open: number, limit = 6000): string {
  let depth = 1;
  for (let i = open; i < text.length && i < open + limit; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open, open + limit);
}

const PATH_CHECK_RE = /\.url\b|pathname|startsWith|sec-websocket-protocol|vite-hmr/i;

/**
 * `on('upgrade')` handlers that look at no path: they also receive Vite's
 * `vite-hmr` socket (and any other app socket) and usually end it. And
 * `hmr: false` in a Vite/Astro config. Both informational.
 */
const TEST_FILE_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function lintUpgradeAndHmr(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  // A test's stub server is not the app's dev server.
  if (!TEST_FILE_RE.test(file.split(sep).join('/'))) for (const m of text.matchAll(/([\w$]+)\s*\??\.\s*on\(\s*['"]upgrade['"]\s*,/g)) {
    if (/req(uest)?$/i.test(m[1]!)) continue; // http.ClientRequest's 'upgrade': the response side, not a server
    let body = balancedCall(text, m.index! + m[0].indexOf('(') + 1);
    const ref = /^\s*['"]upgrade['"]\s*,\s*([\w$.]+)\s*$/.exec(body);
    if (ref) {
      const name = ref[1]!.split('.').pop()!;
      const def = new RegExp(String.raw`(?:function\s+${name}\s*\(|\b${name}\s*[=:]\s*(?:async\s*)?(?:function\b|\())`).exec(text);
      body = def ? text.slice(def.index, def.index + 2000) : '';
      if (!def) continue; // defined elsewhere: can't tell
    }
    if (PATH_CHECK_RE.test(body)) continue;
    out.push({ file, line: lineAt(text, m.index!), severity: 'info', rule: 'upgrade-catch-all',
      message: `${m[1]}.on('upgrade') handles every upgrade without a path check, so it also takes Vite's HMR socket (vite-hmr). Return early unless req.url is your socket path` });
  }
  if (/(^|\/)(astro|vite)\.config\.[cm]?[jt]s$/.test(file)) {
    for (const m of text.matchAll(/\bhmr\s*:\s*false\b/g)) {
      out.push({ file, line: lineAt(text, m.index!), severity: 'info', rule: 'hmr-off',
        message: 'Vite HMR is off (hmr: false): edits need a page reload' });
    }
  }
  return out;
}

// ─── the app contract (D48) ─────────────────────────────────────────────────

export const CONTRACT_DOCS_HINT = 'Aura Docs: "The Aura app contract" (app-contract)';

/**
 * The app contract checks: the manifest declares what the app uses
 * (contract version, Context keys, permissions, sidecars and their privileges,
 * docker, consumed interfaces), and the source uses only what it declares.
 * Warnings: nothing is enforced beyond Phase 3a. Core holds the rules
 * (contract/appContract.ts, contract/sourceScan.ts), shared with the shell's
 * contract report.
 */
export function lintContract(manifestFile: string, text: string, parsed: AppManifest, opts: { source?: boolean } = {}): Finding[] {
  const lines = text.split('\n');
  const out: Finding[] = contractFindings(parsed).map((f) => ({
    file: manifestFile, line: jsonKeyLine(lines, f.path.split('.')), severity: f.severity, rule: 'contract' as const, message: f.message,
  }));
  if (opts.source !== false) {
    const appDir = dirname(manifestFile);
    for (const f of scanContractSources(appDir, parsed)) {
      out.push({ file: join(appDir, f.file), line: f.line, severity: f.severity, rule: 'contract', message: f.message });
    }
  }
  return out;
}

/**
 * Runtime data or secrets the app's git repo tracks (PublishFiles
 * `trackedRuntimeData`): an app dir in the user and global scopes also holds
 * its instances' data (`<appId>/`) and sidecar volumes (`.sidecars/`).
 * `aura dev publish` and `nexus app publish` refuse them; this says so first.
 */
export function lintTrackedRuntimeData(appDir: string, appId: string): Finding[] {
  return trackedRuntimeData(appDir, appId).map((f) => ({
    file: join(appDir, f.file), line: 1, severity: 'warn' as const, rule: 'runtime-data' as const,
    message: `tracked by git but runtime data or a secret (${f.reason}): publishing refuses it — git rm --cached it and add `
      + `the runtime-data lines to .gitignore (${runtimeDataIgnoreLines(appId).slice(0, 3).join(' ')} …)`,
  }));
}

// ─── one app ────────────────────────────────────────────────────────────────

export interface LintOptions {
  /** Override SDK resolution (tests). */
  sdk?: SdkExports | null;
  upcomingSdk?: SdkExports | null;
}

/** Every source check over one app dir. Manifest keys are checked separately (they need the parse result). */
export function lintAppSources(appDir: string, opts: LintOptions = {}): Finding[] {
  let upcoming = opts.upcomingSdk;
  if (upcoming === undefined) { const ws = findWorkspaceSdkDir(); upcoming = ws ? readSdkExports(ws) : null; }
  let sdk = opts.sdk;
  if (sdk === undefined) { const own = findAppSdkDir(appDir); sdk = own ? readSdkExports(own) : upcoming; }
  const out: Finding[] = [];
  for (const file of listSourceFiles(appDir)) {
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    const rel = relative(appDir, file);
    if (sdk && text.includes('@aura/app-sdk')) out.push(...lintSdkImports(file, text, sdk, upcoming ?? undefined));
    out.push(...lintRemovedGlobals(file, text));
    out.push(...lintProxyPaths(file, rel, text));
    out.push(...lintUpgradeAndHmr(file, text));
  }
  return out;
}
