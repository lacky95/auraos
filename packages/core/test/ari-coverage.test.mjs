// ARI coverage (Phase 5b stream E; D100; ari-gap-review.md §2, §5.5): the
// inventory of every runtime-related CLI command and kernel, shell or admin
// feature as data, and a scan of the repository that FAILS on any new direct
// or indirect runtime-specific use outside the provider boundary:
//
//   direct    the docker CLI, the Engine API (`DockerApi`, `engine.*`), the
//             Docker socket, a `proot` exec, a `/proc` scan, a runtime
//             kind-string check, an `aura-${…instance…}` container name
//   indirect  a runtime import of a file with a direct use (core), or a shell
//             route reaching the container runner itself (`mgr.container`; the
//             managers behind `mgr.mounts|portExpose|osSidecars|execBridge`
//             hold no Docker mechanism since 5b-2 D and Phase 6 ari-rest)
//
// The provider boundary is the runtime modules and their runners. Everything
// else that uses a runtime directly is either a listed, owner-approved
// exemption (OS infrastructure, the host operator) or a BASELINE entry naming
// its inventory row and its ledger row (PHASE6; only D-SDK is left after
// Phase 6 ari-rest, owner decision 5). The baseline must shrink: an entry whose file no
// longer uses a runtime fails until it is removed, and so does an inventory row
// marked `bypass` that no baseline entry carries any more.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_FEATURE, RUNTIME_FEATURE_IDS, moduleFeatures } from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/container/index.js';
import { prootRuntime } from '../dist/runtimes/proot/index.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// ─── The inventory (§2): 49 runtime-related rows ────────────────────────────
//
// status  ari     served through ARI or the runner, no runtime bypass
//         fixed   a §2 bypass closed in 5b-1 (or 5-main), by `by`
//         bypass  still bypasses: `row` is its 5b-2 stream D extraction row,
//                 done at the latest in Phase 6 (owner decision 5; the open ones: PHASE6)
// group   the ARI group that serves (ari, fixed) or will serve (bypass) it

const ROW = { 'D-B': 'build', 'D-X': 'logs', 'D-P': 'endpoints', 'D-T': null, 'D-R': 'diagnostics', 'D-#11': 'adoption', 'D-S': 'workloads', 'D-M': 'mounts', 'D-C': 'diagnostics', 'D-SDK': null };

export const INVENTORY = [
  // 2.1 CLI commands, through ARI
  { id: 'cli.lifecycle', surface: 'start/stop/restart app|inst, run, open', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.kill', surface: 'inst kill, /kill', status: 'ari', feature: 'execution.processControl' },
  { id: 'cli.pause', surface: 'inst pause/resume', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.usage', surface: 'get/describe usage columns', status: 'ari', feature: 'observability.metrics', group: 'usage' },
  { id: 'cli.jump', surface: 'jump, inst shell, exec inst', status: 'ari', feature: 'execution.interactive', group: 'sessions' },
  { id: 'cli.root', surface: 'root [cmd]', status: 'ari', feature: 'execution.interactive', group: 'sessions' },
  { id: 'cli.dev-new', surface: 'dev new (runtime list from the API)', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.dev-validate', surface: 'dev validate (requirementsOf + check API)', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.patch-preview', surface: 'dev patch preview', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.runtime', surface: 'runtime ls/show/set/enable/disable/default/check/override/migrate', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.run-as', surface: 'admin apps run-as/privileges', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'cli.homes', surface: 'admin homes (kernel storage, A4-gated host paths)', status: 'ari', feature: 'storage.sharedHome' },
  { id: 'cli.data', surface: 'data query/write/watch (endpoint)', status: 'ari', feature: 'network.endpointExposure' },
  // 2.2 features, through ARI
  { id: 'feat.spawn', surface: 'spawn, env, home, identity, token (SpawnContext; host paths A4-gated)', status: 'ari', feature: 'instance.lifecycle' },
  { id: 'feat.gateway', surface: 'gateway, WS/HTTP proxy (endpoint)', status: 'ari', feature: 'network.endpointExposure' },
  { id: 'feat.warm-pool', surface: 'warm pool', status: 'ari', feature: 'instance.warmPool' },
  { id: 'feat.tools-at-spawn', surface: 'tool provisioning at spawn', status: 'ari', feature: 'tools.provision', group: 'tools' },
  { id: 'feat.session-broker', surface: 'session broker (inside the container module)', status: 'ari', feature: 'execution.interactive', group: 'sessions' },
  // The 7 bypasses the planned 5b streams fix
  { id: 'cli.kind-checks', surface: 'ps/get/describe inst, mount picker kind checks', status: 'fixed', by: '5b G', feature: 'mount.attach' },
  { id: 'feat.dns-fallback', surface: 'network identity, aura-${id} DNS fallback', status: 'fixed', by: '5-main B6 (D89)', feature: 'instance.lifecycle' },
  { id: 'feat.adoption', surface: 'adoption at boot', status: 'fixed', by: '5b CR', feature: 'instance.adoption', group: 'adoption' },
  { id: 'feat.proot-respawn', surface: 'PRoot respawn after a restart', status: 'fixed', by: '5b RS', feature: 'instance.lifecycle' },
  { id: 'feat.kind-checks', surface: 'OS-sidecar auth, source views, mounts/ports routes kind checks', status: 'fixed', by: '5b G', feature: 'mount.attach' },
  { id: 'feat.proot-routes', surface: 'proot-info, inspect-rootfs, upgrade-proot', status: 'fixed', by: '5b PR (module actions)', feature: 'instance.lifecycle' },
  { id: 'feat.bench', surface: 'bench-sandbox', status: 'fixed', by: '5b PR (module actions)', feature: 'instance.lifecycle' },
  // The 24 the delta covers
  { id: 'cli.logs', surface: 'logs inst (the runtime\'s logs, else the runner\'s output ring)', status: 'fixed', by: '5b-2 D-X', feature: 'observability.logs' },
  { id: 'cli.logs-sidecar', surface: 'logs sc (workloads.logs)', status: 'fixed', by: '5b-2 D-X', feature: 'observability.logs', group: 'workloads' },
  { id: 'cli.sidecar-exec', surface: 'jump --sidecar, exec sc (workloads.exec)', status: 'fixed', by: '5b-2 D-X', feature: 'workload.dynamic', group: 'workloads' },
  { id: 'cli.sessions', surface: 'session list/end, root ls/end', status: 'fixed', by: '5b CR', feature: 'execution.interactive', group: 'sessions' },
  { id: 'cli.cap-status', surface: 'cap grant/revoke applied|failed|unsupported', status: 'fixed', by: '5b CR/G', feature: 'tools.liveGrant', group: 'tools' },
  { id: 'cli.cap-doctor', surface: 'cap doctor (each runtime\'s diagnostics.probeTools)', status: 'fixed', by: '5b-2 D-C', feature: 'tools.provision' },
  { id: 'cli.inspect-tools', surface: 'inspect-tools (tools.status)', status: 'fixed', by: '5b-2 D-C', feature: 'tools.provision', group: 'tools' },
  { id: 'cli.mount', surface: 'mount ls/add/rm (mounts.attach/detach/verify)', status: 'fixed', by: 'Phase 6 ari-rest (D-M)', feature: 'mount.attach', group: 'mounts' },
  { id: 'cli.mount-workspace', surface: 'mount workspace (mounts.attach)', status: 'fixed', by: 'Phase 6 ari-rest (D-M)', feature: 'mount.attach', group: 'mounts' },
  { id: 'cli.patch-mounts', surface: 'dev patch start/save/activate (work, patches mounts: mounts.attach)', status: 'fixed', by: 'Phase 6 ari-rest (D-M)', feature: 'mount.attach', group: 'mounts' },
  { id: 'cli.port', surface: 'port ls/expose/rm (endpoints)', status: 'fixed', by: '5b-2 D-P', feature: 'network.endpointExposure', group: 'endpoints' },
  { id: 'cli.sidecars', surface: 'get/describe/start/stop/restart/delete sc|svc (workloads.listOf/inspect/destroy)', status: 'fixed', by: 'Phase 6 ari-rest (D-S)', feature: 'workload.dynamic', group: 'workloads' },
  { id: 'cli.sidecar-create', surface: 'sidecar create, sidecar tools (workloads.create/start/seed; tools stay kernel storage, A4)', status: 'fixed', by: 'Phase 6 ari-rest (D-S)', feature: 'workload.dynamic', group: 'workloads' },
  { id: 'cli.build', surface: 'build app, nexus install/update (build)', status: 'fixed', by: '5b-2 D-B', feature: 'build.execute', group: 'build' },
  { id: 'cli.sdk', surface: 'sdk install, refreshSdk (provisioning through build; the @aura/* copy is kernel storage, A4, like homes)', status: 'fixed', by: '5b-2 D-B', feature: 'build.execute', group: 'build' },
  { id: 'feat.tools-host-dir', surface: 'tool refresh as a host dir', status: 'fixed', by: '5b K/CR (tools group)', feature: 'tools.liveGrant', group: 'tools' },
  { id: 'cli.whereami', surface: 'whereami (the kernel answers)', status: 'fixed', by: '5b CR', feature: 'instance.lifecycle' },
  { id: 'feat.reaper', surface: 'orphan reaper, reap-orphans (the runtimes\' orphans.scan; liveness by isRunning)', status: 'fixed', by: '5b-2 D-#11', feature: 'instance.adoption' },
  { id: 'feat.mount-reapply', surface: 'mount reapply, fan-out to sidecars, reconcile (mounts.attach/table)', status: 'fixed', by: 'Phase 6 ari-rest (D-M)', feature: 'mount.inheritance', group: 'mounts' },
  { id: 'feat.sidecar-reconcile', surface: 'OS sidecar reconcile, orphan sidecars (workloads.listManaged/destroy)', status: 'fixed', by: 'Phase 6 ari-rest (D-S)', feature: 'workload.dynamic', group: 'workloads' },
  { id: 'feat.term-networks', surface: 'Terminal private networks (container module internals)', status: 'fixed', by: '5b-2 D-T', feature: 'network.isolation' },
  { id: 'feat.datadir-report', surface: 'data-dir and contract report (diagnostics.inspectWrites)', status: 'fixed', by: '5b-2 D-R', feature: 'observability.logs' },
  { id: 'feat.base-install', surface: 'PRoot base-install', status: 'fixed', by: '5b PR (module action)', feature: 'instance.lifecycle' },
  { id: 'feat.container-health', surface: 'container health (was a constant)', status: 'fixed', by: '5b CR', feature: 'instance.lifecycle' },
];

/** Outside the 49 (the SDK, not a command or a kernel feature): owner answer 3, removed in 5b. */
const EXTRA_LEDGER = [{ id: 'sdk.docker-mode', surface: 'app-sdk direct-Docker sidecar mode', status: 'bypass', row: 'D-SDK', feature: 'workload.dynamic' }];

// ─── The boundary, the exemptions, the baseline ─────────────────────────────

/** The provider boundary: runtime modules and their runners. */
const BOUNDARY = [
  /^packages\/core\/src\/runtimes\//,
  /^packages\/core\/src\/app-manager\/(ContainerRunner|ProotRunner|DockerApi|SessionBroker)\.ts$/,
];

/** Owner-approved, not app-runtime functionality (§2.3 "exempt"); never propagates. */
const EXEMPT = {
  'packages/core/src/app-manager/BaseImage.ts': 'OS image infrastructure (Phase 6 release builder)',
  'packages/core/src/updater/SelfUpdater.ts': 'OS self-update (Phase 6 updater)',
  'packages/aura-cli/src/commands/jump.ts': 'jump -m: the host operator into the master',
  'os/migrate-redis-to-valkey.mjs': 'OS data migration on the host',
  'os/release/builder.mjs': 'the Phase 6 release builder: OS infrastructure, builds the OS before any runtime exists (ari-gap-review §5.3, owner answer 2)',
  'packages/core/src/types/manifest.ts': 'R2 schema rule (execution.runAs root on proot): a manifest parse has no registry; the start gate is capability-based',
};

/**
 * Direct or indirect runtime-specific use outside the boundary, each with its inventory rows. Phase 6 ari-rest
 * emptied it for the 49 rows (D-S, D-M); what is left is the SDK's direct-Docker mode (D-SDK, the PHASE6 ledger).
 */
const BASELINE = {
  'packages/app-sdk/src/sidecars.ts': ['sdk.docker-mode'],
};

// ─── The scan ───────────────────────────────────────────────────────────────

const SCAN_ROOTS = ['packages/core/src', 'packages/shell/src', 'packages/shell/server', 'packages/aura-cli/src', 'packages/app-sdk/src', 'os'];

/** Runtime mechanism used directly (these propagate to importers). */
const MECHANISM = [
  ['docker CLI', /\b(execFile|execFileSync|execFileAsync|spawn|spawnSync|exec)\(\s*['"]docker['"]/],
  ['docker CLI', /\bexecSync\(\s*[`'"]docker\s/],
  ['docker CLI', /\b(run|exec\w*|spawn\w*)\(\s*['"]docker['"]\s*,/],
  ['Engine API', /\bnew DockerApi\(|\bimport\s*\{[^}]*\bDockerApi\b[^}]*\}\s*from/],
  ['Engine API', /\bengine\.(execCreate|execStart|execInspect|logs|containerInspect)\(/],
  ['Docker socket', /['"`]\/var\/run\/docker\.sock['"`]/],
  ['proot exec', /\b(run|exec\w*|spawn\w*)\(\s*['"](proot|\/usr\/bin\/proot)['"]\s*,/],
  ['/proc scan', /readdirSync\(\s*['"]\/proc['"]\s*\)/],
];
/** A runtime's detail named outside its module (does not propagate). */
const DETAIL = [
  ['kind check', /\bsandbox\s*(===|!==)\s*['"](container|proot)['"]|['"](container|proot)['"]\s*(===|!==)\s*[\w.?]*sandbox\b/],
  ['container name', /`aura-\$\{[^}]*[iI]nstance[^}]*\}/],
];
/** Shell code reaching the container runner itself (the managers hold no Docker mechanism since Phase 6 D-S, D-M). */
const MANAGER = /\b(?:mgr|getAppManager\(\)|this\.mgr|deps\.mgr|core\.getAppManager\(\))\.(container)\b/;

function sourceFiles() {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (!['node_modules', 'dist', 'templates'].includes(n)) walk(p); }
      else if (/\.(ts|mts|mjs|cjs|js|astro)$/.test(n) && !/\.test\.|\.d\.m?ts$/.test(n)) out.push(p);
    }
  };
  for (const r of SCAN_ROOTS) walk(join(ROOT, r));
  return out;
}

/** Code without comments (JSDoc blocks, inline blocks, line comments outside URLs and strings, roughly). */
const code = (s) => s.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/\/\*[^\n]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

const inBoundary = (rel) => BOUNDARY.some((re) => re.test(rel));
/** The composition point: constructs runners, modules and managers (Phase 6 K moves it into bootSystem()). */
const COMPOSITION = 'packages/core/src/app-manager/AppManager.ts';

/** file → the reasons it uses a runtime outside the boundary (direct, detail, indirect). */
function scan() {
  const files = sourceFiles().map((f) => ({ f, rel: relative(ROOT, f), src: code(readFileSync(f, 'utf8')) }));
  const direct = new Map();
  for (const { rel, src } of files) {
    const why = MECHANISM.filter(([, re]) => re.test(src)).map(([w]) => w);
    if (why.length) direct.set(rel, why);
  }
  const uses = new Map();
  const add = (rel, w) => { if (!uses.has(rel)) uses.set(rel, new Set()); uses.get(rel).add(w); };
  for (const [rel, why] of direct) for (const w of why) add(rel, w);
  for (const { f, rel, src } of files) {
    for (const [w, re] of DETAIL) if (re.test(src)) add(rel, w);
    for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
      const target = relative(ROOT, resolve(dirname(f), m[1])).replace(/\.js$/, '.ts');
      // The composition point and the exemptions don't spread: their importers are not runtime code.
      if (target !== rel && direct.has(target) && !EXEMPT[target] && target !== COMPOSITION
        // The composition point constructs the providers' runners (until Phase 6 K bootSystem()): no bypass.
        && !(rel === COMPOSITION && inBoundary(target))) add(rel, `imports ${target}`);
    }
    const mgr = src.match(new RegExp(MANAGER, 'g'));
    if (mgr) for (const m of mgr) add(rel, m.replace(/^.*\./, 'manager '));
  }
  for (const rel of [...uses.keys()]) if (inBoundary(rel)) uses.delete(rel);
  return uses;
}

const ALL = [...INVENTORY, ...EXTRA_LEDGER];
const byId = new Map(ALL.map((r) => [r.id, r]));

// ─── Tests ──────────────────────────────────────────────────────────────────

test('ARI coverage: the §2 inventory has its 49 rows, each well-formed (status, feature, row → group)', () => {
  assert.equal(INVENTORY.length, 49);
  assert.equal(new Set(ALL.map((r) => r.id)).size, ALL.length, 'unique ids');
  const counts = { ari: 0, fixed: 0, bypass: 0 };
  for (const r of ALL) {
    assert.ok(['ari', 'fixed', 'bypass'].includes(r.status), r.id);
    assert.ok(RUNTIME_FEATURE_IDS.includes(r.feature), `${r.id}: ${r.feature} is a D100 feature id`);
    if (r.status === 'bypass') {
      assert.ok(r.row in ROW, `${r.id}: names its 5b-2 extraction row`);
      const group = ROW[r.row];
      if (group) assert.ok(group in GROUP_FEATURE, `${r.id}: ${r.row} lands in a typed group (${group})`);
    }
    if (r.status === 'fixed') assert.ok(r.by, `${r.id}: says what fixed it`);
    if (r.status !== 'bypass' && r.group) assert.ok(r.group in GROUP_FEATURE, `${r.id}: ${r.group} is an implemented group`);
  }
  for (const r of INVENTORY) counts[r.status]++;
  // §2.3: 18 through ARI and 31 bypasses at 283378f; 5b-1 (K..G) and 5-main B6 closed 13 of the 31,
  // 5b-2 stream D the rest row by row (D-T, D-R, D-C, D-#11, D-X, D-P, D-B), Phase 6 ari-rest D-S and D-M.
  assert.deepEqual(counts, { ari: 18, fixed: 31, bypass: 0 });
});

test('ARI coverage: every group an ari/fixed row is served by is declared by the reference provider (container)', () => {
  const stub = Object.assign({ capabilities: (s) => ContainerRunner.prototype.capabilities.call({}, s), getHost: () => null, getPort: () => null },
    { listOrphanRecords: async () => [], openSessions: () => [], usage: async () => new Map(), provisionToolsDir: () => '/x' });
  const m = containerRuntime(stub, { toolsMode: () => 'hardlink' });
  const features = moduleFeatures(m, {});
  for (const r of INVENTORY.filter((x) => x.status !== 'bypass' && x.group)) {
    assert.ok(m[r.group] !== undefined, `${r.id}: the container module has the ${r.group} group`);
    assert.notEqual(features.find((f) => f.id === GROUP_FEATURE[r.group]).support, 'unsupported', r.id);
  }
  // PRoot declares what it can't do: the groups it lacks are unsupported features, never a silent no-op.
  const p = prootRuntime({ capabilities: (s) => ProotRunner.prototype.capabilities.call({}, s), getHost: () => null, getPort: () => null, provisionToolsDir: () => '/x' },
    { baseRootfs: '/nonexistent', env: {} });
  for (const g of ['adoption', 'sessions', 'workloads']) {
    assert.equal(p[g], undefined, g);
    assert.equal(moduleFeatures(p, {}).find((f) => f.id === GROUP_FEATURE[g]).support, 'unsupported', g);
  }
});

test('ARI coverage: no direct or indirect runtime-specific use outside the provider boundary except the listed ones', () => {
  const uses = scan();
  const unlisted = [...uses].filter(([rel]) => !EXEMPT[rel] && !BASELINE[rel])
    .map(([rel, why]) => `${rel}: ${[...why].join(', ')}`);
  assert.deepEqual(unlisted, [], 'a new runtime bypass: go through an ARI group or the instance capabilities (runtimes/AGENTS.md); '
    + 'a bypass that must stay needs an owner decision, never a quiet baseline entry');
});

test('ARI coverage: the baseline shrinks: every entry still bypasses, and names open inventory rows', () => {
  const uses = scan();
  for (const [rel, ids] of Object.entries(BASELINE)) {
    assert.ok(uses.has(rel), `${rel} no longer uses a runtime directly: remove it from BASELINE (and close its rows)`);
    for (const id of ids) {
      const r = byId.get(id);
      assert.ok(r, `${rel}: unknown inventory row ${id}`);
      assert.equal(r.status, 'bypass', `${rel}: ${id} is ${r.status}, so the file must not bypass any more`);
    }
  }
  for (const rel of Object.keys(EXEMPT)) assert.ok(uses.has(rel), `${rel} no longer needs its exemption: remove it`);
  // Every open bypass row is still carried by a file (or it is closed: mark it fixed).
  const carried = new Set(Object.values(BASELINE).flat());
  for (const r of ALL.filter((x) => x.status === 'bypass')) {
    assert.ok(carried.has(r.id), `${r.id} (${r.row}) has no baselined file left: mark it fixed`);
  }
});

/**
 * The rows still open, each with its exact reason and its Phase 6 owner (owner decision 5: at the latest
 * Phase 6, never Phase 8). Phase 6 ari-rest closed D-S and D-M; a row is closed by moving its mechanism behind
 * a group, never by a baseline entry. What is left is D-SDK, and it waits on an owner decision only.
 */
const PHASE6 = {
  'D-SDK': 'Phase 6, owner decision pending (the one remaining row; no kernel or runtime code is left to move): '
    + 'packages/app-sdk/src/sidecars.ts keeps the direct-Docker sidecar mode (`docker` CLI, the socket path, '
    + '`aura-${instanceId}` names), the default when createSidecars() gets no `mode`. The owner precondition '
    + 'for removing it ("every existing app is on OS-managed sidecars") does not hold: two installed apps, '
    + 'io.lakner.trilium (server.mjs) and io.lakner.steelaibrowser (src/lib/steel.ts), call createSidecars() '
    + 'without a mode. Routing the docker mode through the OS path inside the SDK is not compatible (onSeed, '
    + 'per-app volumes and volume/subpath overrides have no OS equivalent: sidecar-spec.ts refuses them) and '
    + 'would change those apps at their next SDK refresh. Owner question: patch both apps to mode \'os\' '
    + '(services[].seed instead of onSeed), then delete the mode, its options and docs in one step.',
};

test('ARI coverage: every open bypass is in the Phase 6 ledger with its exact reason (owner decision 5): only D-SDK is left', () => {
  const ledger = {};
  for (const r of ALL.filter((x) => x.status === 'bypass')) (ledger[r.row] ??= []).push(r.id);
  // The rows left open, each with its reason and a Phase 6 owner; never Phase 8. The 49 inventory rows are all closed.
  assert.deepEqual(Object.keys(ledger).sort(), Object.keys(PHASE6).sort());
  assert.deepEqual(Object.keys(ledger), ['D-SDK']);
  assert.deepEqual(ledger['D-SDK'], ['sdk.docker-mode']);
  for (const [row, why] of Object.entries(PHASE6)) assert.match(why, /^Phase 6\b/, `${row}: owned by Phase 6`);
});
