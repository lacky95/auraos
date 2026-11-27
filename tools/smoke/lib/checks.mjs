/**
 * The smoke checks. They assert shapes and required ids, never volatile counts.
 *
 * Report rule: a detail string holds only statuses, counts, field presence and
 * non-secret ids. Never copy a response value here unless it is one of those.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { GuardViolation, startGuardProxy } from './http.mjs';
import { TERMINAL_APP_ID } from './guard.mjs';

/** Workflows that change state or need fixtures. Never run on a live system. */
export const TEST_INSTANCE_WORKFLOWS = Object.freeze([
  ['pty-attach', 'PTY attach creates Terminal session state'],
  ['mcp-handshake', 'MCP handshake is a stateful POST'],
  ['activities', 'opening or closing an Activity changes desktop state'],
  ['flights', 'creating a Flight changes desktop state'],
  ['terminalx-embed', 'opening the embed creates a Terminal session'],
  ['nexus-install-update', 'install and update change installed apps'],
  ['jump', 'jump starts a shell inside a sandbox'],
  ['sidecar-mount-port-changes', 'these change running containers'],
  ['kv-writes', 'KV writes change stored state'],
  ['update-rollback', 'update and rollback restart the system'],
]);

/** The only CLI invocations the tool may run. All are read-only. */
export const ALLOWED_CLI_COMMANDS = Object.freeze([
  Object.freeze(['status']),
  Object.freeze(['get', 'apps', '-o', 'json']),
  Object.freeze(['get', 'inst', '-o', 'json']),
]);

/**
 * `aura get apps` also asks for /api/apps/serve to fill one table column. It is
 * outside the allowlist, so the proxy refuses it and the CLI tolerates that.
 */
const EXPECTED_CLI_REFUSALS = new Set(['GET /api/apps/serve']);

const CLAUDE_CREDENTIALS = '/home/aura/.claude/.credentials.json';
const EXCALIDRAW_APP_ID = 'io.lakner.excalidraw';
const TERMINALX_APP_ID = 'io.lakner.terminalx';
const SAFE_REPORT_ID = /^[\w.#:-]{1,128}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeId = (v) => (typeof v === 'string' && SAFE_REPORT_ID.test(v) ? v : '<unsafe-id>');
const hasPermission = (manifest, name) => Array.isArray(manifest?.permissions)
  && manifest.permissions.some((p) => p === name || p?.name === name);

const isRunning = (apps, appId) => Array.isArray(apps) && apps.some((a) => a?.manifest?.id === appId
  && (a.instances ?? []).some((i) => i?.state === 'resumed' && !i.inPool));

function findOnPath(name, env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

/** Run an allowlisted CLI command with a minimal env, so no token is inherited. */
function defaultRunCli(binary, args, shellUrl, env) {
  if (!ALLOWED_CLI_COMMANDS.some((c) => c.length === args.length && c.every((a, i) => a === args[i]))) {
    throw new GuardViolation('CLI', args.join(' '), 'command is not on the allowlist');
  }
  const childEnv = { PATH: env.PATH ?? '', AURA_SHELL_URL: shellUrl, NO_COLOR: '1' };
  if (env.HOME) childEnv.HOME = env.HOME;
  return new Promise((resolve) => {
    execFile(binary, args, { env: childEnv, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout) });
    });
  });
}

function recorder() {
  const results = [];
  const add = (status) => (id, tier, detail) => results.push({ id, tier, status, detail });
  return { results, pass: add('pass'), fail: add('fail'), skip: add('skip') };
}

async function snapshot(client, guard) {
  const out = { apps: [], activities: [], instances: [], sessions: {}, errors: [] };
  const apps = await client.getJson('/api/apps');
  if (!Array.isArray(apps.json)) {
    out.errors.push(`apps: ${apps.error ?? 'not an array'}`);
    return out;
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  out.apps = apps.json.map((a) => ({ id: safeId(a?.manifest?.id), enabled: Boolean(a?.enabled) })).sort(byId);
  out.activities = apps.json.flatMap((a) => a.activities ?? []).map((x) => safeId(x?.activityId)).sort();
  out.instances = apps.json
    .flatMap((a) => a.instances ?? [])
    .map((i) => ({
      id: safeId(i.instanceId),
      state: safeId(i.state),
      inPool: Boolean(i.inPool),
      sidecars: Number(i.sidecarCount) || 0,
    }))
    .sort(byId);
  for (const id of guard.runningTerminals().sort()) {
    const res = await client.getJson(`/api/proxy/${id}/api/sessions`);
    if (!Array.isArray(res.json?.sessions)) {
      out.errors.push(`sessions of ${id}: ${res.error ?? 'no sessions[]'}`);
      continue;
    }
    out.sessions[id] = res.json.sessions.map((s) => safeId(s?.id)).sort();
  }
  return out;
}

function diffIds(label, before, after, where = '') {
  const x = new Set(before);
  const y = new Set(after);
  return [
    ...[...x].filter((v) => !y.has(v)).map((v) => `${label} removed${where}: ${v}`),
    ...[...y].filter((v) => !x.has(v)).map((v) => `${label} added${where}: ${v}`),
  ];
}

export function diffSnapshots(before, after) {
  const ids = (list) => list.map((x) => x.id);
  const changes = [
    ...diffIds('app', ids(before.apps), ids(after.apps)),
    ...diffIds('activity', before.activities, after.activities),
    ...diffIds('instance', ids(before.instances), ids(after.instances)),
  ];
  const enabled = new Map(before.apps.map((a) => [a.id, a.enabled]));
  for (const a of after.apps) {
    if (enabled.has(a.id) && enabled.get(a.id) !== a.enabled) changes.push(`app ${a.id} enabled: ${enabled.get(a.id)} -> ${a.enabled}`);
  }
  const state = (i) => `${i.state}${i.inPool ? '/pool' : ''}`;
  const prior = new Map(before.instances.map((i) => [i.id, i]));
  for (const i of after.instances) {
    const p = prior.get(i.id);
    if (!p) continue;
    if (state(p) !== state(i)) changes.push(`instance ${i.id}: ${state(p)} -> ${state(i)}`);
    if (p.sidecars !== i.sidecars) changes.push(`instance ${i.id} sidecars: ${p.sidecars} -> ${i.sidecars}`);
  }
  for (const term of new Set([...Object.keys(before.sessions), ...Object.keys(after.sessions)])) {
    changes.push(...diffIds('session', before.sessions[term] ?? [], after.sessions[term] ?? [], ` on ${term}`));
  }
  return changes;
}

async function checkHttp(r, client, guard, apps, tier) {
  // A test instance need not have the owner's optional apps. Live stays strict.
  const absent = (appId) => tier === 'test-instance' && !isRunning(apps, appId);

  const about = await client.getJson('/api/os/about');
  if (typeof about.json?.version === 'string' && typeof about.json?.git?.commit === 'string') {
    r.pass('about', 'live', `version=${safeId(about.json.version)} commit=${safeId(about.json.git.commit)}`);
  } else r.fail('about', 'live', about.error ?? 'missing version or git.commit');

  const appsOk = Array.isArray(apps) && apps.every((a) => typeof a?.manifest?.id === 'string'
    && Array.isArray(a.instances) && Array.isArray(a.activities)
    && a.activities.every((x) => typeof x?.activityId === 'string'));
  if (appsOk && apps.some((a) => a.manifest.id === TERMINAL_APP_ID)) r.pass('apps', 'live', 'apps and activities[] have the expected shape');
  else r.fail('apps', 'live', 'unexpected shape, or the Terminal app is missing');

  const term = await client.getJson(`/api/apps/${TERMINAL_APP_ID}/instances`);
  if (Array.isArray(term.json) && term.json.some((i) => i?.state === 'resumed' && !i.inPool)) {
    r.pass('terminal-instance', 'live', 'non-pool resumed instance present');
  } else r.fail('terminal-instance', 'live', term.error ?? 'no non-pool resumed instance');

  const terminals = guard.runningTerminals();
  if (!terminals.length) r.skip('terminal-sessions', 'live', 'no running Terminal instance discovered');
  // The caller's own Terminals (its instance list is per user, D69): another user's answers 403 by design.
  const mine = new Set(Array.isArray(term.json) ? term.json.map((i) => i?.instanceId).filter(Boolean) : []);
  for (const id of terminals) {
    const res = await client.getJson(`/api/proxy/${id}/api/sessions`);
    if (Array.isArray(res.json?.sessions) && Array.isArray(res.json?.reserved)) {
      r.pass(`terminal-sessions:${id}`, 'live', 'sessions[] and reserved[] present');
    } else if (res.status === 403 && mine.size && !mine.has(id)) {
      r.pass(`terminal-sessions:${id}`, 'live', 'another user\'s Terminal: its sessions refused (D69)');
    } else r.fail(`terminal-sessions:${id}`, 'live', res.error ?? 'missing sessions[] or reserved[]');
  }

  const ifaces = await client.getJson('/api/interfaces?consumers=0');
  const list = ifaces.json?.interfaces;
  if (!Array.isArray(list)) r.fail('interfaces', 'live', ifaces.error ?? 'no interfaces[]');
  else {
    const live = (appId, name) => list.some((i) => i?.appId === appId && i?.name === name && i?.kind === 'http/mcp' && i?.status === 'live');
    const skipExcalidraw = absent(EXCALIDRAW_APP_ID);
    const required = [[TERMINAL_APP_ID, 'terminal'], ...(skipExcalidraw ? [] : [[EXCALIDRAW_APP_ID, 'mcp']])];
    const missing = required.filter(([a, n]) => !live(a, n)).map(([a, n]) => `${a}/${n}`);
    if (missing.length) r.fail('interfaces', 'live', `MCP not live: ${missing.join(', ')}`);
    else r.pass('interfaces', 'live', skipExcalidraw ? 'Terminal MCP is live' : 'Terminal and Excalidraw MCP are live');
    if (skipExcalidraw) r.skip('interfaces-excalidraw', 'test-instance', 'Excalidraw is not installed or running');
  }

  const flights = await client.getJson('/api/flights');
  if (Array.isArray(flights.json)) r.pass('flights', 'live', 'array');
  else r.fail('flights', 'live', flights.error ?? 'not an array');

  if (absent(TERMINALX_APP_ID)) r.skip('terminalx-status', 'test-instance', 'TerminalX is not installed or running');
  else {
    const tx = await client.getJson(`/api/instances/${TERMINALX_APP_ID}/status`);
    if (tx.json?.instance?.instanceId === TERMINALX_APP_ID) {
      r.pass('terminalx-status', 'live', `present, sandbox=${safeId(tx.json.instance.sandbox)} (recorded, not asserted)`);
    } else r.fail('terminalx-status', 'live', tx.error ?? 'instance missing from response');
  }

  const nexus = await client.getJson('/api/nexus/installed');
  if (Array.isArray(nexus.json) && nexus.json.every((e) => typeof e?.manifest?.id === 'string')) {
    r.pass('nexus-installed', 'live', `array, count=${nexus.json.length} (recorded, not asserted)`);
  } else r.fail('nexus-installed', 'live', nexus.error ?? 'unexpected shape');

  // Shape only: the items are notification content and are never inspected.
  const notes = await client.getJson('/api/notifications');
  if (isObject(notes.json) && Array.isArray(notes.json.items)) r.pass('notifications', 'live', 'items[] present');
  else r.fail('notifications', 'live', notes.error ?? 'no items[]');

  const hosts = await client.getJson('/api/hosts');
  if (Array.isArray(hosts.json?.hosts)) r.pass('hosts', 'live', 'hosts[] present');
  else r.fail('hosts', 'live', hosts.error ?? 'no hosts[]');

  await checkInstanceFeatures(r, client, guard, Array.isArray(apps) ? apps : []);
}

/** Sidecars, mounts and ports, only for running instances that have the feature. */
async function checkInstanceFeatures(r, client, guard, apps) {
  const running = new Set(guard.runningInstances());
  const targets = apps.flatMap((a) => (a.instances ?? [])
    .filter((i) => running.has(i.instanceId))
    .map((i) => ({ id: i.instanceId, sidecars: i.sidecarCount > 0, manifest: a.manifest })));

  const features = [
    ['sidecars', (t) => t.sidecars, (id) => `/api/instances/${id}/sidecars?usage=0`, (j) => Array.isArray(j?.sidecars)],
    ['mounts', (t) => hasPermission(t.manifest, 'apps.mount'), (id) => `/api/instances/${id}/mounts`, (j) => Array.isArray(j?.mounts)],
    ['ports', (t) => hasPermission(t.manifest, 'apps.port'), (id) => `/api/instances/${id}/ports`, (j) => Array.isArray(j?.ports)],
  ];
  for (const [name, applies, pathFor, valid] of features) {
    const ids = targets.filter(applies).map((t) => t.id);
    if (!ids.length) { r.skip(name, 'live', 'no running instance has this feature'); continue; }
    const bad = [];
    for (const id of ids) {
      const res = await client.getJson(pathFor(id));
      if (!valid(res.json)) bad.push(`${id} (${res.error ?? 'bad shape'})`);
    }
    if (bad.length) r.fail(name, 'live', `failed: ${bad.join(', ')}`);
    else r.pass(name, 'live', `shape ok on ${ids.length} instance(s)`);
  }
}

async function checkCli(r, client, deps) {
  const binary = await deps.findCli();
  if (!binary) {
    for (const id of ['cli-status', 'cli-get-apps', 'cli-get-inst']) r.skip(id, 'live', 'aura is not on PATH');
    return;
  }
  const proxy = await startGuardProxy(client);
  try {
    const status = await deps.runCli(binary, ['status'], proxy.url);
    if (status.code === 0 && /Shell:/.test(status.stdout) && !/unreachable/.test(status.stdout)) r.pass('cli-status', 'live', 'shell reachable');
    else r.fail('cli-status', 'live', `exit ${status.code}, or shell unreachable`);

    const listOf = (stdout) => {
      try {
        const v = JSON.parse(stdout);
        return Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : null;
      } catch { return null; }
    };

    const apps = await deps.runCli(binary, ['get', 'apps', '-o', 'json'], proxy.url);
    const appList = listOf(apps.stdout);
    if (apps.code === 0 && appList?.some((a) => a?.manifest?.id === TERMINAL_APP_ID)) r.pass('cli-get-apps', 'live', 'JSON list includes the Terminal app');
    else r.fail('cli-get-apps', 'live', `exit ${apps.code}, or unexpected JSON`);

    const inst = await deps.runCli(binary, ['get', 'inst', '-o', 'json'], proxy.url);
    const instList = listOf(inst.stdout);
    if (inst.code === 0 && instList?.length && instList.every((i) => typeof i?.instanceId === 'string' && typeof i?.state === 'string')) {
      r.pass('cli-get-inst', 'live', 'JSON list has instanceId and state');
    } else r.fail('cli-get-inst', 'live', `exit ${inst.code}, or unexpected JSON`);

    const refusals = [...new Set(proxy.refused.map((x) => `${x.method} ${x.path}`))];
    const unexpected = refusals.filter((x) => !EXPECTED_CLI_REFUSALS.has(x));
    if (unexpected.length) r.fail('cli-guard', 'live', `CLI attempted requests outside the allowlist: ${unexpected.join(', ')}`);
    else r.pass('cli-guard', 'live', `all CLI traffic guarded; refused as expected: ${refusals.join(', ') || 'none'}`);
  } finally {
    await proxy.close();
  }
}

async function checkLocal(r, env, exists, findClaude) {
  if (env.APP_ID !== TERMINAL_APP_ID) {
    const why = 'runner is not inside a Terminal';
    r.skip('local-claude-binary', 'live', why);
    r.skip('local-claude-credentials', 'live', why);
    return;
  }
  if (await findClaude()) r.pass('local-claude-binary', 'live', 'present');
  else r.fail('local-claude-binary', 'live', 'claude not found on PATH');
  if (await exists(CLAUDE_CREDENTIALS)) r.pass('local-claude-credentials', 'live', 'file present (contents not read)');
  else r.fail('local-claude-credentials', 'live', 'file missing');
}

/** Run everything. Returns the secret-safe report. */
export async function runSmoke({ client, guard, tier = 'live', env = process.env, deps = {} }) {
  const d = {
    findCli: () => findOnPath('aura', env),
    runCli: (binary, args, url) => defaultRunCli(binary, args, url, env),
    findClaude: () => findOnPath('claude', env),
    exists: existsSync,
    ...deps,
  };
  const r = recorder();

  const appsRes = await client.getJson('/api/apps');
  const apps = appsRes.json;
  guard.admit(apps);
  if (!Array.isArray(apps)) r.fail('discovery', 'live', appsRes.error ?? '/api/apps is not an array');

  const before = await snapshot(client, guard);
  await checkHttp(r, client, guard, apps, tier);
  await checkCli(r, client, d);
  await checkLocal(r, env, d.exists, d.findClaude);

  for (const [id, why] of TEST_INSTANCE_WORKFLOWS) {
    r.skip(`workflow:${id}`, 'test-instance', tier === 'live'
      ? `skipped on live: ${why}`
      : `not automated yet, use MANUAL.md: ${why}`);
  }

  const after = await snapshot(client, guard);
  const problems = [...before.errors.map((e) => `before: ${e}`), ...after.errors.map((e) => `after: ${e}`)];
  const changes = diffSnapshots(before, after);
  if (problems.length) r.fail('state-guard', 'live', `could not compare state: ${problems.join('; ')}`);
  else if (changes.length) r.fail('state-guard', 'live', `state changed during the run: ${changes.join('; ')}`);
  else r.pass('state-guard', 'live', 'apps, Activities, instances, sidecar counts and Terminal sessions unchanged');

  const count = (s) => r.results.filter((x) => x.status === s).length;
  return {
    tier,
    summary: { pass: count('pass'), fail: count('fail'), skip: count('skip') },
    results: r.results,
    state: { before, after, changes },
  };
}
