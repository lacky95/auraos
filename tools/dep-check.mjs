#!/usr/bin/env node
// The architecture dependency check (D97): module dependency rules for the
// kernel and its clients. Dependency-free, like tools/security-check.mjs.
//
//   node tools/dep-check.mjs [--root=<dir>] [--json] [--update] [--report] [--graph=<file>]
//
// Parses the static imports of packages/{core,shell,app-sdk,aura-cli,kv-store}
// (TS, TSX, MJS, JS and Astro frontmatter/scripts; `import type` is tracked
// separately and never counts as a runtime dependency) and checks the rules
// below. Known violations live in tools/dep-baseline.json (reason each): they
// do not fail the check, only new ones do, and the summary prints how many are
// left. A baselined violation that is gone is reported so its entry can be
// removed (--update rewrites the file and keeps existing reasons).
//
//   --report        print the graph summary (packages, modules, coupling, cycles)
//   --graph=<file>  write the full graph (files, edges, modules) as JSON
//   --json          machine-readable result
//
// Exit: 0 no new violation, 1 new violations, 2 tool error.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--');
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n) => args.includes(`--${n}`);
const ROOT = resolve(opt('root') ?? join(HERE, '..'));
const BASELINE = join(ROOT, 'tools/dep-baseline.json');

// ── the rules ───────────────────────────────────────────────────────────────

const RULES = {
  'core-cycle': 'No runtime import cycle between files of @aura/core (type-only imports are exempt).',
  'core-module-cycle': 'No entangled modules in @aura/core: a runtime import A/f -> B/g where g (transitively) imports module A again. Shared contracts belong in leaf files that import no other module.',
  'core-forbidden': '@aura/core never imports the shell, the UI, Astro, React, the SDK or the CLI.',
  'package-internals': 'A package reaches another workspace package only through its declared entry points (package.json `exports`), never by a relative path, `src/` or `dist/`.',
  'sdk-core': '@aura/app-sdk imports @aura/core only through its declared entry points and only for types or the declared leaf subpaths (never the kernel root at runtime).',
  'server-webshell': 'The server layer of @aura/shell (API routes, middleware, server/, and the lib modules they reach) never imports Web Shell code (components, layouts, stores, desktop pages) or UI libraries.',
  'foundation-leaf': 'Foundation modules of @aura/core (sector map in packages/core/AGENTS.md) import no other sector at runtime, except the barrel (src/index.ts) and the composition root (src/system/bootstrap.ts and src/system/compose.ts).',
  'kernel-presentation': 'Kernel sectors never import presentation-contract modules (theme, layout, keymap) at runtime.',
  'contract-leaf': 'Declared contract leaf files of @aura/core (the ARI contract, runtimes/ari.ts, types.ts and requirements.ts; the system app ids; the contract majors, contract/types.ts) import no other core module at runtime except another declared leaf, so any module may depend on them without a cycle (D97, 5b).',
  'runtime-no-bus': 'Runtime provider code (core/src/runtimes/** and the runners and engine files behind them) never imports the event bus (ipc/OsEventBus) at runtime: a runtime reports exits through onExit and the kernel emits app:* (D93 G1, 5b-2 D).',
  'agent-agnostic': 'Agent-aware but agent-agnostic (owner, philosophy audit): no product-specific agent knowledge (claude, codex, anthropic, openai, .claude/.codex paths, CLAUDE_CONFIG_DIR, CODEX_HOME, config.toml) in the code of @aura/core src or the shell server infrastructure (src/lib, server/); it belongs in apps, adapters, the home seed, docs and tests. Comments and the AGENTS.md/CLAUDE.md file convention do not count.',
  'agents-docs': 'Every AGENTS.md has a sibling CLAUDE.md that is exactly `@AGENTS.md`; the chain of AGENTS.md files from the root to any directory stays under 28 KiB (Codex stops adding files at project_doc_max_bytes, 32 KiB by default); the sector map in packages/core/AGENTS.md names every core module exactly once.',
};

const UI_PACKAGES = /^(react|react-dom|@aura\/ui|nanostores|@nanostores\/.*|simple-keyboard.*|socket\.io-client|@astrojs\/react|lucide-react)(\/|$)/;
const CORE_FORBIDDEN = /^(@aura\/(shell|ui|app-sdk|cli)|astro|@astrojs\/.*|react|react-dom|nanostores|@nanostores\/.*|socket\.io.*)(\/|$)/;

// ── sources ─────────────────────────────────────────────────────────────────

const PACKAGES = {
  core: { name: '@aura/core', roots: ['src'] },
  shell: { name: '@aura/shell', roots: ['src', 'server'], files: ['server.mjs', 'astro.config.mjs'] },
  'app-sdk': { name: '@aura/app-sdk', roots: ['src'] },
  'aura-cli': { name: '@aura/cli', roots: ['src'] },
  'kv-store': { name: '@aura/kv-store', roots: ['src'] },
};
const EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.astro'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', 'test', '__tests__']);

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (EXTS.some((x) => e.name.endsWith(x)) && !/\.d\.m?ts$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(join(ROOT, 'packages'), p).split(sep).join('/');

const files = new Map(); // rel -> {pkg, path, module, layer}
for (const [pkg, cfg] of Object.entries(PACKAGES)) {
  const base = join(ROOT, 'packages', pkg);
  const list = [...cfg.roots.flatMap((r) => walk(join(base, r))), ...(cfg.files ?? []).map((f) => join(base, f)).filter(existsSync)];
  for (const p of list) files.set(rel(p), { pkg, path: p, rel: rel(p), module: moduleOf(rel(p)) });
}

function moduleOf(r) {
  const parts = r.split('/');
  const [pkg] = parts;
  if (pkg === 'core') return parts.length > 3 ? `core/${parts[2]}` : `core/${parts[2].replace(/\.[^.]+$/, '')}`;
  if (pkg === 'shell') {
    if (parts[1] !== 'src') return 'shell/server';
    const top = parts[2];
    if (top === 'pages') return parts[3] === 'api' ? 'shell/api' : 'shell/ui-pages';
    if (top === 'middleware.ts') return 'shell/middleware';
    if (top === 'lib') return parts.length > 4 ? `shell/lib/${parts[3]}` : 'shell/lib';
    if (['components', 'layouts', 'stores', 'styles'].includes(top)) return `shell/ui-${top}`;
    return `shell/${top.replace(/\.[^.]+$/, '')}`;
  }
  if (pkg === 'aura-cli') return parts.length > 3 ? `aura-cli/${parts[2]}` : 'aura-cli';
  if (pkg === 'app-sdk') return parts.length > 3 ? `app-sdk/${parts[2]}` : 'app-sdk';
  return pkg;
}

// ── import parsing ──────────────────────────────────────────────────────────

/** Blank out comments (keeping strings and line numbers) so commented-out imports never count. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let prev = '';
  const tmplDepth = [];
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? n : end + 2; out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; prev = 'x'; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; else if (src[j] === '$' && src[j + 1] === '{') { tmplDepth.push(0); break; } j++; }
      if (src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; prev = 'x'; continue; }
      out += src.slice(i, j + 2); i = j + 2; prev = '{'; continue;
    }
    if (c === '{' && tmplDepth.length) tmplDepth[tmplDepth.length - 1]++;
    if (c === '}' && tmplDepth.length) {
      if (tmplDepth[tmplDepth.length - 1] === 0) {
        tmplDepth.pop();
        let j = i + 1;
        while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; else if (src[j] === '$' && src[j + 1] === '{') { tmplDepth.push(0); break; } j++; }
        if (src[j] === '`') { out += src.slice(i, j + 1); i = j + 1; prev = 'x'; continue; }
        out += src.slice(i, j + 2); i = j + 2; prev = '{'; continue;
      }
      tmplDepth[tmplDepth.length - 1]--;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      // regex literal
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      if (src[j] === '/') { out += src.slice(i, j + 1); i = j + 1; prev = 'x'; continue; }
    }
    if (!/\s/.test(c)) prev = /[\w$)\]]/.test(c) ? 'x' : c;
    out += c; i++;
  }
  return out;
}

function astroCode(src) {
  const parts = [];
  const fm = src.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  let offset = 0;
  if (fm) { parts.push(fm[1]); offset = fm[0].length; }
  // keep line numbers: blank everything that is not code
  let code = src.replace(/[^\n]/g, ' ');
  const put = (start, text) => { code = code.slice(0, start) + text + code.slice(start + text.length); };
  if (fm) put(src.indexOf(fm[1]), fm[1]);
  for (const m of src.slice(offset).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) put(offset + m.index + m[0].indexOf(m[1]), m[1]);
  return code;
}

const IMPORT_RES = [
  // import x from 'y' / import {a} from 'y' / import type ... / export ... from 'y'
  /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([\w$*{}\s,]*?)\s*from\s*(['"])([^'"\n]+)\4/g,
  /(?:^|[;\n}])\s*import\s*(['"])([^'"\n]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
];

function parseImports(code) {
  const out = [];
  const lineAt = (idx) => code.slice(0, idx).split('\n').length;
  for (const m of code.matchAll(IMPORT_RES[0])) {
    const clause = m[3] ?? '';
    const braces = clause.match(/\{([^}]*)\}/);
    const allTypeNamed = braces && !clause.replace(/\{[^}]*\}/, '').replace(/[\s,]/g, '') && braces[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '));
    out.push({ spec: m[5], type: Boolean(m[2]) || Boolean(allTypeNamed), kind: m[1], line: lineAt(m.index + m[0].indexOf(m[1])) });
  }
  for (const m of code.matchAll(IMPORT_RES[1])) out.push({ spec: m[2], type: false, kind: 'side-effect', line: lineAt(m.index + m[0].indexOf('import')) });
  for (const re of IMPORT_RES.slice(2)) for (const m of code.matchAll(re)) out.push({ spec: m[2], type: false, kind: 'dynamic', line: lineAt(m.index) });
  return out;
}

// ── resolution ──────────────────────────────────────────────────────────────

const pkgJson = {};
for (const pkg of [...Object.keys(PACKAGES), 'ui']) {
  const p = join(ROOT, 'packages', pkg, 'package.json');
  if (existsSync(p)) pkgJson[JSON.parse(readFileSync(p, 'utf8')).name] = { dir: pkg, json: JSON.parse(readFileSync(p, 'utf8')) };
}

function tryFile(base) {
  const cands = [base, ...EXTS.map((x) => base + x), ...EXTS.map((x) => join(base, 'index' + x))];
  if (/\.(m?js)$/.test(base)) { const s = base.replace(/\.(m?js)$/, ''); cands.unshift(s + '.ts', s + '.tsx', s + '.mts'); }
  for (const c of cands) if (files.has(rel(c))) return rel(c);
  for (const c of cands) if (existsSync(c) && statSync(c).isFile()) return rel(c);
  return null;
}

/** dist/x.js of a workspace package → its src/x.ts, when the source exists. */
function distToSrc(pkgDir, target) {
  const t = target.replace(/^\.\//, '');
  const src = t.replace(/^dist\//, 'src/').replace(/\.d\.ts$/, '.ts');
  return tryFile(join(ROOT, 'packages', pkgDir, src));
}

function resolveSpec(fromRel, spec) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const abs = spec.startsWith('/') ? spec : resolve(dirname(join(ROOT, 'packages', fromRel)), spec);
    const r = tryFile(abs);
    const target = r ?? rel(abs);
    const inPkgs = !target.startsWith('..');
    return { kind: inPkgs ? 'file' : 'outside', target, relative: true };
  }
  const m = spec.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  const name = m[1], sub = m[2] ? '.' + m[2] : '.';
  const ws = pkgJson[name];
  if (!ws) return { kind: 'external', target: name, spec };
  const exp = ws.json.exports;
  let declared = false, target = null;
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const e = exp[sub];
    if (e) { declared = true; const imp = typeof e === 'string' ? e : (e.import ?? e.default ?? e.types); target = imp ? distToSrc(ws.dir, imp) : null; }
  } else if (sub === '.') { declared = true; target = distToSrc(ws.dir, ws.json.main ?? 'dist/index.js'); }
  if (!declared && sub !== '.') target = tryFile(join(ROOT, 'packages', ws.dir, sub.replace(/^\.\/dist\//, 'src/').replace(/^\.\//, '')));
  return { kind: 'workspace', pkg: ws.dir, name, sub, declared, target, spec };
}

// ── build the graph ─────────────────────────────────────────────────────────

const edges = []; // {from, to?, ext?, spec, type, line, res}
for (const f of files.values()) {
  const raw = readFileSync(f.path, 'utf8');
  const code = stripComments(f.path.endsWith('.astro') ? astroCode(raw) : raw);
  f.lines = raw.split('\n').length;
  for (const im of parseImports(code)) {
    const res = resolveSpec(f.rel, im.spec);
    edges.push({ from: f.rel, to: res.kind === 'file' || (res.kind === 'workspace' && res.target) ? res.target : null, ext: res.kind === 'external' ? res.target : null, spec: im.spec, type: im.type, kind: im.kind, line: im.line, res });
  }
}

// shell layers: server = reachable from server entries, webshell = UI dirs and desktop pages
const isWebshellFile = (r) => /^shell\/src\/(components|layouts|stores|styles|desktop-pages)\//.test(r) || (/^shell\/src\/pages\//.test(r) && !/^shell\/src\/pages\/api\//.test(r)) || /\.(astro|tsx)$/.test(r) && r.startsWith('shell/');
const isServerEntry = (r) => /^shell\/(src\/pages\/api\/|src\/middleware\.ts$|server\/|server\.mjs$|astro\.config\.mjs$)/.test(r);
const out = new Map();
for (const e of edges) if (e.to && files.has(e.to)) { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e); }
function reach(starts, stop) {
  const seen = new Set(starts), stack = [...starts];
  while (stack.length) { const f = stack.pop(); for (const e of out.get(f) ?? []) if (e.to.startsWith('shell/') && !seen.has(e.to) && !stop(e.to)) { seen.add(e.to); stack.push(e.to); } }
  return seen;
}
const shellFiles = [...files.keys()].filter((r) => r.startsWith('shell/'));
const serverSet = reach(shellFiles.filter(isServerEntry), isWebshellFile);
const webSet = reach(shellFiles.filter(isWebshellFile), () => false);
for (const r of shellFiles) {
  const f = files.get(r);
  f.layer = isWebshellFile(r) ? 'webshell' : serverSet.has(r) && webSet.has(r) ? 'shared' : serverSet.has(r) ? 'server' : webSet.has(r) ? 'webshell' : 'unreached';
}

// ── rules ───────────────────────────────────────────────────────────────────

const violations = new Map(); // key -> {rule, from, line, detail}
const add = (rule, key, v) => { const k = `${rule}: ${key}`; if (!violations.has(k)) violations.set(k, { rule, ...v }); };

function sccs(nodes, adj) {
  let idx = 0; const index = new Map(), low = new Map(), on = new Set(), st = [], res = [];
  const strong = (v) => {
    index.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); res.push(c); }
  };
  for (const v of nodes) if (!index.has(v)) strong(v);
  return res;
}

const coreRuntime = edges.filter((e) => !e.type && e.to && files.has(e.to) && e.from.startsWith('core/') && e.to.startsWith('core/') && e.from !== e.to);
const fileAdj = new Map();
for (const e of coreRuntime) { if (!fileAdj.has(e.from)) fileAdj.set(e.from, new Set()); fileAdj.get(e.from).add(e.to); }
const coreFiles = [...files.keys()].filter((r) => r.startsWith('core/'));
const fileSccs = sccs(coreFiles, fileAdj).filter((c) => c.length > 1);
const sccOf = new Map(); fileSccs.forEach((c, i) => c.forEach((f) => sccOf.set(f, i)));
for (const e of coreRuntime) if (sccOf.has(e.from) && sccOf.get(e.from) === sccOf.get(e.to)) add('core-cycle', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: e.spec });

// A module cycle counts only where it exists through real import chains: an edge
// A/f -> B/g is entangled when g (transitively, runtime imports) reaches back
// into module A. Aggregation alone (A/x -> B/types.ts and B/y -> A/z with no
// chain) is not a cycle: leaf contract files keep modules separable.
const reachMods = new Map();
function modulesReachable(f) {
  if (reachMods.has(f)) return reachMods.get(f);
  const seen = new Set([f]), stack = [f], mods = new Set();
  while (stack.length) { const x = stack.pop(); mods.add(files.get(x).module); for (const y of fileAdj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
  reachMods.set(f, mods);
  return mods;
}
const modCycleEdges = new Map();
// The composition root (Phase 6 K) imports every module by design; nothing but the barrel imports it
// (checked below as foundation-leaf), so its edges cannot close a real chain.
const COMPOSITION_ROOT = new Set(['core/src/system/bootstrap.ts', 'core/src/system/compose.ts']);
for (const e of coreRuntime) {
  if (COMPOSITION_ROOT.has(e.from)) continue;
  const a = files.get(e.from).module, b = files.get(e.to)?.module;
  if (!b || a === b) continue;
  if (modulesReachable(e.to).has(a)) { const k = `${a} -> ${b}`; if (!modCycleEdges.has(k)) modCycleEdges.set(k, e); }
}
const modAdj = new Map();
for (const k of modCycleEdges.keys()) { const [a, b] = k.split(' -> '); if (!modAdj.has(a)) modAdj.set(a, new Set()); modAdj.get(a).add(b); }
const coreModules = [...new Set(coreFiles.map((r) => files.get(r).module))];
const modSccs = sccs(coreModules, modAdj).filter((c) => c.length > 1);
for (const [k, e] of modCycleEdges) add('core-module-cycle', k, { from: e.from, line: e.line, detail: `e.g. ${e.from}:${e.line} imports ${e.spec}` });

for (const e of edges) {
  const from = files.get(e.from);
  const where = `${e.from} -> ${e.to ?? e.ext ?? e.spec}`;
  if (from.pkg === 'core') {
    if (CORE_FORBIDDEN.test(e.spec) || (e.res.kind === 'file' && !e.to.startsWith('core/')) || e.res.kind === 'outside') add('core-forbidden', where, { from: e.from, line: e.line, detail: e.spec });
  }
  // cross-package internals: relative paths into another package, or undeclared subpaths
  if (e.res.kind === 'file' && e.to.split('/')[0] !== from.pkg) add('package-internals', where, { from: e.from, line: e.line, detail: e.spec });
  if (e.res.kind === 'workspace' && !e.res.declared) add('package-internals', where, { from: e.from, line: e.line, detail: `${e.spec} is not in ${e.res.name} exports` });
  if (from.pkg === 'app-sdk' && e.res.kind === 'workspace' && e.res.pkg === 'core' && !e.type && e.res.sub === '.') add('sdk-core', `${e.from} -> @aura/core`, { from: e.from, line: e.line, detail: 'runtime import of the kernel root' });
  if (from.pkg === 'shell' && (from.layer === 'server' || from.layer === 'shared') && !e.type) {
    const toWeb = e.to && files.get(e.to)?.layer === 'webshell' && isWebshellFile(e.to);
    // D76 (Phase 6 W): the build config composes the Web Shell for `desktop` only, by one dynamic import.
    const composes = e.from === 'shell/astro.config.mjs' && e.kind === 'dynamic' && e.to === 'shell/src/desktop-pages/integration.mjs';
    if (!composes && (toWeb || (e.ext && UI_PACKAGES.test(e.spec)))) add('server-webshell', where, { from: e.from, line: e.line, detail: e.spec });
  }
}

// ── docs alignment and sector rules (D97 addendum) ─────────────────────────

const KERNEL_SECTORS = new Set(['foundation', 'execution', 'identity-security', 'resource', 'communication', 'system-management']);
// The composition root: its order half (bootstrap.ts) and its construction half (compose.ts), Phase 6 K.
const COMPOSITION_EXEMPT = new Set(['core/src/index.ts', 'core/src/system/bootstrap.ts', 'core/src/system/compose.ts']);
function listAgentsDocs() {
  const git = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const all = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : [];
  return all.filter((f) => /(^|\/)AGENTS\.md$/.test(f) && !f.startsWith('os/home-seed/') && existsSync(join(ROOT, f)));
}
for (const doc of listAgentsDocs()) {
  const sib = join(ROOT, dirname(doc), 'CLAUDE.md');
  if (!existsSync(sib)) add('agents-docs', `${doc} has no sibling CLAUDE.md`, { from: doc, line: 1, detail: 'add CLAUDE.md containing only @AGENTS.md' });
  else if (readFileSync(sib, 'utf8').trim() !== '@AGENTS.md') add('agents-docs', `${dirname(doc) === '.' ? '' : dirname(doc) + '/'}CLAUDE.md is not @AGENTS.md`, { from: doc, line: 1, detail: 'CLAUDE.md must contain only @AGENTS.md' });
}
const CHAIN_BUDGET = 28 * 1024;
const docs = listAgentsDocs();
// The app template is seeded into each new app, where it is that app's root file; its chain here is not a repo chain.
for (const doc of docs.filter((d) => !d.startsWith('packages/aura-cli/src/templates/'))) {
  let bytes = 0;
  const parts = dirname(doc) === '.' ? [] : dirname(doc).split('/');
  for (let i = 0; i <= parts.length; i++) {
    const f = join(ROOT, ...parts.slice(0, i), 'AGENTS.md');
    if (existsSync(f)) bytes += statSync(f).size;
  }
  if (bytes > CHAIN_BUDGET) add('agents-docs', `${doc} chain is ${bytes} bytes (budget ${CHAIN_BUDGET})`, { from: doc, line: 1, detail: 'Codex drops the most specific files first: shorten a level' });
}
const sectorOf = new Map();
const kernelDoc = join(ROOT, 'packages/core/AGENTS.md');
if (existsSync(kernelDoc)) {
  const block = readFileSync(kernelDoc, 'utf8').match(/```text dep-check:sectors\n([\s\S]*?)```/);
  if (!block) add('agents-docs', 'packages/core/AGENTS.md has no dep-check:sectors block', { from: 'core/AGENTS.md', line: 1, detail: '' });
  else {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*([a-z-]+):\s*(.*)$/); if (!m) continue;
      for (const mod of m[2].split(/\s+/).filter(Boolean)) {
        if (sectorOf.has(`core/${mod}`)) add('agents-docs', `core/${mod} is in two sectors`, { from: 'core/AGENTS.md', line: 1, detail: '' });
        sectorOf.set(`core/${mod}`, m[1]);
      }
    }
    const actual = new Set(coreFiles.map((r) => files.get(r).module));
    for (const m of actual) if (!sectorOf.has(m)) add('agents-docs', `${m} has no sector in packages/core/AGENTS.md`, { from: 'core/AGENTS.md', line: 1, detail: 'add it to the dep-check:sectors block' });
    for (const m of sectorOf.keys()) if (!actual.has(m)) add('agents-docs', `packages/core/AGENTS.md names ${m}, which does not exist`, { from: 'core/AGENTS.md', line: 1, detail: 'remove or rename it in the dep-check:sectors block' });
    for (const e of coreRuntime) {
      const a = files.get(e.from).module, b = files.get(e.to).module;
      const sa = sectorOf.get(a), sb = sectorOf.get(b);
      if (!sa || !sb || a === b) continue;
      if (sa === 'foundation' && sb !== 'foundation' && !COMPOSITION_EXEMPT.has(e.from)) add('foundation-leaf', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: `${a} (foundation) imports ${b} (${sb})` });
      if (KERNEL_SECTORS.has(sa) && sb === 'presentation-contracts' && !COMPOSITION_EXEMPT.has(e.from)) add('kernel-presentation', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: `${a} (${sa}) imports ${b}` });
    }
  }
}

// The composition root is the top of the graph: only the barrel and the root itself import it.
for (const e of coreRuntime) {
  if (COMPOSITION_ROOT.has(e.to) && !COMPOSITION_EXEMPT.has(e.from)) add('foundation-leaf', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: 'only the barrel imports the composition root' });
}

// ── contract-leaf (D97 §4.2, 5b K): declared contract files stay leaves ───────
// Type-only imports are free; a runtime import inside the same module, or of another declared leaf, is allowed.
const CONTRACT_LEAVES = new Set(['core/src/app-manager/maintenance.ts', 'core/src/runtimes/ari.ts', 'core/src/runtimes/types.ts', 'core/src/runtimes/requirements.ts', 'core/src/runtimes/workloadEnv.ts', 'core/src/system/systemApps.ts', 'core/src/contract/types.ts']);
for (const e of coreRuntime) {
  if (!CONTRACT_LEAVES.has(e.from) || CONTRACT_LEAVES.has(e.to)) continue;
  const a = files.get(e.from).module, b = files.get(e.to).module;
  if (a !== b) add('contract-leaf', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: `${e.from} is a contract leaf; it imports ${b} at runtime` });
}

// ── runtime-no-bus (D93 G1; 5b-2 D, the import half of the ARI boundary) ─────────
const RUNTIME_FILE = (r) => /^core\/src\/runtimes\//.test(r)
  || /^core\/src\/app-manager\/(ContainerRunner|ProotRunner|SessionBroker|DockerApi)\.ts$/.test(r) || /^core\/src\/app-manager\/spawn\//.test(r);
for (const e of coreRuntime) {
  if (RUNTIME_FILE(e.from) && e.to === 'core/src/ipc/OsEventBus.ts') {
    add('runtime-no-bus', `${e.from} -> ${e.to}`, { from: e.from, line: e.line, detail: `${e.from} is runtime provider code; it imports the event bus` });
  }
}

// ── agent-agnostic (owner decision, philosophy audit 2026-11-26) ───────────────
// Code only (comments blanked by stripComments; strings count, they are behaviour). One entry per file and term.
const AGENT_TERMS = /(?<![A-Za-z0-9_])(claude-code|claude|codex|anthropic|openai|CLAUDE_CONFIG_DIR|CODEX_HOME|config\.toml)(?![A-Za-z0-9_])/gi;
const AGENT_SCOPE = (r) => /^core\/src\//.test(r) || /^shell\/(src\/lib|server)\//.test(r);
const AGENT_ALLOW = (r) => /(^|\/)adapters\//.test(r);
for (const f of files.values()) {
  if (!AGENT_SCOPE(f.rel) || AGENT_ALLOW(f.rel)) continue;
  const code = stripComments(readFileSync(f.path, 'utf8')).replace(/CLAUDE\.md/g, '');
  const seen = new Set();
  for (const m of code.matchAll(AGENT_TERMS)) {
    const term = m[1].toLowerCase();
    if (seen.has(term)) continue;
    seen.add(term);
    add('agent-agnostic', `${f.rel} -> ${term}`, { from: f.rel, line: code.slice(0, m.index).split('\n').length, detail: `product name '${m[1]}' in kernel or shell infrastructure code` });
  }
}

// ── baseline ────────────────────────────────────────────────────────────────

let baseline = { about: '', rules: RULES, entries: {} };
if (existsSync(BASELINE)) {
  try { baseline = JSON.parse(readFileSync(BASELINE, 'utf8')); } catch (err) { console.error(`dep-check: ${BASELINE}: ${err.message}`); process.exit(2); }
}
const known = baseline.entries ?? {};
const fresh = flag('update') ? [] : [...violations.keys()].filter((k) => !(k in known)).sort();
const paid = flag('update') ? [] : Object.keys(known).filter((k) => !violations.has(k)).sort();
const debt = [...violations.keys()].filter((k) => flag('update') || k in known);

if (flag('update')) {
  const entries = {};
  for (const k of [...violations.keys()].sort()) entries[k] = known[k] ?? 'baseline (D97 review 2026-11-26): existing coupling, tracked; remove when fixed';
  const sha = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  writeFileSync(BASELINE, JSON.stringify({
    about: 'Known architecture debt (tools/dep-check.mjs, D97). The check fails only on violations not listed here; the summary prints the count, which must shrink. Remove an entry when its violation is gone (the check reports it). Never add an entry to make new coupling pass without a review; see modular-kernel-review.md.',
    generatedAt: sha || null,
    rules: RULES,
    entries,
  }, null, 2) + '\n');
}

// ── report ──────────────────────────────────────────────────────────────────

function summary() {
  const mods = new Map();
  const touch = (m) => { if (!mods.has(m)) mods.set(m, { files: 0, lines: 0, out: new Set(), in: new Set(), typeOut: new Set(), ext: new Set() }); return mods.get(m); };
  for (const f of files.values()) { const m = touch(f.module); m.files++; m.lines += f.lines; }
  for (const e of edges) {
    const a = files.get(e.from).module;
    if (e.ext) { touch(a).ext.add(e.ext); continue; }
    const b = e.to && files.get(e.to)?.module; if (!b || a === b) continue;
    if (e.type) { touch(a).typeOut.add(b); continue; }
    touch(a).out.add(b); touch(b).in.add(a);
  }
  return mods;
}

const mods = summary();
if (opt('graph')) {
  writeFileSync(resolve(opt('graph')), JSON.stringify({
    files: [...files.values()].map(({ rel: r, pkg, module, layer, lines }) => ({ file: r, pkg, module, layer, lines })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, ext: e.ext, spec: e.spec, type: e.type, line: e.line, declared: e.res.declared })),
    modules: Object.fromEntries([...mods].map(([k, v]) => [k, { files: v.files, lines: v.lines, out: [...v.out].sort(), in: [...v.in].sort(), typeOnlyOut: [...v.typeOut].filter((x) => !v.out.has(x)).sort(), external: [...v.ext].sort() }])),
    fileCycles: fileSccs.map((c) => c.sort()),
    moduleCycles: modSccs.map((c) => c.sort()),
  }, null, 2));
}

const counts = Object.fromEntries(Object.keys(RULES).map((r) => [r, 0]));
for (const v of violations.values()) counts[v.rule]++;
if (flag('json')) {
  console.log(JSON.stringify({ exit: fresh.length ? 1 : 0, counts, new: fresh.map((k) => ({ key: k, ...violations.get(k) })), baselined: debt.length, fixed: paid }, null, 2));
} else {
  if (flag('report')) {
    console.log(`files ${files.size}, import edges ${edges.length} (${edges.filter((e) => e.type).length} type-only), modules ${mods.size}`);
    console.log(`core: ${fileSccs.length} file cycle(s) (largest ${Math.max(0, ...fileSccs.map((c) => c.length))} files); ${modCycleEdges.size} entangled module edge(s) among ${new Set([...modCycleEdges.keys()].flatMap((k) => k.split(' -> '))).size} modules`);
    const layers = {}; for (const f of files.values()) if (f.layer) layers[f.layer] = (layers[f.layer] ?? 0) + 1;
    console.log(`shell layers: ${Object.entries(layers).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log('\nmodule                          files  lines  fan-out  fan-in');
    for (const [k, v] of [...mods].sort((a, b) => (b[1].out.size + b[1].in.size) - (a[1].out.size + a[1].in.size))) console.log(`${k.padEnd(30)} ${String(v.files).padStart(6)} ${String(v.lines).padStart(6)} ${String(v.out.size).padStart(8)} ${String(v.in.size).padStart(7)}`);
    console.log('');
  }
  const verdict = fresh.length ? 'FAIL' : 'PASS';
  console.log(`DEP-CHECK ${verdict} ${fresh.length} new violation${fresh.length === 1 ? '' : 's'} (${Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(', ')}) · debt ${debt.length} baselined · ${paid.length} fixed${flag('update') ? ' · baseline rewritten' : ''}`);
  for (const k of fresh) { const v = violations.get(k); console.log(`  NEW ${k}  (${v.from}:${v.line}; ${v.detail})`); }
  for (const k of paid) console.log(`  FIXED (remove from tools/dep-baseline.json, or run --update) ${k}`);
}
process.exit(fresh.length && !flag('update') ? 1 : 0);
