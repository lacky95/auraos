// kubectl-style grammar: resource registry, -o rendering, the instance
// resolver, the hidden legacy groups and their hints, the main help and
// completion. Pure — no shell needed.
//
//   pnpm --filter @aura/cli test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';
import { RESOURCES, findResource, resourcesFor, shortName, sidecarId, sidecarMatches, type AppDto, type SidecarDto } from '../src/lib/resources.js';
import { renderObjects, parseOutput } from '../src/lib/output.js';
import { table, visibleWidth } from '../src/lib/format.js';
import { matchInstance } from '../src/lib/resolve.js';
import { LEGACY_GROUPS, LEGACY_HINTS } from '../src/lib/deprecate.js';
import { buildProgram, completions, HELP_GROUPS } from '../src/program.js';

const hidden = (c: Command) => Boolean((c as unknown as { _hidden?: boolean })._hidden);

test('every resource name and short name is unique and resolves to its resource', () => {
  const seen = new Map<string, string>();
  for (const r of RESOURCES) {
    for (const n of [r.name, ...r.aliases]) {
      assert.ok(!seen.has(n), `${n} claimed by ${seen.get(n)} and ${r.name}`);
      seen.set(n, r.name);
      assert.equal(findResource(n)?.name, r.name);
      assert.equal(findResource(n.toUpperCase())?.name, r.name, 'case-insensitive');
    }
  }
  assert.equal(findResource('inst')?.name, 'instances');
  assert.equal(findResource('sc')?.name, 'sidecars');
  assert.equal(findResource('nope'), undefined);
});

test('every resource supports get, and every verb it lists exists as a command', () => {
  const program = buildProgram();
  const names = new Set(program.commands.map((c) => c.name()));
  for (const r of RESOURCES) {
    assert.ok(r.verbs.includes('get'), `${r.name} has no get`);
    for (const v of r.verbs) assert.ok(names.has(v), `${r.name} lists verb '${v}' but there is no such command`);
  }
  assert.deepEqual(resourcesFor('get').length, RESOURCES.length);
  assert.equal(shortName(findResource('instances')!), 'inst');
});

const appsDef = findResource('apps')!;
const sample = [
  { manifest: { id: 'com.a', name: 'A', version: '1.0.0' }, enabled: true, instances: [], activities: [] },
  { manifest: { id: 'com.b', name: 'B', version: '2.0.0', sandbox: 'container' }, enabled: false, instances: [], activities: [] },
];

test('-o json / yaml emit the raw objects; a single named object is emitted bare', () => {
  assert.deepEqual(JSON.parse(renderObjects(sample, appsDef, { output: 'json' })), sample);
  assert.deepEqual(JSON.parse(renderObjects([sample[0]], appsDef, { output: 'json', single: true })), sample[0]);
  assert.match(renderObjects(sample, appsDef, { output: 'yaml' }), /- manifest:\n {4}id: com\.a/);
});

test('-o name prints <short>/<name>; -o wide adds the wide columns; --no-headers drops the header', () => {
  assert.equal(renderObjects(sample, appsDef, { output: 'name' }), 'app/com.a\napp/com.b');
  const narrow = renderObjects(sample, appsDef, { output: 'table' });
  const wide = renderObjects(sample, appsDef, { output: 'wide' });
  assert.ok(!narrow.includes('SANDBOX'));
  assert.ok(wide.split('\n')[0]!.includes('SANDBOX'));
  assert.ok(wide.split('\n')[2]!.includes('container'));
  const bare = renderObjects(sample, appsDef, { output: 'table', noHeaders: true });
  assert.equal(bare.split('\n').length, 2);
  assert.ok(!bare.includes('VERSION'));
  assert.match(renderObjects([], appsDef, { output: 'table' }), /No apps found/);
});

test('parseOutput rejects unknown formats', () => {
  assert.equal(parseOutput(undefined), 'table');
  assert.equal(parseOutput('yaml'), 'yaml');
  assert.throws(() => parseOutput('xml'), /unknown output format/);
});

test('table() aligns columns by visible width, ignoring ANSI color codes', () => {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const out = table([{ A: green('on'), B: 'x' }, { A: 'off', B: 'y' }], ['A', 'B']);
  const [, r1, r2] = out.split('\n');
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(strip(r1!).indexOf('x'), strip(r2!).indexOf('y'));
  assert.equal(visibleWidth(r1!), strip(r1!).length);
});

const apps = (instances: Array<Partial<AppDto['instances'][number]> & { instanceId: string; appId: string }>): AppDto[] => {
  const byApp = new Map<string, AppDto>();
  for (const i of instances) {
    const a = byApp.get(i.appId) ?? { manifest: { id: i.appId, name: i.appId, version: '1' }, instances: [], activities: [] };
    a.instances.push({ state: 'resumed', port: null, ...i });
    byApp.set(i.appId, a);
  }
  return [...byApp.values()];
};

test('matchInstance: exact id, single-instance app id, prefix, ambiguity, suggestions', () => {
  const world = apps([
    { instanceId: 'com.aura.terminal-13', appId: 'com.aura.terminal' },
    { instanceId: 'com.aura.terminal-23', appId: 'com.aura.terminal' },
    { instanceId: 'com.aura.notepad', appId: 'com.aura.notepad' },
    { instanceId: 'com.aura.notepad-pool', appId: 'com.aura.notepad', inPool: true },
    { instanceId: 'io.lakner.hermes', appId: 'io.lakner.hermes' },
  ]);
  const ok = (t: string) => { const m = matchInstance(world, t); assert.ok(m.ok, t); return m.instance.instanceId; };
  assert.equal(ok('com.aura.terminal-23'), 'com.aura.terminal-23');
  assert.equal(ok('com.aura.notepad'), 'com.aura.notepad', 'pool spares do not make an app ambiguous');
  assert.equal(ok('io.lakner.her'), 'io.lakner.hermes');
  const amb = matchInstance(world, 'com.aura.terminal');
  assert.ok(!amb.ok && /2 running instances/.test(amb.reason) && amb.reason.includes('com.aura.terminal-13'));
  const typo = matchInstance(world, 'hermez');
  assert.ok(!typo.ok && /no app or instance/.test(typo.reason));
  const stopped = matchInstance(apps([{ instanceId: 'x.y', appId: 'x.y', state: 'destroyed' }]).map((a) => ({ ...a, instances: [] })), 'x.y');
  assert.ok(!stopped.ok && /aura run x\.y/.test(stopped.reason));
});

test('sidecar IDs: service label, else container name; matches container and aura-<inst>--<id>', () => {
  const sc = (over: Partial<SidecarDto>): SidecarDto => ({
    id: 'aura-io.lakner.hermes--runtime', service: 'runtime', parentInstanceId: 'io.lakner.hermes',
    appId: 'io.lakner.hermes', backend: 'container', state: 'running', ...over,
  });
  assert.equal(sidecarId(sc({})), 'runtime');
  assert.equal(sidecarId(sc({ id: 'hermes-6a6c', service: '' })), 'hermes-6a6c');
  assert.ok(sidecarMatches(sc({}), 'runtime'));
  assert.ok(sidecarMatches(sc({}), 'aura-io.lakner.hermes--runtime'));
  assert.ok(sidecarMatches(sc({ service: '' }), 'runtime'), 'derives the SDK container name');
  assert.ok(!sidecarMatches(sc({}), 'db'));
});

test('legacy groups stay registered but hidden; every legacy subcommand has a hint', () => {
  const program = buildProgram();
  for (const g of LEGACY_GROUPS) {
    const cmd = program.commands.find((c) => c.name() === g);
    assert.ok(cmd, `${g} missing`);
    assert.ok(hidden(cmd!), `${g} not hidden`);
    if (g === 'sdk') continue; // silent on purpose: runs on every app boot
    const walk = (c: Command, path: string[]): void => {
      if (c.commands.length === 0) {
        const key = path.length > 2 ? path.slice(-2).join(' ') : path.join(' ');
        assert.ok(LEGACY_HINTS[key], `no deprecation hint for 'aura ${path.join(' ')}'`);
        return;
      }
      for (const s of c.commands) walk(s, [...path, s.name()]);
    };
    walk(cmd!, [g]);
  }
  for (const hint of Object.values(LEGACY_HINTS)) {
    const verb = hint.split(' ')[1]!;
    assert.ok(program.commands.some((c) => c.name() === verb && !hidden(c)), `hint points at '${verb}', which is not a visible command`);
  }
});

test('main help lists every grouped command, every resource type and no legacy group', () => {
  const program = buildProgram();
  const help = program.helpInformation();
  for (const g of HELP_GROUPS) {
    for (const n of g.commands) {
      assert.ok(program.commands.some((c) => c.name() === n), `help group lists unknown command '${n}'`);
      assert.match(help, new RegExp(`^  ${n}\\b`, 'm'), `help misses '${n}'`);
    }
  }
  for (const r of RESOURCES) assert.match(help, new RegExp(`^  ${r.name}\\s`, 'm'), `help misses resource ${r.name}`);
  for (const g of LEGACY_GROUPS.filter((x) => x !== 'whereami')) assert.doesNotMatch(help, new RegExp(`^  ${g}\\b`, 'm'));
});

test('completion: commands, resources per verb, subresource, classic subcommands', async () => {
  const program = buildProgram();
  const top = await completions(program, []);
  assert.ok(top.includes('get') && top.includes('jump') && !top.includes('app') && !top.includes('__complete'));
  const forGet = await completions(program, ['get']);
  assert.ok(forGet.includes('inst') && forGet.includes('sidecars'));
  assert.ok((await completions(program, ['install'])).includes('sdk'));
  assert.ok(!(await completions(program, ['stop'])).includes('sc'), 'stop does not take sidecars');
  assert.deepEqual(await completions(program, ['get', 'inst', 'x']), ['sidecars']);
  assert.deepEqual(await completions(program, ['mount']), ['ls', 'add', 'rm']);
  assert.deepEqual(await completions(program, ['get', '-o', 'wide']), forGet, 'option values are skipped');
});
