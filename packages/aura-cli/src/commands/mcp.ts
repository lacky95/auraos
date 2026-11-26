/**
 * `aura mcp` (D89 B5): Aura MCP servers in Claude Code's and Codex's configs,
 * with the caller's instance token by reference, never by value.
 *
 *   aura mcp ls [-o json]               every Aura entry (URL through /api/proxy) and how it authenticates
 *   aura mcp add <name> <app>[/<iface>] write an entry for an app's MCP interface into both configs
 *   aura mcp fix [--dry-run]            rewrite tokenless and literal-token Aura entries to the reference
 *
 * The configs live in `~`, which every app shares: a literal token there would
 * hand this instance's identity to all of them, so neither command ever
 * writes, prints or keeps a token value (lib/mcp-config.ts). A change to the
 * files needs the owner's confirmation at this terminal (an interactive
 * prompt: an agent without a terminal can only show the plan, `--dry-run`),
 * and the old file is kept as `<file>.bak-aura-mcp`.
 */
import type { Command } from 'commander';
import { api } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import {
  BACKUP_SUFFIX, TOKEN_ENV, backupAndWrite, claudeServer, defaultMcpPaths, fixClaude, fixCodex, listMcpEntries,
  readClaudeDoc, readCodexToml, upsertCodexTable, type McpEntry, type McpPaths,
} from '../lib/mcp-config.js';
import { PromptCancelled, promptConfirm } from '../lib/prompts.js';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const AUTH_TEXT: Record<McpEntry['auth'], string> = {
  reference: 'token by reference',
  helper: 'headersHelper',
  tokenless: 'no token (D28 address identity, ends in 5-main)',
  'literal-token': 'LITERAL AuraOS token in the file',
  'literal-other': 'literal non-AuraOS Authorization',
};

function authCell(e: McpEntry): string {
  const text = e.auth === 'reference' ? `${AUTH_TEXT.reference} ($${e.env})` : AUTH_TEXT[e.auth];
  if (e.auth === 'reference' && e.env === TOKEN_ENV) return color.green(text);
  if (e.auth === 'literal-token') return color.red(text);
  if (e.auth === 'tokenless') return color.yellow(text);
  return text;
}

/** The owner's yes at this terminal. Without one (no TTY, Ctrl-C, no), nothing is written. */
async function ownerConfirms(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    warn('Not written: changing these files needs the owner\'s confirmation at an interactive terminal. '
      + 'Run the same command in the AuraOS Terminal yourself (or see the plan with --dry-run).');
    return false;
  }
  try {
    return (await promptConfirm(question, false)) === true;
  } catch (err) {
    if (err instanceof PromptCancelled) return false;
    throw err;
  }
}

function describeFiles(paths: McpPaths): void {
  info(`Claude Code: ${paths.claude}`);
  info(`Codex:       ${paths.codex}`);
}

interface InterfaceRow { appId: string; name: string; kind: string; url?: string; address: string; status?: string }

/** The MCP interface `<app>[/<iface>]` names, from the Interface Registry. */
async function resolveMcp(ref: string): Promise<InterfaceRow> {
  const [appId, iface] = ref.split('/', 2) as [string, string | undefined];
  if (!APP_ID_RE.test(appId)) fail(`invalid app id '${appId}'`);
  const q = new URLSearchParams({ appId, kind: 'mcp', consumers: '0', ...(iface ? { name: iface } : {}) });
  const { interfaces } = await api.get<{ interfaces: InterfaceRow[] }>(`/api/interfaces?${q}`);
  if (interfaces.length === 0) fail(`${ref}: no MCP interface (see: curl -s "$OS_API_BASE/api/interfaces?kind=mcp&consumers=0")`);
  if (interfaces.length > 1) fail(`${appId} provides ${interfaces.length} MCP interfaces; name one: ${interfaces.map((i) => `${appId}/${i.name}`).join(', ')}`);
  return interfaces[0]!;
}

function proxyPathOf(row: InterfaceRow): string {
  const path = row.url ?? `/api/proxy/${row.appId}${row.address.startsWith('/') ? '' : '/'}${row.address}`;
  if (!path.startsWith('/api/proxy/')) fail(`${row.appId}/${row.name}: not reachable through the shell's /api/proxy (${path})`);
  return path;
}

export function registerMcp(program: Command): void {
  const mcp = program.command('mcp').description('Aura MCP servers in Claude Code and Codex, with your token by reference (D89 B5)');

  mcp
    .command('ls')
    .alias('list')
    .description('List the Aura MCP entries in ~/.claude.json and ~/.codex/config.toml and how each authenticates (never a value)')
    .option('-o, --output <format>', 'json')
    .action((o: { output?: string }) => {
      const paths = defaultMcpPaths();
      let entries: McpEntry[];
      try { entries = listMcpEntries(paths); } catch (err) { fail(`could not read the configs: ${(err as Error).message}`); }
      if (o.output === 'json') { process.stdout.write(`${JSON.stringify({ entries }, null, 2)}\n`); return; }
      if (entries.length === 0) { info('no Aura MCP entries (URLs through /api/proxy/)'); describeFiles(paths); return; }
      console.log(table(entries.map((e) => ({
        CLIENT: e.client, SCOPE: e.scope, NAME: e.name, URL: e.url, AUTH: authCell(e),
      })), ['CLIENT', 'SCOPE', 'NAME', 'URL', 'AUTH']));
      const todo = entries.filter((e) => e.auth === 'tokenless' || e.auth === 'literal-token').length;
      if (todo) info(`${todo} to fix: aura mcp fix`);
    });

  mcp
    .command('add <name> <ref>')
    .description('Add an app\'s MCP server (<app>[/<interface>]) to Claude Code and Codex, the token by reference')
    .option('--client <list>', 'claude, codex, or both (default: both)', 'claude,codex')
    .option('-n, --dry-run', 'show what would be written, write nothing')
    .action(async (name: string, ref: string, o: { client: string; dryRun?: boolean }) => {
      if (!NAME_RE.test(name)) fail(`invalid name '${name}' (letters, digits, - and _)`);
      const clients = new Set(o.client.split(',').map((c) => c.trim()).filter(Boolean));
      for (const c of clients) if (c !== 'claude' && c !== 'codex') fail(`unknown client '${c}' (claude, codex)`);
      const row = await resolveMcp(ref);
      const path = proxyPathOf(row);
      const base = (process.env['OS_API_BASE'] ?? '').replace(/\/$/, '');
      if (clients.has('codex') && !base) fail('OS_API_BASE is not set: Codex needs the shell\'s address written out');
      const paths = defaultMcpPaths();
      info(`${color.bold(name)} → ${row.appId}/${row.name}${row.status ? ` (${row.status})` : ''}`);
      if (clients.has('claude')) info(`  Claude Code: url "\${OS_API_BASE}${path}", header "Authorization: Bearer \${${TOKEN_ENV}}"`);
      if (clients.has('codex')) info(`  Codex:       url "${base}${path}", bearer_token_env_var = "${TOKEN_ENV}"`);
      if (o.dryRun) return;
      if (!(await ownerConfirms(`Write ${name} into your MCP configs (backups: *${BACKUP_SUFFIX})?`))) { info('nothing written'); return; }
      if (clients.has('claude')) {
        const doc = readClaudeDoc(paths.claude) ?? {};
        const servers = (doc['mcpServers'] && typeof doc['mcpServers'] === 'object' ? doc['mcpServers'] : {}) as Record<string, unknown>;
        servers[name] = claudeServer(path);
        doc['mcpServers'] = servers;
        backupAndWrite(paths.claude, `${JSON.stringify(doc, null, 2)}\n`);
      }
      if (clients.has('codex')) backupAndWrite(paths.codex, upsertCodexTable(readCodexToml(paths.codex) ?? '', name, `${base}${path}`));
      ok(`added ${name}. Running Claude Code or Codex sessions see it after a restart (Claude Code: /mcp).`);
    });

  mcp
    .command('fix')
    .description('Rewrite tokenless and literal-token Aura MCP entries to the token by reference (backup first)')
    .option('-n, --dry-run', 'show what would change, write nothing')
    .action(async (o: { dryRun?: boolean }) => {
      const paths = defaultMcpPaths();
      let claudeDoc: Record<string, unknown> | null;
      let codexToml: string | null;
      try {
        claudeDoc = readClaudeDoc(paths.claude);
        codexToml = readCodexToml(paths.codex);
      } catch (err) { fail(`could not read the configs: ${(err as Error).message}`); }
      const claude = claudeDoc ? fixClaude(claudeDoc) : null;
      const codex = codexToml !== null ? fixCodex(codexToml) : null;
      const fixed = [...(claude?.fixed ?? []), ...(codex?.fixed ?? [])];
      for (const e of codex?.manual ?? []) {
        warn(`codex ${e.name}: a literal AuraOS token in an inline http_headers with other headers: edit ${paths.codex} by hand `
          + `(remove Authorization, add bearer_token_env_var = "${TOKEN_ENV}")`);
      }
      if (fixed.length === 0) { ok('nothing to fix: every Aura MCP entry has its token by reference'); return; }
      for (const e of fixed) info(`  ${e.client} ${e.scope} ${color.bold(e.name)}: ${AUTH_TEXT[e.auth]} → token by reference ($${TOKEN_ENV})`);
      if (fixed.some((e) => e.auth === 'literal-token')) {
        warn('A literal token was in a file every app can read: it is removed here, and its instance\'s token changes at its next start.');
      }
      if (o.dryRun) return;
      if (!(await ownerConfirms(`Rewrite ${fixed.length} entr${fixed.length === 1 ? 'y' : 'ies'} (backups: *${BACKUP_SUFFIX})?`))) { info('nothing written'); return; }
      if (claude?.fixed.length) backupAndWrite(paths.claude, `${JSON.stringify(claude.doc, null, 2)}\n`);
      if (codex?.fixed.length) backupAndWrite(paths.codex, codex.toml);
      ok(`fixed ${fixed.length}. Restart running Claude Code or Codex sessions to use it.`);
    });
}
