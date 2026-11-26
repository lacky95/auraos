/**
 * The MCP client configs in the shared home (D89 B5): Claude Code's
 * `~/.claude.json` and Codex's `~/.codex/config.toml`. An Aura MCP entry (one
 * whose URL goes through the shell's `/api/proxy/`) carries the caller's
 * instance token BY REFERENCE, never by value:
 *
 *   Claude Code  "url": "${OS_API_BASE}/api/proxy/<app>/<path>",
 *                "headers": { "Authorization": "Bearer ${AURA_INSTANCE_TOKEN}" }
 *                (expanded per process at connect; stored as written)
 *   Codex        url = "<OS_API_BASE>/api/proxy/<app>/<path>"
 *                bearer_token_env_var = "AURA_INSTANCE_TOKEN"
 *
 * `~` is read by every process that shares the home (an App Home, a Private Home), so a literal token there
 * hands one instance's identity to all of them; the reference gives each
 * container its own. Nothing here ever returns, prints or writes a token
 * value: entries are classified, and a rewrite only writes the reference.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TOKEN_ENV = 'AURA_INSTANCE_TOKEN';
export const BASE_ENV = 'OS_API_BASE';
export const CLAUDE_AUTH_REF = `Bearer \${${TOKEN_ENV}}`;
export const BACKUP_SUFFIX = '.bak-aura-mcp';

/**
 *   reference      the token by an env reference (the wanted form)
 *   helper         Claude Code `headersHelper` (a script prints the headers)
 *   tokenless      no credential: works only while the shell names callers by address (D28, going in 5-main)
 *   literal-token  an AuraOS credential written into the file (aura1. / aura_k1_): fix it now
 *   literal-other  another literal Authorization value (not AuraOS's): left alone
 */
export type McpAuthForm = 'reference' | 'helper' | 'tokenless' | 'literal-token' | 'literal-other';

export interface McpEntry {
  client: 'claude' | 'codex';
  /** `user`, or `project:<path>` (Claude Code local scope). */
  scope: string;
  name: string;
  /** The URL as stored (an env reference, or a plain URL: never a credential). */
  url: string;
  auth: McpAuthForm;
  /** For `reference`: the variable it names. */
  env?: string;
}

export interface McpPaths { claude: string; codex: string }

export function defaultMcpPaths(home = homedir()): McpPaths {
  return { claude: join(home, '.claude.json'), codex: join(process.env['CODEX_HOME'] || join(home, '.codex'), 'config.toml') };
}

const AURA_CREDENTIAL_RE = /\baura1\.|\baura_k1_|\baura-sess1\./;
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/** Whether an MCP URL goes through an AuraOS shell (`/api/proxy/`). */
export function isAuraMcpUrl(url: unknown): url is string {
  return typeof url === 'string' && /\/api\/proxy\/[^/]+/.test(url);
}

function classifyHeaderValue(value: unknown): { auth: McpAuthForm; env?: string } {
  const v = String(value ?? '');
  const ref = ENV_REF_RE.exec(v);
  if (ref) return { auth: 'reference', env: ref[1]! };
  if (AURA_CREDENTIAL_RE.test(v)) return { auth: 'literal-token' };
  return { auth: v.trim() ? 'literal-other' : 'tokenless' };
}

// ── Claude Code (~/.claude.json) ───────────────────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function authHeaderKey(headers: Json): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
}

function claudeEntry(scope: string, name: string, server: Json): McpEntry | null {
  if (!isAuraMcpUrl(server['url'])) return null;
  const base = { client: 'claude' as const, scope, name, url: server['url'] };
  if (typeof server['headersHelper'] === 'string' && server['headersHelper']) return { ...base, auth: 'helper' };
  const headers = isObj(server['headers']) ? server['headers'] : {};
  const key = authHeaderKey(headers);
  if (!key) return { ...base, auth: 'tokenless' };
  return { ...base, ...classifyHeaderValue(headers[key]) };
}

/** Every `mcpServers` map in the file: user scope and each project's local scope. */
function claudeServerMaps(doc: Json): Array<{ scope: string; servers: Json }> {
  const out: Array<{ scope: string; servers: Json }> = [];
  if (isObj(doc['mcpServers'])) out.push({ scope: 'user', servers: doc['mcpServers'] });
  if (isObj(doc['projects'])) {
    for (const [path, project] of Object.entries(doc['projects'])) {
      if (isObj(project) && isObj(project['mcpServers'])) out.push({ scope: `project:${path}`, servers: project['mcpServers'] });
    }
  }
  return out;
}

export function claudeEntries(doc: Json): McpEntry[] {
  return claudeServerMaps(doc).flatMap(({ scope, servers }) => Object.entries(servers)
    .map(([name, s]) => (isObj(s) ? claudeEntry(scope, name, s) : null))
    .filter((e): e is McpEntry => e !== null));
}

/** The Claude Code entry `aura mcp add` writes: the base and the token both by reference. */
export function claudeServer(proxyPath: string): Json {
  return { type: 'http', url: `\${${BASE_ENV}}${proxyPath}`, headers: { Authorization: CLAUDE_AUTH_REF } };
}

/** The document with every tokenless or literal-token Aura entry on the reference (changed in place). */
export function fixClaude(doc: Json): { doc: Json; fixed: McpEntry[] } {
  const fixed: McpEntry[] = [];
  for (const { scope, servers } of claudeServerMaps(doc)) {
    for (const [name, s] of Object.entries(servers)) {
      if (!isObj(s)) continue;
      const entry = claudeEntry(scope, name, s);
      if (!entry || (entry.auth !== 'tokenless' && entry.auth !== 'literal-token')) continue;
      const headers = isObj(s['headers']) ? { ...s['headers'] } : {};
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
      headers['Authorization'] = CLAUDE_AUTH_REF;
      s['headers'] = headers;
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

const unquote = (name: string) => (name.startsWith('"') ? JSON.parse(name) as string : name);

/** A TOML basic or literal string value at the start of `raw`, or null. */
function tomlString(raw: string): string | null {
  const t = raw.trim();
  if (t.startsWith('"')) { try { return JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(t)?.[0] ?? '') as string; } catch { return null; } }
  if (t.startsWith("'")) return /^'([^']*)'/.exec(t)?.[1] ?? null;
  return null;
}

interface CodexServer {
  name: string;
  /** Line index of `[mcp_servers.<name>]`. */
  header: number;
  url?: string;
  /** Line indexes, for the rewrite. */
  bearerEnvLine?: number;
  bearerEnv?: string;
  bearerTokenLine?: number;
  /** `Authorization` in `http_headers` (inline table line, or a line of the sub-table). */
  authLine?: number;
  authInline?: boolean;
  authValue?: string;
  envAuth?: string;
}

function codexServers(lines: string[]): Map<string, CodexServer> {
  const servers = new Map<string, CodexServer>();
  let current: CodexServer | null = null;
  let sub: string | null = null;
  lines.forEach((line, i) => {
    const t = TABLE_RE.exec(line);
    if (t) {
      const name = unquote(t[1]!);
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
    const key = kv[2]!;
    const raw = kv[3]!;
    const s: CodexServer = current;
    if (sub === null) {
      if (key === 'url') s.url = tomlString(raw) ?? undefined;
      else if (key === 'bearer_token_env_var') { s.bearerEnvLine = i; s.bearerEnv = tomlString(raw) ?? undefined; }
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

function codexEntry(s: CodexServer): McpEntry | null {
  if (!isAuraMcpUrl(s.url)) return null;
  const base = { client: 'codex' as const, scope: 'user', name: s.name, url: s.url };
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

export function codexEntries(toml: string): McpEntry[] {
  return [...codexServers(toml.split('\n')).values()].map(codexEntry).filter((e): e is McpEntry => e !== null);
}

/** A Codex table for `aura mcp add`. */
export function codexTable(name: string, url: string): string {
  const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
  return `[mcp_servers.${key}]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "${TOKEN_ENV}"\n`;
}

/**
 * The file with every tokenless or literal-token Aura entry on
 * `bearer_token_env_var`. `manual`: entries that can't be rewritten line by
 * line (an inline `http_headers` with other headers next to a literal AuraOS token).
 */
export function fixCodex(toml: string): { toml: string; fixed: McpEntry[]; manual: McpEntry[] } {
  const lines = toml.split('\n');
  const drop = new Set<number>();
  const insertAfter = new Map<number, string>();
  const fixed: McpEntry[] = [];
  const manual: McpEntry[] = [];
  for (const s of codexServers(lines).values()) {
    const entry = codexEntry(s);
    if (!entry || (entry.auth !== 'tokenless' && entry.auth !== 'literal-token')) continue;
    if (s.header < 0) { manual.push(entry); continue; }
    if (s.authLine !== undefined && entry.auth === 'literal-token') {
      if (s.authInline) {
        // Only Authorization in the inline table: the whole line goes.
        const inner = /=\s*\{(.*)\}\s*(?:#.*)?$/.exec(lines[s.authLine]!)?.[1] ?? '';
        if (inner.split(',').filter((p) => p.trim()).length !== 1) { manual.push(entry); continue; }
      }
      drop.add(s.authLine);
    }
    if (s.bearerTokenLine !== undefined) drop.add(s.bearerTokenLine);
    insertAfter.set(s.header, `bearer_token_env_var = "${TOKEN_ENV}"`);
    fixed.push(entry);
  }
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!drop.has(i)) out.push(line);
    const add = insertAfter.get(i);
    if (add) out.push(add);
  });
  return { toml: out.join('\n'), fixed, manual };
}

/** Append a table, or replace the one of that name. */
export function upsertCodexTable(toml: string, name: string, url: string): string {
  const lines = toml.split('\n');
  const s = codexServers(lines).get(name);
  // A literal Authorization in its `http_headers` sub-table goes first.
  if (s && s.authLine !== undefined && !s.authInline) {
    lines.splice(s.authLine, 1);
    return upsertCodexTable(lines.join('\n'), name, url);
  }
  const table = codexTable(name, url).trimEnd().split('\n');
  if (!s || s.header < 0) {
    const body = toml.replace(/\n*$/, '');
    return `${body}${body ? '\n\n' : ''}${table.join('\n')}\n`;
  }
  // Replace the main table's lines (up to the next table header), keep everything else.
  let end = s.header + 1;
  while (end < lines.length && !ANY_TABLE_RE.test(lines[end]!)) end += 1;
  // Keep trailing blank lines between tables.
  let keep = end;
  while (keep > s.header + 1 && lines[keep - 1]!.trim() === '') keep -= 1;
  return [...lines.slice(0, s.header), ...table, ...lines.slice(keep)].join('\n');
}

// ── files ──────────────────────────────────────────────────────────────────

export function readClaudeDoc(path: string): Json | null {
  if (!existsSync(path)) return null;
  const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown;   // a broken file is an error, never replaced
  return isObj(v) ? v : {};
}

export function readCodexToml(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

/** Every Aura MCP entry in both files: classifications only, never a value. */
export function listMcpEntries(paths: McpPaths = defaultMcpPaths()): McpEntry[] {
  const claude = readClaudeDoc(paths.claude);
  const codex = readCodexToml(paths.codex);
  return [...(claude ? claudeEntries(claude) : []), ...(codex !== null ? codexEntries(codex) : [])];
}

const AURA_CREDENTIAL_VALUE_RE = /\b(?:aura1\.|aura_k1_|aura-sess1\.)[A-Za-z0-9._~+/=-]+/g;

/** The text with every AuraOS credential value replaced: a backup never keeps a literal token. */
export function redactAuraCredentials(text: string): string {
  return text.replace(AURA_CREDENTIAL_VALUE_RE, 'REMOVED-AURA-CREDENTIAL');
}

/**
 * Write `text` to `path` after a copy of the old file at `path + BACKUP_SUFFIX`
 * (owner-only, like the file). The copy has any AuraOS credential value
 * removed: `~` is shared, so a backup must not keep what the fix took out.
 */
export function backupAndWrite(path: string, text: string): string | null {
  let mode = 0o600;
  let backup: string | null = null;
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
