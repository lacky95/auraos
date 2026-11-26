// `aura mcp` (D89 B5): Aura MCP entries carry the instance token by
// reference, never by value. Classification, the rewrite of both configs,
// the backups (never a literal token) and the commands' refusal to write
// without the owner at a terminal.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  BACKUP_SUFFIX, CLAUDE_AUTH_REF, backupAndWrite, claudeEntries, claudeServer, codexEntries, fixClaude, fixCodex,
  listMcpEntries, redactAuraCredentials, upsertCodexTable,
} from '../src/lib/mcp-config.js';
import { registerMcp } from '../src/commands/mcp.js';

// Fake values only: shaped like AuraOS credentials, never real ones.
const FAKE_TOKEN = 'aura1.eyJpIjoiZmFrZSJ9.ZmFrZS1tYWM';
const FAKE_KEY = 'aura_k1_fakefakefake';

const claudeDoc = () => ({
  numStartups: 3,
  mcpServers: {
    projector: { type: 'http', url: 'http://aura-shell:3000/api/proxy/io.lakner.projector/mcp' },
    docs: { type: 'http', url: '${OS_API_BASE}/api/proxy/com.aura.docs/mcp', headers: { Authorization: CLAUDE_AUTH_REF } },
    leaked: { type: 'http', url: 'http://aura-shell:3000/api/proxy/com.aura.excalidraw/mcp', headers: { authorization: `Bearer ${FAKE_TOKEN}`, 'x-other': '1' } },
    helper: { type: 'http', url: 'http://aura-shell:3000/api/proxy/a.b/mcp', headersHelper: '/x/h.sh' },
    github: { type: 'http', url: 'https://api.github.com/mcp', headers: { Authorization: 'Bearer ghp_x' } },
    other: { type: 'http', url: 'http://aura-shell:3000/api/proxy/a.c/mcp', headers: { Authorization: 'Basic abc' } },
  },
  projects: { '/home/aura/p': { mcpServers: { local: { type: 'http', url: 'http://h/api/proxy/a.d/mcp' } } } },
});

test('Claude Code: Aura entries classified, non-Aura ones ignored, no value returned', () => {
  const entries = claudeEntries(claudeDoc());
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(by).sort(), ['docs', 'helper', 'leaked', 'local', 'other', 'projector']);
  assert.equal(by['projector']!.auth, 'tokenless');
  assert.equal(by['docs']!.auth, 'reference');
  assert.equal(by['docs']!.env, 'AURA_INSTANCE_TOKEN');
  assert.equal(by['leaked']!.auth, 'literal-token');
  assert.equal(by['helper']!.auth, 'helper');
  assert.equal(by['other']!.auth, 'literal-other');
  assert.equal(by['local']!.scope, 'project:/home/aura/p');
  assert.ok(!JSON.stringify(entries).includes(FAKE_TOKEN), 'no entry carries the value');
});

test('Claude Code fix: tokenless and literal-token entries get the reference; everything else stays', () => {
  const { doc, fixed } = fixClaude(claudeDoc());
  assert.deepEqual(fixed.map((e) => e.name).sort(), ['leaked', 'local', 'projector']);
  const servers = doc['mcpServers'] as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers['leaked']!['headers'], { 'x-other': '1', Authorization: CLAUDE_AUTH_REF });
  assert.deepEqual(servers['projector']!['headers'], { Authorization: CLAUDE_AUTH_REF });
  assert.deepEqual(servers['github']!['headers'], { Authorization: 'Bearer ghp_x' }, 'not an Aura entry');
  assert.deepEqual(servers['other']!['headers'], { Authorization: 'Basic abc' }, 'a literal non-Aura value is not ours to change');
  assert.equal(doc['numStartups'], 3);
  assert.ok(!JSON.stringify(doc).includes(FAKE_TOKEN));
  assert.ok(claudeEntries(doc).every((e) => e.auth !== 'tokenless' && e.auth !== 'literal-token'));
});

test('Claude Code add: base and token both by reference', () => {
  assert.deepEqual(claudeServer('/api/proxy/com.aura.docs/mcp'), {
    type: 'http', url: '${OS_API_BASE}/api/proxy/com.aura.docs/mcp', headers: { Authorization: 'Bearer ${AURA_INSTANCE_TOKEN}' },
  });
});

const TOML = `model = "x"
notify = ["bash", "/h.sh", "codex"]

[mcp_servers.aura-docs]
url = "http://aura-shell:3000/api/proxy/com.aura.docs/mcp"

[mcp_servers."aura-interfaces"]
url = "http://aura-shell:3000/api/proxy/com.aura.settings/mcp/interfaces"
bearer_token_env_var = "AURA_INSTANCE_TOKEN"

[mcp_servers.leak]
url = "http://aura-shell:3000/api/proxy/a.b/mcp"
bearer_token = "${FAKE_TOKEN}"

[mcp_servers.leak2]
url = "http://aura-shell:3000/api/proxy/a.c/mcp"
http_headers = { "Authorization" = "Bearer ${FAKE_KEY}" }

[mcp_servers.leak3]
url = "http://aura-shell:3000/api/proxy/a.d/mcp"

[mcp_servers.leak3.http_headers]
Authorization = "Bearer ${FAKE_TOKEN}"
X-Keep = "1"

[mcp_servers.mixed]
url = "http://aura-shell:3000/api/proxy/a.e/mcp"
http_headers = { "Authorization" = "Bearer ${FAKE_TOKEN}", "X-Other" = "1" }

[mcp_servers.github]
command = "gh-mcp"

[profiles.fast]
model = "y"
`;

test('Codex: Aura tables classified (quoted names, sub-tables, inline headers), never a value', () => {
  const by = Object.fromEntries(codexEntries(TOML).map((e) => [e.name, e]));
  assert.deepEqual(Object.keys(by).sort(), ['aura-docs', 'aura-interfaces', 'leak', 'leak2', 'leak3', 'mixed']);
  assert.equal(by['aura-docs']!.auth, 'tokenless');
  assert.equal(by['aura-interfaces']!.auth, 'reference');
  assert.equal(by['leak']!.auth, 'literal-token');
  assert.equal(by['leak2']!.auth, 'literal-token');
  assert.equal(by['leak3']!.auth, 'literal-token');
  assert.ok(!JSON.stringify(by).includes('aura1.') && !JSON.stringify(by).includes(FAKE_KEY));
});

test('Codex fix: bearer_token_env_var in, literal tokens out, the rest of the file byte for byte', () => {
  const { toml, fixed, manual } = fixCodex(TOML);
  assert.deepEqual(fixed.map((e) => e.name).sort(), ['aura-docs', 'leak', 'leak2', 'leak3']);
  assert.deepEqual(manual.map((e) => e.name), ['mixed'], 'an inline table with other headers is left for a hand edit');
  assert.ok(!toml.replace(/\[mcp_servers\.mixed\][\s\S]*?\n\n/, '').includes('aura1.'), 'no literal token outside the manual one');
  assert.ok(!toml.includes(FAKE_KEY));
  assert.match(toml, /\[mcp_servers\.aura-docs\]\nbearer_token_env_var = "AURA_INSTANCE_TOKEN"\nurl = /);
  assert.match(toml, /\[mcp_servers\.leak3\.http_headers\]\nX-Keep = "1"/);
  assert.ok(toml.startsWith('model = "x"\nnotify = ["bash", "/h.sh", "codex"]\n'));
  assert.ok(toml.endsWith('[profiles.fast]\nmodel = "y"\n'));
  const again = codexEntries(toml).filter((e) => e.name !== 'mixed');
  assert.ok(again.every((e) => e.auth === 'reference'), 'everything fixed reads as a reference');
});

test('Codex add: a new table, or the named one replaced (its literal header sub-table entry too)', () => {
  const added = upsertCodexTable('model = "x"\n', 'aura-docs', 'http://s:3000/api/proxy/com.aura.docs/mcp');
  assert.equal(added, 'model = "x"\n\n[mcp_servers.aura-docs]\nurl = "http://s:3000/api/proxy/com.aura.docs/mcp"\nbearer_token_env_var = "AURA_INSTANCE_TOKEN"\n');
  const replaced = upsertCodexTable(TOML, 'leak3', 'http://s:3000/api/proxy/a.d/mcp');
  assert.ok(!/leak3[\s\S]*Authorization = "Bearer aura1/.test(replaced));
  assert.match(replaced, /\[mcp_servers\.leak3\]\nurl = "http:\/\/s:3000\/api\/proxy\/a\.d\/mcp"\nbearer_token_env_var = "AURA_INSTANCE_TOKEN"\n\n\[mcp_servers\.leak3\.http_headers\]\nX-Keep = "1"/);
  assert.equal(upsertCodexTable('', 'x', 'http://s/api/proxy/a/mcp'), '[mcp_servers.x]\nurl = "http://s/api/proxy/a/mcp"\nbearer_token_env_var = "AURA_INSTANCE_TOKEN"\n');
});

test('backups never keep an AuraOS credential, and keep the owner-only mode', () => {
  assert.equal(redactAuraCredentials(`a Bearer ${FAKE_TOKEN} b ${FAKE_KEY}`), 'a Bearer REMOVED-AURA-CREDENTIAL b REMOVED-AURA-CREDENTIAL');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  const p = join(dir, 'config.toml');
  writeFileSync(p, TOML, { mode: 0o600 });
  const backup = backupAndWrite(p, fixCodex(TOML).toml);
  assert.equal(backup, `${p}${BACKUP_SUFFIX}`);
  const saved = readFileSync(backup!, 'utf-8');
  assert.ok(!saved.includes('aura1.') && !saved.includes(FAKE_KEY));
  assert.equal(statSync(backup!).mode & 0o777, 0o600);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(backupAndWrite(p, readFileSync(p, 'utf-8')), null, 'no change, no write');
});

async function runCli(args: string[], home: string): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log; const warnFn = console.warn; const errFn = console.error;
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  const prevHome = process.env['HOME'];
  process.env['HOME'] = home;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { err.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    const program = new Command().exitOverride();
    registerMcp(program);
    await program.parseAsync(['node', 'aura', 'mcp', ...args]);
  } finally {
    console.log = log; console.warn = warnFn; console.error = errFn;
    process.stdout.write = write; process.stderr.write = ewrite;
    if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

test('aura mcp ls / fix: classification only, and no write without the owner at a terminal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  const prevCodex = process.env['CODEX_HOME'];
  delete process.env['CODEX_HOME'];
  try {
    writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeDoc(), null, 2));
    const ls = await runCli(['ls', '-o', 'json'], home);
    const listed = JSON.parse(ls.out) as { entries: Array<{ name: string; auth: string }> };
    assert.equal(listed.entries.find((e) => e.name === 'leaked')?.auth, 'literal-token');
    assert.ok(!ls.out.includes(FAKE_TOKEN) && !ls.err.includes(FAKE_TOKEN), 'ls never prints a value');
    const dry = await runCli(['fix', '--dry-run'], home);
    assert.ok(!dry.out.includes(FAKE_TOKEN) && !dry.err.includes(FAKE_TOKEN), 'fix never prints a value');
    const before = readFileSync(join(home, '.claude.json'), 'utf-8');
    await runCli(['fix'], home);   // tests have no TTY: the owner can't confirm here
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf-8'), before, 'nothing written without a confirmation');
    assert.equal(existsSync(join(home, `.claude.json${BACKUP_SUFFIX}`)), false);
    assert.equal(listMcpEntries({ claude: join(home, '.claude.json'), codex: join(home, 'none.toml') }).length, 6);
  } finally {
    if (prevCodex !== undefined) process.env['CODEX_HOME'] = prevCodex;
  }
});
