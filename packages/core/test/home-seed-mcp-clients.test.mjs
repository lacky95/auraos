// The optional client adapter the home seed ships (D96, os/home-seed/.aura/adapters/mcp-clients.mjs):
// Aura MCP entries in Claude Code's and Codex's configs move to the session credential by
// reference, never by value. Classification, the rewrite of both configs, the backups (never a
// literal token) and no write without a yes at a terminal. The core never imports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'os', 'home-seed', '.aura', 'adapters', 'mcp-clients.mjs');
const {
  BACKUP_SUFFIX, CLAUDE_AUTH_REF, backupAndWrite, claudeEntries, codexEntries, fixClaude, fixCodex,
  listEntries, main, redactAuraCredentials,
} = await import(ADAPTER);

// Fake values only: shaped like AuraOS credentials, never real ones (built at runtime for the security gate).
const FAKE_TOKEN = ['aura1', 'fake-claims', 'fake-mac'].join('.');
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
  assert.equal(by.projector.auth, 'tokenless');
  assert.equal(by.docs.auth, 'reference');
  assert.equal(by.docs.env, 'AURA_INSTANCE_TOKEN');
  assert.equal(by.leaked.auth, 'literal-token');
  assert.equal(by.helper.auth, 'helper');
  assert.equal(by.other.auth, 'literal-other');
  assert.equal(by.local.scope, 'project:/home/aura/p');
  assert.ok(!JSON.stringify(entries).includes(FAKE_TOKEN), 'no entry carries the value');
});

test('Claude Code fix: tokenless and literal-token entries get the reference; everything else stays', () => {
  const { doc, fixed } = fixClaude(claudeDoc());
  assert.deepEqual(fixed.map((e) => e.name).sort(), ['leaked', 'local', 'projector']);
  const servers = doc.mcpServers;
  assert.deepEqual(servers.leaked.headers, { 'x-other': '1', Authorization: CLAUDE_AUTH_REF });
  assert.deepEqual(servers.projector.headers, { Authorization: CLAUDE_AUTH_REF });
  assert.deepEqual(servers.github.headers, { Authorization: 'Bearer ghp_x' }, 'not an Aura entry');
  assert.deepEqual(servers.other.headers, { Authorization: 'Basic abc' }, 'a literal non-Aura value is not ours to change');
  assert.equal(doc.numStartups, 3);
  assert.ok(!JSON.stringify(doc).includes(FAKE_TOKEN));
  assert.ok(claudeEntries(doc).every((e) => e.auth !== 'tokenless' && e.auth !== 'literal-token'));
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
  assert.equal(by['aura-docs'].auth, 'tokenless');
  assert.equal(by['aura-interfaces'].auth, 'reference');
  assert.equal(by.leak.auth, 'literal-token');
  assert.equal(by.leak2.auth, 'literal-token');
  assert.equal(by.leak3.auth, 'literal-token');
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

test('backups never keep an AuraOS credential, and keep the owner-only mode', () => {
  assert.equal(redactAuraCredentials(`a Bearer ${FAKE_TOKEN} b ${FAKE_KEY}`), 'a Bearer REMOVED-AURA-CREDENTIAL b REMOVED-AURA-CREDENTIAL');
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  const p = join(dir, 'config.toml');
  writeFileSync(p, TOML, { mode: 0o600 });
  const backup = backupAndWrite(p, fixCodex(TOML).toml);
  assert.equal(backup, `${p}${BACKUP_SUFFIX}`);
  const saved = readFileSync(backup, 'utf-8');
  assert.ok(!saved.includes('aura1.') && !saved.includes(FAKE_KEY));
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(backupAndWrite(p, readFileSync(p, 'utf-8')), null, 'no change, no write');
});

test('ls / fix: classification only, and no write without a yes at a terminal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-home-'));
  const paths = { claude: join(home, '.claude.json'), codex: join(home, 'none.toml') };
  writeFileSync(paths.claude, JSON.stringify(claudeDoc(), null, 2));
  const run = async (argv) => {
    const out = []; const err = [];
    const code = await main(argv, { stdin: { isTTY: false }, stdout: { isTTY: false }, out: (s) => out.push(s), err: (s) => err.push(s) }, paths);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const ls = await run(['ls', '--json']);
  assert.equal(JSON.parse(ls.out).entries.find((e) => e.name === 'leaked')?.auth, 'literal-token');
  assert.ok(!ls.out.includes(FAKE_TOKEN) && !ls.err.includes(FAKE_TOKEN), 'ls never prints a value');
  const table = await run(['ls']);
  assert.ok(!table.out.includes(FAKE_TOKEN));
  const dry = await run(['fix', '--dry-run']);
  assert.ok(!dry.out.includes(FAKE_TOKEN) && !dry.err.includes(FAKE_TOKEN), 'fix never prints a value');
  const before = readFileSync(paths.claude, 'utf-8');
  await run(['fix']);   // no TTY: nobody can say yes here
  assert.equal(readFileSync(paths.claude, 'utf-8'), before, 'nothing written without a confirmation');
  assert.equal(existsSync(`${paths.claude}${BACKUP_SUFFIX}`), false);
  assert.equal(listEntries(paths).length, 6);
  assert.equal((await run(['nope'])).code, 64);
});

test('the core never imports the adapter (D96: product formats stay out of the kernel)', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const f of ['index.ts', 'app-manager/homeSeed.ts']) {
    const text = readFileSync(join(src, f), 'utf-8');
    assert.ok(!/claude\.json|config\.toml|mcp-clients/.test(text), `${f} names a product config`);
  }
});
