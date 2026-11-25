#!/usr/bin/env node
// The security gate: cheap static checks every branch runs before a merge.
//
//   node tools/security-check.mjs [--json] [--only=secrets,deps,patterns,routes,headers]
//        [--skip=<checks>] [--offline] [--extra=<dir>]... [--no-extra] [--root=<dir>]
//
// Prints one summary line, then one line per finding (and per warning).
// Exit: 0 clean, 1 findings, 2 tool error (a check could not run, or the
// allowlist is invalid). Reviewed exceptions go in tools/security-allowlist.yaml,
// each with a reason; the values the header check expects are in
// tools/security-expected.json. Secrets are never printed, only a fingerprint.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS = ['secrets', 'deps', 'patterns', 'routes', 'headers'];
const EXIT = { CLEAN: 0, FINDINGS: 1, TOOL: 2 };

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, offline: false, noExtra: false, extra: [], only: null, skip: [], root: null };
  for (const a of argv) {
    if (a === '--') continue;
    const [k, v] = a.replace(/^--/, '').split(/=(.*)/s);
    if (k === 'json') o.json = true;
    else if (k === 'offline') o.offline = true;
    else if (k === 'no-extra') o.noExtra = true;
    else if (k === 'extra' && v) o.extra.push(v);
    else if (k === 'only' && v) o.only = v.split(',');
    else if (k === 'skip' && v) o.skip = v.split(',');
    else if (k === 'root' && v) o.root = resolve(v);
    else if (k === 'help' || k === 'h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const c of [...(o.only ?? []), ...o.skip]) if (!CHECKS.includes(c)) throw new Error(`unknown check: ${c} (checks: ${CHECKS.join(', ')})`);
  return o;
}

// ── files ───────────────────────────────────────────────────────────────────

const WALK_SKIP = new Set(['node_modules', '.git', 'dist', '.astro', '.next', '.turbo', '.cache', 'coverage']);

/** Tracked files when `root` is a git checkout, else every file outside build output. */
function listFiles(root) {
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean).filter((f) => existsSync(join(root, f)));
  return walk(root).map((f) => relative(root, f).split(sep).join('/'));
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const MAX_TEXT = 4 * 1024 * 1024;
function readText(full) {
  try {
    if (statSync(full).size > MAX_TEXT) return null;
    const buf = readFileSync(full);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString('utf8');
  } catch { return null; }
}

const isTestPath = (f) => /(^|\/)(test|tests|__tests__|e2e|fixtures)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
const CODE_EXT = /\.(?:[cm]?[jt]sx?|astro|svelte|vue|html)$/;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Glob with `*` (no slash) and `**` (anything). */
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, globs) => (globs ?? []).some((g) => globRe(g).test(file));

// ── source text: comments blanked, strings kept, offsets unchanged ──────────

/**
 * Blanks JS comments (and HTML comments in .astro/.html) to spaces, keeping
 * every newline so line numbers hold. Strings and templates are kept as they
 * are. A heuristic, not a parser: a regex literal holding a quote can throw it
 * off until the end of that line.
 */
function stripComments(text, html = false) {
  const out = text.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const stack = []; // template nesting: '`' or '{'
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push('{'); i += 2; continue; }
      i++; continue;
    }
    if (html && text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end < 0 ? text.length : end + 3;
      blank(i, stop); i = stop; continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      // `://` in markup or a URL outside a string is not a comment.
      if (i > 0 && text[i - 1] === ':') { i += 2; continue; }
      blank(i, stop); i = stop; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1; continue;
    }
    if (c === '`') { stack.push('`'); i++; continue; }
    if (top === '{') {
      if (c === '{') stack.push('{');
      else if (c === '}') stack.pop();
    }
    i++;
  }
  return out.join('');
}

/** From `start`, the text up to the bracket that closes depth 0 (exclusive), or the statement end. */
function takeExpression(text, start, { closer = null } = {}) {
  let depth = 0;
  const stack = [];
  let i = start;
  while (i < text.length) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') { stack.push('${'); depth++; i += 2; continue; }
      i++; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1; continue;
    }
    if (c === '`') { stack.push('`'); i++; continue; }
    if ('([{'.includes(c)) { depth++; stack.push(c); i++; continue; }
    if (')]}'.includes(c)) {
      if (depth === 0) return text.slice(start, i);
      depth--; stack.pop(); i++; continue;
    }
    if (depth === 0 && !closer) {
      if (c === ';') return text.slice(start, i);
      if (c === '\n') {
        const before = text.slice(start, i).trimEnd();
        const after = text.slice(i + 1).trimStart();
        const continues = /[+\-*?:,(=|&]$/.test(before) || /^[.+?:|&)\]]/.test(after) || before === '';
        if (!continues) return text.slice(start, i);
      }
    }
    i++;
  }
  return text.slice(start);
}

/**
 * Splits at a top-level separator, outside strings and brackets. `?` means the
 * ternary only (not `??` or `?.`); `|` and `&` mean `||` and `&&`.
 */
function splitTop(expr, sep) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) {
        if (expr[j] === '\\') j++;
        else if (c === '`' && expr[j] === '$' && expr[j + 1] === '{') {
          let d = 1; j += 2;
          while (j < expr.length && d > 0) { if (expr[j] === '{') d++; else if (expr[j] === '}') d--; if (d > 0) j++; }
        }
        j++;
      }
      i = j; continue;
    }
    if ('([{'.includes(c)) { depth++; continue; }
    if (')]}'.includes(c)) { depth--; continue; }
    if (depth !== 0 || !expr.startsWith(sep, i)) continue;
    if (sep === '?' && (expr[i + 1] === '?' || expr[i + 1] === '.' || expr[i - 1] === '?')) continue;
    if (sep === '+' && (expr[i + 1] === '+' || expr[i - 1] === '+' || expr[i + 1] === '=')) continue;
    parts.push(expr.slice(last, i)); last = i + sep.length; i += sep.length - 1;
  }
  parts.push(expr.slice(last));
  return parts;
}

// ── HTML sinks: is the input constant or escaped? ───────────────────────────

const ESCAPER = /^(?:esc\w*|escape\w*|\w*[eE]scape\w*|encodeURIComponent|encodeURI|Number|String\(Number|parseInt|Math\.\w+)$/;
const SAFE_JSON = /\.replace\(\s*\/<\/g\s*,/;

/** Whether an expression assigned to innerHTML / set:html can only carry constant or escaped markup. */
function safeHtmlExpr(raw) {
  let e = raw.trim();
  if (!e) return true;
  while (e.startsWith('(') && takeExpression(e, 1, { closer: ')' }).length === e.length - 2) e = e.slice(1, -1).trim();
  if (/^(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")$/s.test(e)) return true;
  if (/^-?\d[\d.]*$/.test(e) || /^(?:true|false|null|undefined)$/.test(e)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(e)) return true;                       // a module constant
  if (/\.length$/.test(e)) return true;
  if (/^new Date\([^()]*\)\.\w+\(\)$/.test(e)) return true;               // a formatted date
  if (/^`[\s\S]*`$/.test(e) && splitTop(e, '+').length === 1) {
    const holes = [];
    for (let i = 1; i < e.length - 1; i++) {
      if (e[i] === '\\') { i++; continue; }
      if (e[i] === '$' && e[i + 1] === '{') {
        const inner = takeExpression(e, i + 2, { closer: '}' });
        holes.push(inner); i += inner.length + 2;
      }
    }
    return holes.every(safeHtmlExpr);
  }
  // Lowest precedence first: a ternary's branches (not its condition), then || ??, &&, +.
  const q = splitTop(e, '?');
  if (q.length > 1) {
    const values = splitTop(q.slice(1).join('?'), ':').map((p) => { const t = splitTop(p, '?'); return t[t.length - 1]; });
    return values.every(safeHtmlExpr);
  }
  for (const op of ['||', '??']) {
    const parts = splitTop(e, op);
    if (parts.length > 1) return parts.every(safeHtmlExpr);
  }
  const and = splitTop(e, '&&');
  if (and.length > 1) return safeHtmlExpr(and[and.length - 1]);
  const plus = splitTop(e, '+');
  if (plus.length > 1) return plus.every(safeHtmlExpr);
  const open = e.indexOf('(');
  const callee = open > 0 ? e.slice(0, open).trim() : '';
  if (/^[\w.$]+$/.test(callee) && open + 1 + takeExpression(e, open + 1, { closer: ')' }).length === e.length - 1) {
    if (ESCAPER.test(callee)) return true;
    const inner = e.slice(open + 1, -1);
    if (callee !== 'JSON.stringify') {
      const args = inner.trim() ? splitTop(inner, ',') : [];
      if (args.every(safeHtmlExpr)) return true;   // a builder fed only constant or escaped input
    }
  }
  if (SAFE_JSON.test(e)) return true;
  return false;
}

// ── allowlist (a small YAML subset: a list of flat maps) ────────────────────

function parseAllowlist(text, file) {
  const entries = [];
  let cur = null;
  const scalar = (v, n) => {
    v = v.trim();
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch { throw new Error(`${file}:${n}: bad quoted value`); } }
    if (v.startsWith('\'')) { if (!v.endsWith('\'') || v.length < 2) throw new Error(`${file}:${n}: bad quoted value`); return v.slice(1, -1).replace(/''/g, '\''); }
    return v.replace(/\s+#.*$/, '');
  };
  text.split('\n').forEach((line, idx) => {
    const n = idx + 1;
    if (/^\s*(#.*)?$/.test(line) || /^\s*\[\]\s*$/.test(line)) return;
    const m = line.match(/^(\s*)(- )?\s*([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) throw new Error(`${file}:${n}: expected "- key: value" or "  key: value"`);
    if (m[2]) { cur = { line: n }; entries.push(cur); }
    else if (!cur || m[1].length === 0) throw new Error(`${file}:${n}: a key outside a "- " entry`);
    cur[m[3]] = scalar(m[4], n);
  });
  const KEYS = new Set(['line', 'check', 'file', 'match', 'id', 'reason', 'expires']);
  for (const e of entries) {
    const where = `${file}:${e.line}`;
    for (const k of Object.keys(e)) if (!KEYS.has(k)) throw new Error(`${where}: unknown key "${k}"`);
    if (!e.check) throw new Error(`${where}: an entry needs "check"`);
    if (!e.reason || e.reason.trim().length < 15) throw new Error(`${where}: an entry needs a "reason" (a sentence, why this is safe)`);
    if (!e.file && !e.id && !e.match) throw new Error(`${where}: an entry needs "file", "id" or "match" to say what it covers`);
    if (e.expires && !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) throw new Error(`${where}: "expires" is YYYY-MM-DD`);
  }
  return entries;
}

function allowedBy(finding, entries) {
  return entries.find((e) =>
    (e.check === finding.check || (e.check.endsWith('/*') && finding.check.startsWith(e.check.slice(0, -1))))
    && (!e.file || globRe(e.file).test(finding.file ?? ''))
    && (!e.id || e.id === finding.id)
    && (!e.match || (finding.source ?? finding.message).includes(e.match)));
}

// ── 1. secrets ──────────────────────────────────────────────────────────────

const PEM_HEAD = new RegExp('-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?' + 'PRIVATE KEY(?: BLOCK)?)-----');
const TOKEN_PATTERNS = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g],
  ['github-token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?(?!ant-)[A-Za-z0-9_-]{32,}/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g],
];
const SECRET_NAME = '(?:secret|token|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|signing[_-]?key|client[_-]?secret|credential)';
const ASSIGN = new RegExp(`([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_]*)["']?\\s*[:=]\\s*["'\`]([^"'\`\\s]{16,})["'\`]`, 'gi');
const ENV_ASSIGN = new RegExp(`^[+\\- ]?\\s*(?:export\\s+|ENV\\s+|-\\s+)?([A-Z][A-Z0-9_]*${SECRET_NAME.toUpperCase()}[A-Z0-9_]*)\\s*[=:]\\s*["']?([^\\s"'#(),;]{8,})(?![(\\w])`, 'gm');
const URL_CRED = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@'"`<>]+):([^\s/@'"`<>]{6,})@/g;
const PLACEHOLDER = /\$\{|\$\(|^\$|<|>|\*{3}|x{4}|example|changeme|change-me|placeholder|dummy|your[_-]|redacted|secret$|password$|^pass$|token$|\.\.\.|^process\.env|^env\./i;

function entropy(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}
const classes = (s) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
const looksRandom = (v, minEntropy) =>
  !PLACEHOLDER.test(v) && entropy(v) >= minEntropy && classes(v) >= 2 && !/^[a-z]+(?:[._-][a-z]+)*$/i.test(v)
  && !/^[\w.-]+\/[\w./-]+$/.test(v) && !/^[/~]|^\.\.?\//.test(v) && !/^(?:[A-Z][A-Z0-9]*_)+[A-Z0-9]+$/.test(v)
  && !readable(v);
/** Words and numbers joined by - . _ (`lifecycle-test-token-1700000000`): a fixture name, not a key. */
const readable = (v) => { const seg = v.split(/[._-]/); return seg.length >= 2 && seg.every((x) => /^(?:[A-Za-z]+|\d+)$/.test(x)); };
/** Names that hold where a secret lives, or what it is called, not the secret. */
const NOT_A_SECRET_NAME = /(?:file|path|dir|url|uri|header|name|env|key_?id|keyid|type|kind|label|prefix|suffix|pattern|re|regex)$/i;

function scanSecrets(label, text, findings) {
  const add = (rule, index, value, what) => findings.push({
    check: `secrets/${rule}`, file: label, line: lineOf(text, index), id: sha(value),
    message: `${what} (value not shown, fingerprint ${sha(value)}, ${value.length} chars)`,
  });
  const pem = new RegExp(PEM_HEAD.source, 'g');
  for (const m of text.matchAll(pem)) {
    const body = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (/^\s*(?:[+\- ]\s*)?(?:[A-Za-z0-9+/=]{40,}|Proc-Type:)/.test(body)) add('private-key', m.index, body.slice(0, 200), `${m[1]} block`);
  }
  for (const [rule, re] of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) if (!PLACEHOLDER.test(m[0]) && entropy(m[0]) >= 3.2) add(rule, m.index, m[0], rule.replace(/-/g, ' '));
  }
  for (const m of text.matchAll(URL_CRED)) {
    if (looksRandom(m[2], 2.5) || (!PLACEHOLDER.test(m[2]) && m[2].length >= 12)) add('url-credentials', m.index, m[2], `credentials in a URL (user ${JSON.stringify(m[1].slice(0, 20))})`);
  }
  for (const m of text.matchAll(ASSIGN)) {
    if (!NOT_A_SECRET_NAME.test(m[1]) && looksRandom(m[2], 3.5)) add('assigned-secret', m.index, m[2], `high-entropy value assigned to ${m[1]}`);
  }
  for (const m of text.matchAll(ENV_ASSIGN)) {
    if (!NOT_A_SECRET_NAME.test(m[1]) && looksRandom(m[2], 3.0)) add('env-secret', m.index, m[2], `secret-looking value for ${m[1]}`);
  }
}

function checkSecrets(ctx) {
  const findings = [];
  const warnings = [];
  const seen = new Set();
  const scan = (label, full) => {
    const text = readText(full);
    if (text === null) return;
    const before = findings.length;
    scanSecrets(label, text, findings);
    // One finding per (file, line, value): overlapping rules say the same thing.
    for (const f of findings.splice(before)) {
      const k = `${f.file}:${f.line}:${f.id}`;
      if (!seen.has(k)) { seen.add(k); findings.push(f); }
    }
  };
  for (const f of ctx.files) {
    const base = f.split('/').pop();
    if (/^\.env(\..+)?$|\.env$/.test(base) && !/\.(example|sample|template|dist)$/.test(base)) {
      findings.push({ check: 'secrets/env-file', file: f, line: 1, id: f, message: 'a .env file is tracked: environment files hold secrets and belong outside git' });
    }
    scan(f, join(ctx.root, f));
  }
  for (const dir of ctx.extra) {
    if (!existsSync(dir)) { warnings.push(`secrets: extra path ${dir} does not exist, not scanned`); continue; }
    const files = statSync(dir).isDirectory() ? walk(dir) : [dir];
    for (const full of files) scan(full, full);
  }
  return { findings, warnings, scanned: ctx.files.length };
}

// ── 2. dependencies ─────────────────────────────────────────────────────────

function lockfileSanity(root) {
  const findings = [];
  const lock = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lock)) return { findings, missing: true };
  const text = readFileSync(lock, 'utf8');
  for (const m of text.matchAll(/^\s+resolution: \{(.*)\}\s*$/gm)) {
    const body = m[1];
    if (/\btarball:|\btype: git|\brepo:|\bdirectory:/.test(body) || !/\bintegrity: sha512-/.test(body)) {
      const line = lineOf(text, m.index);
      findings.push({ check: 'deps/lockfile', file: 'pnpm-lock.yaml', line, id: `pnpm-lock.yaml:${body}`, source: body,
        message: `a package resolved outside the registry or without a sha512 integrity hash: ${body.slice(0, 100)}` });
    }
  }
  return { findings };
}

function checkDeps(ctx) {
  const findings = [];
  const warnings = [];
  const sanity = lockfileSanity(ctx.root);
  if (sanity.missing) return { error: 'pnpm-lock.yaml not found' };
  findings.push(...sanity.findings);
  if (ctx.opts.offline) {
    warnings.push('deps: --offline, advisories not checked (lockfile sanity only)');
    return { findings, warnings };
  }
  const r = spawnSync('pnpm', ['audit', '--prod', '--json'], { cwd: ctx.root, encoding: 'utf8', timeout: 180_000, maxBuffer: 256 * 1024 * 1024 });
  let report = null;
  try { report = JSON.parse(r.stdout); } catch { /* below */ }
  if (!report?.advisories) {
    const why = r.error?.code === 'ENOENT' ? 'pnpm not found'
      : report?.error?.message ?? (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0].slice(0, 160);
    warnings.push(`deps: pnpm audit unavailable (${why}): advisories not checked, lockfile sanity only`);
    return { findings, warnings };
  }
  for (const a of Object.values(report.advisories)) {
    if (!['high', 'critical'].includes(a.severity)) continue;
    const versions = [...new Set(a.findings.map((f) => f.version))].join(',');
    const importers = new Set(a.findings.flatMap((f) => f.paths.map((p) => p.split('>')[0].replace(/__/g, '/'))));
    const id = a.github_advisory_id || String(a.id);
    findings.push({
      check: 'deps/advisory', file: 'pnpm-lock.yaml', id, source: `${a.module_name} ${id}`, severity: a.severity,
      message: `${a.severity} ${a.module_name}@${versions} ${id} (fix ${a.patched_versions}): ${a.title.slice(0, 90)} [${importers.size} importer${importers.size === 1 ? '' : 's'}]`,
    });
  }
  const meta = report.metadata?.vulnerabilities;
  if (meta) warnings.push(`deps: audit counts low ${meta.low ?? 0}, moderate ${meta.moderate ?? 0} (not gated); high ${meta.high ?? 0}, critical ${meta.critical ?? 0} (gated, by advisory)`);
  findings.sort((x, y) => (x.severity === y.severity ? x.message.localeCompare(y.message) : x.severity === 'critical' ? -1 : 1));
  return { findings, warnings };
}

// ── 3. forbidden patterns ───────────────────────────────────────────────────

/**
 * Each rule sees the comment-stripped text of the files in its scope and
 * returns `[index, detail]` pairs. Tests are out of scope for every rule.
 */
function patternRules(expected) {
  const trust = expected.trustHeaders ?? [];
  const setForms = (name) => [
    `\\[\\s*${name}\\s*\\]\\s*(?::|=(?!=))`,
    `\\.(?:set|append|setHeader)\\(\\s*${name}\\s*,`,
    `\\.push\\(\\s*${name}\\s*,`,
  ];
  return [
    {
      id: 'postmessage-star', scope: (f) => CODE_EXT.test(f),
      what: 'postMessage to any origin (\'*\'): name the target origin',
      find(text) {
        const hits = [];
        for (const m of text.matchAll(/\bpostMessage\s*\(/g)) {
          const args = splitTop(takeExpression(text, m.index + m[0].length, { closer: ')' }), ',');
          const target = args[1]?.trim() ?? '';
          if (/^(['"`])\*\1$/.test(target) || /targetOrigin\s*:\s*(['"`])\*\1/.test(target)) hits.push([m.index, `postMessage(…, ${target})`]);
        }
        return hits;
      },
    },
    {
      id: 'docker-spawn', scope: (f) => CODE_EXT.test(f) && matchesAny(f, expected.dockerScope) && !matchesAny(f, expected.dockerAllowed),
      what: 'app code runs docker directly: go through the shell API (core runners only)',
      find(text) {
        const hits = [];
        const re = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|execFileAsync|execAsync|execa)\s*\(\s*(['"`])docker\b/g;
        for (const m of text.matchAll(re)) hits.push([m.index, `${m[1]}('docker' …)`]);
        for (const m of text.matchAll(/socketPath\s*:\s*['"`][^'"`]*docker\.sock/g)) hits.push([m.index, 'docker socket']);
        return hits;
      },
    },
    {
      id: 'html-sink', scope: (f) => /\.(?:[cm]?[jt]sx?|astro)$/.test(f) && matchesAny(f, expected.htmlSinkScope),
      what: 'innerHTML / set:html with input that is neither constant nor escaped',
      find(text) {
        const hits = [];
        for (const m of text.matchAll(/\.(?:inner|outer)HTML\s*\+?=(?!=)/g)) {
          const rhs = takeExpression(text, m.index + m[0].length);
          if (!safeHtmlExpr(rhs)) hits.push([m.index, `${m[0].trim()} ${rhs.trim().replace(/\s+/g, ' ').slice(0, 70)}`]);
        }
        for (const m of text.matchAll(/\bset:html=\{/g)) {
          const expr = takeExpression(text, m.index + m[0].length, { closer: '}' });
          if (!safeHtmlExpr(expr)) hits.push([m.index, `set:html={${expr.trim().replace(/\s+/g, ' ').slice(0, 70)}}`]);
        }
        for (const m of text.matchAll(/\binsertAdjacentHTML\s*\(/g)) {
          const args = splitTop(takeExpression(text, m.index + m[0].length, { closer: ')' }), ',');
          if (!safeHtmlExpr(args[1] ?? '')) hits.push([m.index, `insertAdjacentHTML(…, ${(args[1] ?? '').trim().slice(0, 60)})`]);
        }
        return hits;
      },
    },
    {
      id: 'credential-in-url', scope: (f) => CODE_EXT.test(f),
      what: 'a credential in a URL or query string: send it in a header or body',
      find(text) {
        const hits = [];
        const name = '(?:access_token|id_token|token|api_?key|apikey|password|passwd|secret|client_secret|auth|authorization|jwt|credential|code|sig|signature)';
        for (const m of text.matchAll(new RegExp(`[?&]${name}=(?=\\$\\{|['"\`]\\s*\\+|[A-Za-z0-9_-]{16,})`, 'gi'))) hits.push([m.index, m[0]]);
        for (const m of text.matchAll(new RegExp(`searchParams\\.(?:set|append)\\(\\s*['"\`]${name}['"\`]`, 'gi'))) hits.push([m.index, m[0]]);
        return hits;
      },
    },
    {
      id: 'node-test', scope: (f) => (CODE_EXT.test(f) || /\.(?:sh|bash)$|(^|\/)(?:Makefile|Dockerfile)$/.test(f)) && f !== 'tools/run-tests.mjs',
      what: '`node --test` outside tools/run-tests.mjs: tests run only through the guarded runner',
      find(text) {
        return [...text.matchAll(/\bnode\b[^\n;|&`'"]*?\s--test\b/g)].map((m) => [m.index, m[0].trim()]);
      },
    },
    ...trust.map((h) => ({
      id: 'trust-header-set', scope: (f) => CODE_EXT.test(f) && !h.setters.includes(f) && !(expected.trustHeaderDefinitions ?? []).includes(f),
      what: `${h.header} set outside its allowed files (${h.setters.join(', ')})`,
      find(text) {
        const names = [h.constant, `['"\`]${h.header.replace(/[-]/g, '\\-')}['"\`]`];
        const hits = [];
        for (const n of names) for (const form of setForms(n)) for (const m of text.matchAll(new RegExp(form, 'gi'))) hits.push([m.index, `sets ${h.header}`]);
        for (const m of text.matchAll(new RegExp(`(['"\`])${h.header}\\1\\s*:`, 'gi'))) hits.push([m.index, `sets ${h.header}`]);
        return hits;
      },
    })),
    {
      id: 'referer-trust', scope: (f) => CODE_EXT.test(f),
      what: 'reads the Referer: it is self-asserted and may only be a hint',
      find(text) {
        const re = /\.get\(\s*['"`]referr?er['"`]\s*\)|\bheaders\??\.referr?er\b(?!\s*=[^=])|\bheaders\??\.?\[\s*['"`]referr?er['"`]\s*\](?!\s*=[^=])|\bdocument\.referrer\b|\brequest\.referrer\b/gi;
        return [...text.matchAll(re)].map((m) => [m.index, m[0]]);
      },
    },
    {
      id: 'eval', scope: (f) => CODE_EXT.test(f),
      what: 'eval / new Function runs strings as code',
      find(text) {
        const re = /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(|\b(?:setTimeout|setInterval)\s*\(\s*['"`]/g;
        return [...text.matchAll(re)].map((m) => [m.index, m[0].replace(/\s+/g, ' ')]);
      },
    },
  ];
}

function checkPatterns(ctx) {
  const findings = [];
  const rules = patternRules(ctx.expected);
  for (const f of ctx.files) {
    if (isTestPath(f) || f === 'tools/security-check.mjs') continue;
    const inScope = rules.filter((r) => r.scope(f));
    if (!inScope.length) continue;
    const raw = readText(join(ctx.root, f));
    if (raw === null) continue;
    const text = stripComments(raw, /\.(?:astro|html|vue|svelte)$/.test(f));
    const lines = raw.split('\n');
    for (const rule of inScope) {
      for (const [index, detail] of rule.find(text)) {
        const line = lineOf(text, index);
        findings.push({ check: `patterns/${rule.id}`, file: f, line, source: lines[line - 1]?.trim() ?? '', message: `${rule.what}: ${detail}` });
      }
    }
  }
  findings.push(...packageScripts(ctx));
  return { findings };
}

/** `node --test` in a package.json script other than `test`, which run-tests.mjs runs under its guard. */
function packageScripts(ctx) {
  const out = [];
  for (const f of ctx.files.filter((x) => x.endsWith('package.json') && !isTestPath(x))) {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(ctx.root, f), 'utf8')); } catch { continue; }
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (name !== 'test' && /\bnode\b[^;&|]*\s--test\b/.test(String(script))) {
        out.push({ check: 'patterns/node-test', file: f, line: 1, source: `"${name}": ${script}`, message: `\`node --test\` in script "${name}": tests run only through tools/run-tests.mjs` });
      }
    }
  }
  return out;
}

// ── 4. routes: the access manifest audit, without the test suite ────────────

function checkRoutes(ctx) {
  const shellRoot = join(ctx.root, 'packages/shell');
  const helper = join(shellRoot, 'test/helpers/routeAudit.ts');
  if (!existsSync(helper)) return { error: 'packages/shell/test/helpers/routeAudit.ts not found' };
  const code = `
    const { auditShellAccess } = await import(${JSON.stringify(helper)});
    process.stdout.write(JSON.stringify(auditShellAccess(${JSON.stringify(shellRoot)})));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], {
    cwd: shellRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  let result;
  try { result = JSON.parse(r.stdout); } catch {
    const why = (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').find((l) => /Error|Cannot/.test(l)) ?? r.stderr.trim().split('\n')[0];
    return { error: `route audit did not run: ${String(why).slice(0, 200)}${/typescript/.test(r.stderr) ? ' (run pnpm install)' : ''}` };
  }
  const findings = result.issues.map((i) => ({ check: `routes/${i.code}`, file: 'packages/shell/src/lib/access/routeManifest.ts', id: i.subject, message: `${i.code}: ${i.subject}` }));
  for (const l of result.listeners) {
    findings.push({ check: 'routes/listener', file: 'packages/shell/test/helpers/routeAudit.ts', id: l,
      message: l.startsWith('+') ? `unclassified listener ${l.slice(1)}: classify it in SURFACE_MANIFEST and KNOWN_LISTENERS` : `listener ${l.slice(1)} is gone: update KNOWN_LISTENERS` });
  }
  if (result.routes < 100) return { error: `the route walk found only ${result.routes} API routes`, findings };
  return { findings, info: `${result.routes} API routes` };
}

// ── 5. HTTP headers: the code paths that set them still exist, unweakened ───

function functionBody(text, anchor) {
  const at = text.indexOf(anchor);
  if (at < 0) return null;
  const open = text.indexOf('{', at + anchor.length - 1);
  if (open < 0) return null;
  return text.slice(open, open + 1 + takeExpression(text, open + 1, { closer: '}' }).length + 1);
}

function checkHeaders(ctx) {
  const findings = [];
  const exp = ctx.expected;
  for (const e of exp.headers ?? []) {
    for (const file of e.files ?? [e.file]) {
      const add = (message) => findings.push({ check: 'headers/expected', file, id: e.id, message: `${e.id}: ${message}` });
      const raw = readText(join(ctx.root, file));
      if (raw === null) { add('file not found'); continue; }
      const text = e.within ? functionBody(raw, e.within) : raw;
      if (text === null) { add(`"${e.within}" not found`); continue; }
      for (const s of e.require ?? []) if (!text.includes(s)) add(`missing ${JSON.stringify(s)}`);
      for (const s of e.forbid ?? []) if (text.includes(s)) add(`contains ${JSON.stringify(s)}`);
    }
  }
  const scope = (f) => matchesAny(f, exp.headerScope) && CODE_EXT.test(f) && !isTestPath(f);
  for (const f of ctx.files.filter(scope)) {
    const raw = readText(join(ctx.root, f));
    if (raw === null) continue;
    const text = stripComments(raw, f.endsWith('.astro'));
    const lines = raw.split('\n');
    for (const w of exp.weakened ?? []) {
      for (const m of text.matchAll(new RegExp(w.pattern, 'gi'))) {
        const line = lineOf(text, m.index);
        findings.push({ check: 'headers/weakened', file: f, line, id: w.id, source: lines[line - 1]?.trim() ?? '', message: `${w.id}: ${w.why}` });
      }
    }
    // Every Set-Cookie the shell builds is HttpOnly and SameSite Lax or Strict.
    for (const m of text.matchAll(/=\$\{[^}]+\};\s*Path=\/[^\n]*/g)) {
      const cookie = m[0];
      if (!/HttpOnly/.test(cookie) || !/SameSite=(?:Lax|Strict)/i.test(cookie)) {
        const line = lineOf(text, m.index);
        findings.push({ check: 'headers/cookie-flags', file: f, line, source: lines[line - 1]?.trim() ?? '', message: 'a cookie without HttpOnly and SameSite=Lax|Strict' });
      }
    }
  }
  return { findings };
}

// ── run ─────────────────────────────────────────────────────────────────────

const RUNNERS = { secrets: checkSecrets, deps: checkDeps, patterns: checkPatterns, routes: checkRoutes, headers: checkHeaders };

export async function main(argv, out = (s) => process.stdout.write(`${s}\n`)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(`SECURITY ERROR ${e.message}`); return EXIT.TOOL; }
  if (opts.help) { out(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return EXIT.CLEAN; }
  const root = opts.root ?? resolve(HERE, '..');
  const started = Date.now();
  const errors = [];
  let expected = {}, allow = [];
  try { expected = JSON.parse(readFileSync(join(root, 'tools/security-expected.json'), 'utf8')); }
  catch (e) { errors.push(`tools/security-expected.json: ${e.message}`); }
  try {
    const file = join(root, 'tools/security-allowlist.yaml');
    allow = existsSync(file) ? parseAllowlist(readFileSync(file, 'utf8'), 'tools/security-allowlist.yaml') : [];
  } catch (e) { errors.push(e.message); }

  const ctx = {
    root, opts, expected, files: listFiles(root),
    extra: opts.noExtra ? [] : [...(expected.extraSecretPaths ?? []), ...opts.extra],
  };
  const selected = CHECKS.filter((c) => (!opts.only || opts.only.includes(c)) && !opts.skip.includes(c));
  const results = {};
  const warnings = [];
  if (!errors.length) {
    for (const c of selected) {
      try { results[c] = RUNNERS[c](ctx); } catch (e) { results[c] = { error: e.stack?.split('\n').slice(0, 2).join(' ') ?? String(e) }; }
      if (results[c].error) errors.push(`${c}: ${results[c].error}`);
      warnings.push(...(results[c].warnings ?? []));
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const live = allow.filter((e) => !e.expires || e.expires >= today);
  for (const e of allow) if (e.expires && e.expires < today) warnings.push(`allowlist line ${e.line}: expired ${e.expires} (${e.check}), no longer applied`);
  const used = new Set();
  const findings = [];
  const allowed = [];
  for (const c of selected) {
    for (const f of results[c]?.findings ?? []) {
      const entry = allowedBy(f, live);
      if (entry) { used.add(entry); allowed.push({ ...f, allowlist: entry.line }); } else findings.push(f);
    }
  }
  for (const e of live) {
    const check = e.check.split('/')[0];
    if (selected.includes(check) && !results[check]?.error && !used.has(e)) warnings.push(`allowlist line ${e.line}: matches nothing (${e.check}${e.file ? ` ${e.file}` : ''}): remove it`);
  }

  const counts = Object.fromEntries(selected.map((c) => [c, findings.filter((f) => f.check.startsWith(`${c}/`)).length]));
  const code = errors.length ? EXIT.TOOL : findings.length ? EXIT.FINDINGS : EXIT.CLEAN;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (opts.json) {
    out(JSON.stringify({ exit: code, root, checks: selected, counts, findings, allowlisted: allowed, warnings, errors, seconds: Number(seconds) }));
    return code;
  }
  const verdict = code === EXIT.TOOL ? 'ERROR' : code === EXIT.FINDINGS ? 'FAIL' : 'PASS';
  out(`SECURITY ${verdict} ${findings.length} finding${findings.length === 1 ? '' : 's'} (${selected.map((c) => `${c} ${!results[c] ? 'not run' : results[c].error ? 'error' : counts[c]}`).join(', ')}) · ${allowed.length} allowlisted · ${warnings.length} warning${warnings.length === 1 ? '' : 's'} · ${seconds}s`);
  for (const f of findings) out(`${f.check} ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.message}`.replace(/\s+/g, ' '));
  for (const e of errors) out(`ERROR ${e}`);
  for (const w of warnings) out(`WARN ${w}`);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? EXIT.FINDINGS); throw e; });   // `| head`
  process.exitCode = await main(process.argv.slice(2));
}
