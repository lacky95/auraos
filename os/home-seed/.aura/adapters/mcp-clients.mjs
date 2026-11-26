#!/usr/bin/env node
// Seeded by AuraOS (os/home-seed); yours to edit, replace or delete.
//
// An optional client adapter (D96): it moves Aura MCP entries in two agent
// products' configs onto the generic AuraOS access, the caller's session
// credential by reference. AuraOS itself knows nothing about these files; the
// generic access is
//
//   MCP endpoint   $OS_API_BASE + the Interface Registry entry's `url`
//                  (`aura get interfaces`, or GET $OS_API_BASE/api/interfaces?kind=mcp)
//   credential     Authorization: Bearer $AURA_INSTANCE_TOKEN
//
// and any client that can send that header works without this file.
//
//   node ~/.aura/adapters/mcp-clients.mjs ls [--json]   every Aura entry and how it authenticates
//   node ~/.aura/adapters/mcp-clients.mjs fix [--dry-run]
//                  rewrite tokenless and literal-token Aura entries to the reference
//
// Aura entry: an MCP server whose URL goes through the shell (`/api/proxy/`).
// The reference, per product:
//
//   Claude Code  ~/.claude.json         "headers": { "Authorization": "Bearer ${AURA_INSTANCE_TOKEN}" }
//                                       (expanded per process at connect; stored as written)
//   Codex        ~/.codex/config.toml   bearer_token_env_var = "AURA_INSTANCE_TOKEN"
//
// `~` is read by every process that shares the home (an App Home, a Private
// Home), so a literal token there would hand one instance's identity to all of
// them; the reference gives each process its own. Nothing here returns, prints or writes a token value: entries are
// classified, a rewrite writes only the reference, and the old file is kept as
// `<file>.bak-aura-mcp` with any AuraOS credential removed. `fix` writes only
// after a yes at an interactive terminal (an agent without one sees the plan).
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const TOKEN_ENV = 'AURA_INSTANCE_TOKEN';
export const CLAUDE_AUTH_REF = `Bearer \${${TOKEN_ENV}}`;
export const BACKUP_SUFFIX = '.bak-aura-mcp';

/**
 * How an Aura entry authenticates:
 *   reference      the token by an env reference (the wanted form)
 *   helper         Claude Code `headersHelper` (a script prints the headers)
 *   tokenless      no credential (refused once the shell requires the token)
 *   literal-token  an AuraOS credential written into the file: fix it now
 *   literal-other  another literal Authorization value (not AuraOS's): left alone
 * An entry: { client, scope ('user' | 'project:<path>'), name, url (as stored), auth, env? }.
 */

export function defaultPaths(home = homedir()) {
  return { claude: join(home, '.claude.json'), codex: join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml') };
}

const AURA_CREDENTIAL_RE = /\baura1\.|\baura_k1_|\baura-sess1\./;
const AURA_CREDENTIAL_VALUE_RE = /\b(?:aura1\.|aura_k1_|aura-sess1\.)[A-Za-z0-9._~+/=-]+/g;
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

const isAuraUrl = (url) => typeof url === 'string' && /\/api\/proxy\/[^/]+/.test(url);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function classifyHeaderValue(value) {
  const v = String(value ?? '');
  const ref = ENV_REF_RE.exec(v);
  if (ref) return { auth: 'reference', env: ref[1] };
  if (AURA_CREDENTIAL_RE.test(v)) return { auth: 'literal-token' };
  return { auth: v.trim() ? 'literal-other' : 'tokenless' };
}

const needsFix = (e) => e.auth === 'tokenless' || e.auth === 'literal-token';

// ── Claude Code (~/.claude.json) ───────────────────────────────────────────

function claudeEntry(scope, name, server) {
  if (!isAuraUrl(server.url)) return null;
  const base = { client: 'claude', scope, name, url: server.url };
  if (typeof server.headersHelper === 'string' && server.headersHelper) return { ...base, auth: 'helper' };
  const headers = isObj(server.headers) ? server.headers : {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  if (!key) return { ...base, auth: 'tokenless' };
  return { ...base, ...classifyHeaderValue(headers[key]) };
}

/** Every `mcpServers` map in the file: user scope and each project's local scope. */
function claudeServerMaps(doc) {
  const out = [];
  if (isObj(doc.mcpServers)) out.push({ scope: 'user', servers: doc.mcpServers });
  if (isObj(doc.projects)) {
    for (const [path, project] of Object.entries(doc.projects)) {
      if (isObj(project) && isObj(project.mcpServers)) out.push({ scope: `project:${path}`, servers: project.mcpServers });
    }
  }
  return out;
}

export function claudeEntries(doc) {
  return claudeServerMaps(doc).flatMap(({ scope, servers }) => Object.entries(servers)
    .map(([name, s]) => (isObj(s) ? claudeEntry(scope, name, s) : null))
    .filter(Boolean));
}

/** The document with every tokenless or literal-token Aura entry on the reference (changed in place). */
export function fixClaude(doc) {
  const fixed = [];
  for (const { scope, servers } of claudeServerMaps(doc)) {
    for (const [name, s] of Object.entries(servers)) {
      if (!isObj(s)) continue;
      const entry = claudeEntry(scope, name, s);
      if (!entry || !needsFix(entry)) continue;
      const headers = isObj(s.headers) ? { ...s.headers } : {};
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
      headers.Authorization = CLAUDE_AUTH_REF;
      s.headers = headers;
      fixed.push(entry);
    }
  }
  return { doc, fixed };
}

// ── Codex (~/.codex/config.toml) ───────────────────────────────────────────
// A line-level reader for the `[mcp_servers.*]` tables only, so the rest of
// the file (comments, order, other tables) stays byte for byte.

const TABLE_RE = /^\s*\[\s*mcp_servers\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\s*\]\s*(?:#.*)?$/;
const ANY_TABLE_RE = /^\s*\[/;
const KEY_RE = /^\s*("?)([A-Za-z0-9_-]+)\1\s*=\s*(.*)$/;

const unquote = (name) => (name.startsWith('"') ? JSON.parse(name) : name);

/** A TOML basic or literal string value at the start of `raw`, or null. */
function tomlString(raw) {
  const t = raw.trim();
  if (t.startsWith('"')) { try { return JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(t)?.[0] ?? ''); } catch { return null; } }
  if (t.startsWith("'")) return /^'([^']*)'/.exec(t)?.[1] ?? null;
  return null;
}

/** name → { header (line of `[mcp_servers.<name>]`, -1 if only sub-tables), url, line indexes of the auth keys }. */
function codexServers(lines) {
  const servers = new Map();
  let current = null;
  let sub = null;
  lines.forEach((line, i) => {
    const t = TABLE_RE.exec(line);
    if (t) {
      const name = unquote(t[1]);
      sub = t[2] ?? null;
      current = servers.get(name) ?? null;
      if (!current) {
        current = { name, header: sub ? -1 : i };
        servers.set(name, current);
      } else if (!sub && current.header < 0) current.header = i;
      return;
    }
    if (ANY_TABLE_RE.test(line)) { current = null; sub = null; return; }
    if (!current) return;
    const kv = KEY_RE.exec(line);
    if (!kv) return;
    const [, , key, raw] = kv;
    const s = current;
    if (sub === null) {
      if (key === 'url') s.url = tomlString(raw) ?? undefined;
      else if (key === 'bearer_token_env_var') s.bearerEnv = tomlString(raw) ?? undefined;
      else if (key === 'bearer_token') s.bearerTokenLine = i;
      else if (key === 'http_headers' && /authorization/i.test(raw)) {
        s.authLine = i; s.authInline = true;
        s.authValue = /["']?authorization["']?\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/i.exec(raw)?.[1] ?? '';
      } else if (key === 'env_http_headers' && /authorization/i.test(raw)) {
        s.envAuth = tomlString(/["']?authorization["']?\s*=\s*(.*)$/i.exec(raw)?.[1] ?? '') ?? undefined;
      }
    } else if (sub === 'http_headers' && key.toLowerCase() === 'authorization') {
      s.authLine = i; s.authInline = false; s.authValue = raw;
    } else if (sub === 'env_http_headers' && key.toLowerCase() === 'authorization') {
      s.envAuth = tomlString(raw) ?? undefined;
    }
  });
  return servers;
}

function codexEntry(s) {
  if (!isAuraUrl(s.url)) return null;
  const base = { client: 'codex', scope: 'user', name: s.name, url: s.url };
  if (s.bearerEnv) return { ...base, auth: 'reference', env: s.bearerEnv };
  if (s.envAuth) return { ...base, auth: 'reference', env: s.envAuth };
  if (s.bearerTokenLine !== undefined) return { ...base, auth: 'literal-token' };
  if (s.authLine !== undefined) {
    const c = classifyHeaderValue(s.authValue);
    // A literal value in TOML is never a reference (Codex doesn't expand it).
    return { ...base, auth: c.auth === 'reference' ? 'literal-other' : c.auth };
  }
  return { ...base, auth: 'tokenless' };
}

export function codexEntries(toml) {
  return [...codexServers(toml.split('\n')).values()].map(codexEntry).filter(Boolean);
}

/**
 * The file with every tokenless or literal-token Aura entry on
 * `bearer_token_env_var`. `manual`: entries that can't be rewritten line by
 * line (an inline `http_headers` with other headers next to a literal AuraOS token).
 */
export function fixCodex(toml) {
  const lines = toml.split('\n');
  const drop = new Set();
  const insertAfter = new Map();
  const fixed = [];
  const manual = [];
  for (const s of codexServers(lines).values()) {
    const entry = codexEntry(s);
    if (!entry || !needsFix(entry)) continue;
    if (s.header < 0) { manual.push(entry); continue; }
    if (s.authLine !== undefined && entry.auth === 'literal-token') {
      if (s.authInline) {
        // Only Authorization in the inline table: the whole line goes.
        const inner = /=\s*\{(.*)\}\s*(?:#.*)?$/.exec(lines[s.authLine])?.[1] ?? '';
        if (inner.split(',').filter((p) => p.trim()).length !== 1) { manual.push(entry); continue; }
      }
      drop.add(s.authLine);
    }
    if (s.bearerTokenLine !== undefined) drop.add(s.bearerTokenLine);
    insertAfter.set(s.header, `bearer_token_env_var = "${TOKEN_ENV}"`);
    fixed.push(entry);
  }
  const out = [];
  lines.forEach((line, i) => {
    if (!drop.has(i)) out.push(line);
    const add = insertAfter.get(i);
    if (add) out.push(add);
  });
  return { toml: out.join('\n'), fixed, manual };
}

// ── files ──────────────────────────────────────────────────────────────────

export function readClaudeDoc(path) {
  if (!existsSync(path)) return null;
  const v = JSON.parse(readFileSync(path, 'utf-8'));   // a broken file is an error, never replaced
  return isObj(v) ? v : {};
}

export function readCodexToml(path) {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** Every Aura entry in both files: classifications only, never a value. */
export function listEntries(paths = defaultPaths()) {
  const claude = readClaudeDoc(paths.claude);
  const codex = readCodexToml(paths.codex);
  return [...(claude ? claudeEntries(claude) : []), ...(codex !== null ? codexEntries(codex) : [])];
}

/** The text with every AuraOS credential value replaced: a backup never keeps a literal token. */
export function redactAuraCredentials(text) {
  return text.replace(AURA_CREDENTIAL_VALUE_RE, 'REMOVED-AURA-CREDENTIAL');
}

/** Write `text` to `path` after an owner-only copy of the old file (AuraOS credentials removed) at `path + BACKUP_SUFFIX`. */
export function backupAndWrite(path, text) {
  let mode = 0o600;
  let backup = null;
  if (existsSync(path)) {
    const old = readFileSync(path, 'utf-8');
    if (old === text) return null;
    mode = statSync(path).mode & 0o777;
    backup = `${path}${BACKUP_SUFFIX}`;
    writeFileSync(backup, redactAuraCredentials(old), { mode: 0o600 });
    chmodSync(backup, 0o600);
  }
  writeFileSync(path, text, { mode });
  return backup;
}

// ── command line ───────────────────────────────────────────────────────────

const AUTH_TEXT = {
  reference: 'token by reference',
  helper: 'headersHelper',
  tokenless: 'no token',
  'literal-token': 'LITERAL AuraOS token in the file',
  'literal-other': 'literal non-AuraOS Authorization',
};

/** A yes at an interactive terminal; without one, nothing is written. */
async function confirm(question, io) {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    io.err('Not written: this needs a yes at an interactive terminal. Run it in the AuraOS Terminal yourself (--dry-run shows the plan).');
    return false;
  }
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

export async function main(argv, io = {
  stdin: process.stdin, stdout: process.stdout,
  out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`),
}, paths = defaultPaths()) {
  const [cmd, ...flags] = argv;
  if (cmd === 'ls' || cmd === 'list') {
    const entries = listEntries(paths);
    if (flags.includes('--json')) { io.out(JSON.stringify({ entries }, null, 2)); return 0; }
    if (entries.length === 0) io.out(`no Aura MCP entries (URLs through /api/proxy/) in ${paths.claude} or ${paths.codex}`);
    for (const e of entries) io.out(`${e.client}\t${e.scope}\t${e.name}\t${e.url}\t${AUTH_TEXT[e.auth]}${e.env ? ` ($${e.env})` : ''}`);
    const todo = entries.filter(needsFix).length;
    if (todo) io.out(`${todo} to fix: node ~/.aura/adapters/mcp-clients.mjs fix`);
    return 0;
  }
  if (cmd === 'fix') {
    const claudeDoc = readClaudeDoc(paths.claude);
    const codexToml = readCodexToml(paths.codex);
    const claude = claudeDoc ? fixClaude(claudeDoc) : null;
    const codex = codexToml !== null ? fixCodex(codexToml) : null;
    const fixed = [...(claude?.fixed ?? []), ...(codex?.fixed ?? [])];
    for (const e of codex?.manual ?? []) {
      io.err(`codex ${e.name}: a literal AuraOS token next to other headers: edit ${paths.codex} by hand `
        + `(remove Authorization, add bearer_token_env_var = "${TOKEN_ENV}")`);
    }
    if (fixed.length === 0) { io.out('nothing to fix: every Aura MCP entry has its token by reference'); return 0; }
    for (const e of fixed) io.out(`  ${e.client} ${e.scope} ${e.name}: ${AUTH_TEXT[e.auth]} -> token by reference ($${TOKEN_ENV})`);
    if (fixed.some((e) => e.auth === 'literal-token')) {
      io.err('A literal token was in a file every app can read: it is removed here, and its instance\'s token changes at its next start.');
    }
    if (flags.includes('--dry-run') || flags.includes('-n')) return 0;
    if (!(await confirm(`Rewrite ${fixed.length} entr${fixed.length === 1 ? 'y' : 'ies'} (backups: *${BACKUP_SUFFIX})?`, io))) {
      io.out('nothing written');
      return 0;
    }
    if (claude?.fixed.length) backupAndWrite(paths.claude, `${JSON.stringify(claude.doc, null, 2)}\n`);
    if (codex?.fixed.length) backupAndWrite(paths.codex, codex.toml);
    io.out(`fixed ${fixed.length}. Restart running Claude Code or Codex sessions to use it.`);
    return 0;
  }
  io.err('usage: node ~/.aura/adapters/mcp-clients.mjs ls [--json] | fix [--dry-run]');
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`mcp-clients: ${err.message}\n`);
    process.exitCode = 1;
  });
}
