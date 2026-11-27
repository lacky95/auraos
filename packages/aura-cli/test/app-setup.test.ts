// D108 `aura app setup|config|profile` against a fake shell on loopback:
// the request bodies, exit codes 0/3/5/75 (a TTY waits for the owner and
// resumes, an agent exits 75 with the request id and how to resume), secrets
// only as vault handles, -o json, and no `--yes`. Also the `aura dev
// validate` setup lint and the SETUP column of `aura get apps`.
//
//   pnpm --filter @aura/cli test
import './helpers/isolated-env.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { AppManifestSchema } from '@aura/core';
import { EXIT_INVALID_INPUT, EXIT_NEEDS_SETUP, registerAppSetup } from '../src/commands/app-setup.js';
import { EXIT_ON_HOLD } from '../src/lib/approval.js';
import { issueText, lintSetup } from '../src/lib/apphost-lint.js';
import { setupStateCell } from '../src/lib/resources.js';

const ENV = ['AURA_SHELL_URL', 'OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_WAIT_ON_HOLD', 'NO_COLOR'];
const APP = 'com.example.mailer';
const BASE = `/api/apps/${APP}/setup`;
const APR = 'apr_CCCCCCCCCCCCCCCCCCCCCC';
const HANDLE = 'cred_0123456789abcdefghijkl';
const SECRET_VALUE = 'hunter2-not-a-handle';

interface Seen { method: string; url: string; body: unknown }
type Handler = (r: Seen) => [number, unknown];
const servers: http.Server[] = [];
const saved: Record<string, string | undefined> = {};
const originalExit = process.exit;

async function fakeShell(handler: Handler): Promise<Seen[]> {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rec: Seen = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined };
    seen.push(rec);
    const [status, body] = handler(rec);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  process.env['AURA_SHELL_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return seen;
}

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env['NO_COLOR'] = '1';
  process.env['AURA_INSTANCE_TOKEN'] = 'aura1.instance-token';
  process.env['APP_INSTANCE_ID'] = 'com.aura.terminal-1';
  process.exit = ((code?: number) => { throw new Error(`exit ${code}`); }) as typeof process.exit;
});

afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.exit = originalExit;
  for (const s of servers.splice(0)) s.close();
});

/** Run `aura app …`: its exit code and everything it printed (stdout, stderr). */
async function run(...args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  const out: string[] = [];
  const stdout: string[] = [];
  const [log, err, write, ewrite] = [console.log, console.error, process.stdout.write, process.stderr.write];
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); stdout.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
  // Strings are the CLI's; the test runner's own reports (buffers) pass through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk !== 'string') return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
    out.push(chunk); stdout.push(chunk); return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stderr.write;
  const program = new Command();
  program.exitOverride();
  const app = program.command('app');
  app.exitOverride();
  registerAppSetup(app);
  for (const c of app.commands) { c.exitOverride(); for (const s of c.commands) s.exitOverride(); }
  let code: number | null = null;
  try {
    await program.parseAsync(['node', 'aura', 'app', ...args]);
  } catch (e) {
    const m = /^exit (\d+)$/.exec((e as Error).message);
    if (!m) throw Object.assign(e as Error, { output: out.join('') });
    code = Number(m[1]);
  } finally {
    console.log = log; console.error = err; process.stdout.write = write; process.stderr.write = ewrite;
  }
  return { code, out: out.join(''), stdout: stdout.join('') };
}

const state = (over: Record<string, unknown> = {}) => ({
  appId: APP, installationId: 'inst-1', declares: true, state: 'ready', profile: 'personal', step: 'done', configDigest: 'd', degraded: [], ...over,
});
const outcome = (status: string, over: Record<string, unknown> = {}) => ({ status, state: state(), ...over });
const valuesView = {
  appId: APP, profile: null, desired: null, effective: null, degraded: [],
  fields: [
    { name: 'smtpHost', field: { type: 'string', title: 'SMTP host' } },
    { name: 'password', field: { type: 'secret', title: 'SMTP password' }, hasSecret: false },
  ],
};

async function valuesFile(v: unknown): Promise<string> {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'aura-setup-')), 'v.json');
  writeFileSync(f, JSON.stringify(v));
  return f;
}

// ── setup ───────────────────────────────────────────────────────────────────

test('setup sends profile, values and secret handles to apply; ready → exit 0', async () => {
  const seen = await fakeShell((r) => {
    if (r.url === `${BASE}/values`) return [200, valuesView];
    if (r.url === `${BASE}/apply`) return [200, outcome('ready')];
    return [404, {}];
  });
  const file = await valuesFile({ smtpHost: 'mail.example', smtpPort: 587 });
  const r = await run('setup', APP, '--profile', 'personal', '--values', file, '--secret', `password=@vault:${HANDLE}`);
  assert.equal(r.code, 0, r.out);
  const apply = seen.find((s) => s.url === `${BASE}/apply`);
  assert.deepEqual(apply?.body, { profile: 'personal', values: { smtpHost: 'mail.example', smtpPort: 587 }, secrets: { password: HANDLE } });
  assert.match(r.out, /ready/);
});

test('a secret as a value on the command line is refused (exit 5), never sent and never echoed', async () => {
  const seen = await fakeShell(() => [200, outcome('ready')]);
  const r = await run('setup', APP, '--secret', `password=${SECRET_VALUE}`);
  assert.equal(r.code, EXIT_INVALID_INPUT);
  assert.equal(seen.length, 0);
  assert.ok(!r.out.includes(SECRET_VALUE), 'the value is not printed');
  assert.match(r.out, /vault handle/);
  const r2 = await run('setup', APP, '--secret', 'password=@vault:not-a-handle');
  assert.equal(r2.code, EXIT_INVALID_INPUT);
});

test('a plain value for a secret field (values file, config set) is refused before anything is sent', async () => {
  const seen = await fakeShell((r) => (r.url === `${BASE}/values` && r.method === 'GET' ? [200, valuesView] : [200, outcome('ready')]));
  const file = await valuesFile({ password: SECRET_VALUE });
  const r = await run('setup', APP, '--values', file);
  assert.equal(r.code, EXIT_INVALID_INPUT);
  assert.ok(!r.out.includes(SECRET_VALUE));
  const r2 = await run('config', 'set', APP, `password=${SECRET_VALUE}`);
  assert.equal(r2.code, EXIT_INVALID_INPUT);
  assert.ok(!r2.out.includes(SECRET_VALUE));
  assert.equal(seen.filter((s) => s.method !== 'GET').length, 0);
});

test('non-interactive without --profile: the server\'s profile-required → exit 3 and the suggestion', async () => {
  await fakeShell((r) => {
    if (r.url === `${BASE}/apply`) {
      return [409, { error: 'profile-required', category: 'needs-setup', message: `${APP} has several feasible profiles`, suggest: ['personal', 'personal-private'] }];
    }
    return [404, {}];
  });
  const r = await run('setup', APP);
  assert.equal(r.code, EXIT_NEEDS_SETUP);
  assert.match(r.out, /personal, personal-private/);
  assert.match(r.out, /--profile/);
});

test('invalid input from the server (422 config-invalid) → exit 5 with the field reasons', async () => {
  await fakeShell((r) => (r.url === `${BASE}/apply`
    ? [422, { error: 'config-invalid', category: 'invalid-request', message: 'invalid fields', fieldErrors: { smtpPort: 'must be at most 65535' } }]
    : [404, {}]));
  const r = await run('setup', APP, '--profile', 'personal');
  assert.equal(r.code, EXIT_INVALID_INPUT);
  assert.match(r.out, /smtpPort: must be at most 65535/);
});

test('blocked (refused outcome, needs-setup) → exit 3; -o json prints the outcome as one JSON document', async () => {
  const body = outcome('refused', { state: state({ state: 'blocked' }), error: { error: 'setup-blocked', category: 'needs-setup', message: 'home.private was revoked', missing: ['home.private'] } });
  await fakeShell((r) => (r.url === `${BASE}/apply` ? [409, body] : [404, {}]));
  const r = await run('setup', APP, '--profile', 'personal', '-o', 'json');
  assert.equal(r.code, EXIT_NEEDS_SETUP);
  assert.deepEqual(JSON.parse(r.stdout), body);
});

test('an agent without a TTY: on hold → exit 75 with the request id and how to resume; nothing waited for', async () => {
  const seen = await fakeShell((r) => (r.url === `${BASE}/apply` ? [202, outcome('on-hold', { approvalId: APR, state: state({ state: 'awaiting-approval' }) })] : [404, {}]));
  const r = await run('setup', APP, '--profile', 'personal');
  assert.equal(r.code, EXIT_ON_HOLD);
  assert.match(r.out, new RegExp(APR));
  assert.match(r.out, new RegExp(`aura app setup ${APP} --resume`));
  const line = r.stdout.split('\n').find((l) => l.startsWith('{"approval"'));
  assert.ok(line, r.out);
  assert.equal(JSON.parse(line!).approval.outcome, 'on_hold');
  assert.equal(seen.filter((s) => s.url.startsWith('/api/approvals/')).length, 0, 'an agent does not poll');
  assert.equal(seen.filter((s) => s.url.endsWith('/resume')).length, 0);

  const j = await run('setup', APP, '--profile', 'personal', '-o', 'json');
  assert.equal(j.code, EXIT_ON_HOLD);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.status, 'on-hold');
  assert.equal(doc.approvalId, APR);
  assert.equal(doc.resume, `aura app setup ${APP} --resume`);
});

test('a TTY waits for the owner\'s decision, then resumes the recorded run → exit 0', async () => {
  process.env['AURA_WAIT_ON_HOLD'] = '1';
  const seen = await fakeShell((r) => {
    if (r.url === `${BASE}/apply`) return [202, outcome('on-hold', { approvalId: APR })];
    if (r.url === `/api/approvals/${APR}`) return [200, { id: APR, state: 'approved' }];
    if (r.url === `${BASE}/resume`) return [200, outcome('ready')];
    return [404, {}];
  });
  const r = await run('setup', APP, '--profile', 'personal');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [`POST ${BASE}/apply`, `GET /api/approvals/${APR}`, `POST ${BASE}/resume`]);
});

test('a TTY and a denial: exit 3, the setup is not done', async () => {
  process.env['AURA_WAIT_ON_HOLD'] = '1';
  await fakeShell((r) => {
    if (r.url === `${BASE}/apply`) return [202, outcome('on-hold', { approvalId: APR })];
    if (r.url === `/api/approvals/${APR}`) return [200, { id: APR, state: 'denied' }];
    return [404, {}];
  });
  const r = await run('setup', APP, '--profile', 'personal');
  assert.equal(r.code, EXIT_NEEDS_SETUP);
  assert.match(r.out, /denied/);
});

test('--resume posts resume; with --profile/--values it is refused (exit 5)', async () => {
  const seen = await fakeShell((r) => (r.url === `${BASE}/resume` ? [200, outcome('ready')] : [404, {}]));
  assert.equal((await run('setup', APP, '--resume')).code, 0);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [`POST ${BASE}/resume`]);
  assert.equal((await run('setup', APP, '--resume', '--profile', 'x')).code, EXIT_INVALID_INPUT);
});

test('there is no --yes or --force: an approval is never skipped', async () => {
  await fakeShell(() => [200, outcome('ready')]);
  for (const flag of ['--yes', '--force', '-y']) {
    await assert.rejects(run('setup', APP, flag), (e: Error & { code?: string }) => {
      assert.equal(e.code, 'commander.unknownOption', flag);
      return true;
    });
  }
});

test('an unknown -o format is invalid input (exit 5)', async () => {
  await fakeShell(() => [200, outcome('ready')]);
  assert.equal((await run('setup', APP, '-o', 'yaml')).code, EXIT_INVALID_INPUT);
});

test('503 unavailable (no setup engine) is exit 1 with its hint', async () => {
  await fakeShell(() => [503, { error: 'unavailable', category: 'unavailable', message: 'the app setup engine is not available on this AuraOS', hint: 'update AuraOS' }]);
  const r = await run('setup', APP, '--profile', 'personal');
  assert.equal(r.code, 1);
  assert.match(r.out, /not available/);
});

// ── config and profiles ─────────────────────────────────────────────────────

test('config get: secrets as handles only; -o json is {state, values}', async () => {
  const view = {
    ...valuesView, profile: 'personal',
    desired: { values: { smtpHost: 'mail.example' }, secrets: { password: HANDLE }, overrides: {}, setupVersion: 1 },
    effective: { values: { smtpHost: 'mail.example' }, secrets: { password: HANDLE }, configDigest: 'd' },
  };
  await fakeShell((r) => (r.url === BASE ? [200, state()] : r.url === `${BASE}/values` ? [200, view] : [404, {}]));
  const r = await run('config', 'get', APP);
  assert.equal(r.code, null, r.out);
  assert.match(r.out, new RegExp(`@vault:${HANDLE}`));
  assert.match(r.out, /mail\.example/);
  const j = await run('config', 'get', APP, '-o', 'json');
  assert.deepEqual(JSON.parse(j.stdout), { state: state(), values: view });
});

test('config set: field=value typed, @vault handles as secrets, PUT values; a privilege change is refused (exit 3)', async () => {
  let refuse = false;
  const seen = await fakeShell((r) => {
    if (r.method === 'GET' && r.url === `${BASE}/values`) return [200, valuesView];
    if (r.method === 'PUT') {
      return refuse
        ? [409, { status: 'refused', state: state(), error: { error: 'requirement-unauthorized', category: 'missing-permission', message: 'adds privileges: use aura app setup' } }]
        : [200, outcome('ready')];
    }
    return [404, {}];
  });
  assert.equal((await run('config', 'set', APP, 'smtpHost=mail.example', 'smtpPort=2525', 'tls=true', `password=@vault:${HANDLE}`)).code, 0);
  assert.deepEqual(seen.find((s) => s.method === 'PUT')?.body, { values: { smtpHost: 'mail.example', smtpPort: 2525, tls: true }, secrets: { password: HANDLE } });
  refuse = true;
  assert.equal((await run('config', 'set', APP, 'smtpHost=x')).code, EXIT_NEEDS_SETUP);
  assert.equal((await run('config', 'set', APP)).code, EXIT_INVALID_INPUT, 'nothing to set');
});

test('profile ls: availability and reasons; -o json is the ProfileOption list', async () => {
  const profiles = [
    { id: 'personal', title: 'Personal', recommended: true, available: true, reasons: [] },
    { id: 'team', title: 'Team', recommended: false, available: false, reasons: [{ error: 'profile-unavailable', category: 'unsupported-feature', message: 'shared instances arrive with multi-user (BT-M2)' }] },
  ];
  await fakeShell((r) => (r.url === `${BASE}/profiles` ? [200, profiles] : r.url === BASE ? [200, state()] : [404, {}]));
  const r = await run('profile', 'ls', APP);
  assert.match(r.out, /team/);
  assert.match(r.out, /shared instances arrive with multi-user/);
  assert.deepEqual(JSON.parse((await run('profile', 'ls', APP, '-o', 'json')).stdout), profiles);
});

test('profile use: shows what the plan adds, then reconfigures with the profile', async () => {
  const plan = {
    approval: { adds: { permissions: [], tools: [], context: [], homePrivate: true, homePrivateSidecars: ['terminal'] } },
    grantDiff: { added: ['home:private'], removed: ['home:app'], changed: true }, compatibility: [],
    dataStaysBehind: [{ kind: 'app-home', where: 'Mailer\'s App Home', why: 'kept, not copied' }],
    note: 'Data stays where it is: nothing is copied, moved or re-owned by this change. Copying is a separate, explicit action.',
  };
  const seen = await fakeShell((r) => {
    if (r.url === `${BASE}/change`) return [200, plan];
    if (r.url === `${BASE}/reconfigure`) return [202, outcome('on-hold', { approvalId: APR })];
    return [404, {}];
  });
  const r = await run('profile', 'use', APP, 'personal-private');
  assert.equal(r.code, EXIT_ON_HOLD);
  assert.match(r.out, /Private Home for sidecar terminal/);
  assert.match(r.out, /- home:app/);
  assert.match(r.out, /Stays behind \(not copied\):\n  · Mailer's App Home: kept, not copied/);
  assert.deepEqual(seen.find((s) => s.url === `${BASE}/reconfigure`)?.body, { profile: 'personal-private' });
});

// ── P8: restore-last, the Private Home revocation ───────────────────────────

test('config restore-last: shows what is restored and that data is not rolled back, then posts restore (on hold → 75)', async () => {
  const notice = 'Restoring the last applied configuration does not roll back app data or anything the app did outside AuraOS.';
  const seen = await fakeShell((r) => {
    if (r.method === 'GET' && r.url === `${BASE}/restore`) {
      return [200, { lastApplied: { appId: APP, profile: 'personal', configDigest: 'd', appliedAt: '2026-11-27T00:00:00Z', current: false, values: {}, secretFields: [], notice }, notice }];
    }
    if (r.method === 'POST' && r.url === `${BASE}/restore`) return [202, outcome('on-hold', { approvalId: APR, notice })];
    return [404, {}];
  });
  const r = await run('config', 'restore-last', APP);
  assert.equal(r.code, EXIT_ON_HOLD);
  assert.match(r.out, /does not roll back app data/);
  assert.match(r.out, /profile personal/);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [`GET ${BASE}/restore`, `POST ${BASE}/restore`]);

  await fakeShell((rq) => (rq.method === 'GET' ? [200, { lastApplied: null, notice }] : [404, {}]));
  assert.equal((await run('config', 'restore-last', APP)).code, EXIT_NEEDS_SETUP);
});

test('config revoke-private-home: DELETE (all, or --sidecar); blocked state shown; a refusal → its exit code', async () => {
  const seen = await fakeShell((r) => {
    if (r.method === 'DELETE' && r.url.startsWith(`${BASE}/home-private`)) return [200, { revoked: ['home.private'], state: state({ state: 'blocked' }) }];
    return [404, {}];
  });
  const r = await run('config', 'revoke-private-home', APP);
  assert.equal(r.code, null);
  assert.match(r.out, /revoked home\.private; com\.example\.mailer is blocked/);
  await run('config', 'revoke-private-home', APP, '--sidecar', 'terminal');
  assert.deepEqual(seen.map((s) => s.url), [`${BASE}/home-private`, `${BASE}/home-private?sidecar=terminal`]);

  await fakeShell(() => [409, { error: 'setup-blocked', category: 'needs-setup', message: 'not available' }]);
  assert.equal((await run('config', 'revoke-private-home', APP)).code, EXIT_NEEDS_SETUP);
});

// ── dev validate and get apps ───────────────────────────────────────────────

const manifest = (extra: Record<string, unknown>) => AppManifestSchema.parse({
  id: 'com.example.lint', name: 'Lint', version: '1.0.0', ...extra,
});

test('dev validate: a required feature or grant under a field condition warns; under a profile condition it does not', () => {
  const m = manifest({
    setup: {
      fields: { auth: { type: 'string', title: 'Sign-in', enum: ['native', 'aura'], default: 'native' } },
      requirements: [
        { feature: 'network.isolation', level: 'required', when: { field: 'auth', in: ['aura'] } },
        { feature: 'network.isolation', level: 'optional', when: { field: 'auth', in: ['aura'] } },
        { capability: 'git', level: 'required', when: { field: 'auth', in: ['aura'] } },
      ],
    },
    profiles: [
      { id: 'a', title: 'A', setup: { requirements: [{ grant: 'home.private', level: 'required', when: { field: 'auth', equals: 'aura' } }] } },
      { id: 'b', title: 'B', setup: { requirements: [{ grant: 'home.private', level: 'required', when: { profile: ['b'] } }] } },
    ],
  });
  const text = JSON.stringify(m, null, 2);
  const f = lintSetup('app.manifest.json', text, m);
  assert.equal(f.length, 2, JSON.stringify(f));
  assert.ok(f.every((x) => x.severity === 'warn' && x.rule === 'setup'));
  assert.match(f[0]!.message, /feature network\.isolation .* field auth is aura/);
  assert.match(f[1]!.message, /grant home\.private/);
  assert.deepEqual(lintSetup('app.manifest.json', '{}', manifest({})), [], 'a simple app: nothing');
});

test('dev validate: an overlay key outside the allowlist is a schema error that names the key', () => {
  const r = AppManifestSchema.safeParse({
    id: 'com.example.lint', name: 'Lint', version: '1.0.0', profiles: [{ id: 'a', title: 'A', overlay: { image: 'evil:latest' } }],
  });
  assert.equal(r.success, false);
  const text = r.success ? '' : r.error.issues.map(issueText).join('; ');
  assert.match(text, /a profile overlay may only set/);
  assert.match(text, /not allowed: image/);
});

test('get apps SETUP column: - without setup, the state otherwise', () => {
  assert.equal(setupStateCell(undefined), '-');
  assert.match(setupStateCell('ready'), /ready/);
  assert.match(setupStateCell('blocked'), /blocked/);
});
