/**
 * kubectl-style verbs: `aura <verb> <resource> [name…]`.
 *
 *   get / describe / api-resources   read, via the resource registry (lib/resources.ts)
 *   everything that mutates          delegated to the existing command groups
 *                                    (`aura app stop`, `aura service start`, …)
 *
 * Delegation runs a FRESH program on a rewritten argv (`dispatch`), so every
 * prompt, safety check and message of the original command stays the single
 * implementation — the verbs are a grammar, not a second copy of the logic.
 */
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { api, subscribeEvents } from '../lib/client.js';
import { color, fail, table } from '../lib/format.js';
import { enterSidecar } from '../lib/enter-sandbox.js';
import { parseOutput, renderDocument, renderObjects, type OutputFormat } from '../lib/output.js';
import { resolveInstance, resolveSidecar } from '../lib/resolve.js';
import {
  RESOURCES, findResource, fetchSidecars, resourcesFor, shortName, sidecarId, sidecarMatches,
  type Ctx, type ResourceDef,
} from '../lib/resources.js';

// ─── Delegation ─────────────────────────────────────────────────────────────

type ProgramFactory = () => Command;
let makeProgram: ProgramFactory | null = null;

/** program.ts hands over its factory (a direct import would be circular). */
export function setProgramFactory(f: ProgramFactory): void { makeProgram = f; }

/** Run `aura <argv…>` in-process on a fresh program, without deprecation hints. */
export async function dispatch(argv: string[]): Promise<void> {
  if (!makeProgram) throw new Error('verbs: program factory not set');
  const prev = process.env['AURA_INTERNAL_DISPATCH'];
  process.env['AURA_INTERNAL_DISPATCH'] = '1';
  try {
    await makeProgram().parseAsync(argv, { from: 'user' });
  } finally {
    if (prev === undefined) delete process.env['AURA_INTERNAL_DISPATCH'];
    else process.env['AURA_INTERNAL_DISPATCH'] = prev;
  }
}

async function dispatchEach(argvs: string[][]): Promise<void> {
  for (const argv of argvs) await dispatch(argv);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resourceOrFail(token: string, verb: string): ResourceDef {
  const def = findResource(token);
  const allowed = resourcesFor(verb);
  if (!def) fail(`unknown resource type '${token}' — \`aura ${verb}\` accepts: ${allowed.join(', ')}  (see: aura api-resources)`);
  if (!def.verbs.includes(verb)) fail(`\`aura ${verb}\` does not apply to ${def.name} — it accepts: ${allowed.join(', ')}`);
  return def;
}

function unsupported(verb: string, def: ResourceDef): never {
  fail(`\`aura ${verb} ${shortName(def)}\` is not supported — \`aura ${verb}\` accepts: ${resourcesFor(verb).join(', ')}`);
}

/** POSIX single-quote each argv word so `inst shell -c` (bash -lc) sees them verbatim. */
function shQuote(words: string[]): string {
  return words.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** `-i` accepts an instance id OR an app id with one live instance. */
async function instanceScope(token: string | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  return (await resolveInstance(token)).instanceId;
}

function examples(lines: string[]): string {
  return `\nExamples:\n${lines.map((l) => `  ${l}`).join('\n')}\n`;
}

function resourcesLine(verb: string): string {
  return `\nResources: ${resourcesFor(verb).join(', ')}\n`;
}

// ─── get ────────────────────────────────────────────────────────────────────

interface GetOpts { output?: string; app?: string; instance?: string; watch?: boolean; headers?: boolean }

async function getCmd(resource: string, name: string | undefined, sub: string | undefined, opts: GetOpts): Promise<void> {
  let def = resourceOrFail(resource, 'get');
  const output = parseOutput(opts.output);
  const ctx: Ctx = { app: opts.app, instance: await instanceScope(opts.instance) };

  // Subresource: `aura get inst <id> sidecars`.
  if (sub) {
    const subDef = findResource(sub);
    if (def.name !== 'instances' || subDef?.name !== 'sidecars') {
      fail(`unknown subresource '${sub}' — the only one is: aura get inst <instanceId> sidecars`);
    }
    if (!name) fail('aura get inst <instanceId> sidecars — needs the instance id');
    ctx.instance = (await resolveInstance(name)).instanceId;
    def = subDef;
    name = undefined;
  }

  for (const [flag, scope] of [['--app', 'app'], ['--instance', 'instance']] as const) {
    if (ctx[scope] && !(def.scopes ?? []).includes(scope) && !(scope === 'instance' && sub)) {
      fail(`${flag} does not apply to ${def.name}`);
    }
  }

  const render = async (): Promise<string> => {
    let objs = await def.list(ctx);
    if (name) {
      objs = objs.filter((o) => (def.name === 'sidecars' ? sidecarMatches(o, name!) : def.nameOf(o) === name));
      if (objs.length === 0) fail(`${shortName(def)} '${name}' not found`);
    }
    return renderObjects(objs, def, { output, noHeaders: opts.headers === false, single: Boolean(name) && objs.length === 1 });
  };

  console.log(await render());
  if (!opts.watch) return;
  if (!def.watchable) fail(`-w is not supported for ${def.name}`);
  if (output !== 'table' && output !== 'wide') fail('-w only works with table output');
  const hint = color.dim('\nwatching… (Ctrl+C to exit)');
  console.log(hint);
  let busy = false;
  const stop = subscribeEvents('/api/apps/events', async () => {
    if (busy) return;
    busy = true;
    try {
      const text = await render();
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(text);
      console.log(hint);
    } finally { busy = false; }
  });
  process.on('SIGINT', () => { stop(); process.exit(0); });
  await new Promise(() => undefined);
}

// ─── describe ───────────────────────────────────────────────────────────────

async function describeCmd(resource: string, name: string, opts: { output?: string; instance?: string }): Promise<void> {
  const def = resourceOrFail(resource, 'describe');
  const output: OutputFormat = opts.output === 'json' ? 'json' : 'yaml';
  switch (def.name) {
    case 'apps': {
      const dto = await api.get(`/api/apps/${encodeURIComponent(name)}/status`);
      console.log(renderDocument(dto, output));
      return;
    }
    case 'instances': {
      const inst = await resolveInstance(name);
      const id = encodeURIComponent(inst.instanceId);
      const status = await api.get<Record<string, unknown>>(`/api/instances/${id}/status`);
      const sidecars = (await fetchSidecars(inst.instanceId).catch(() => [])).map((s) => ({
        id: sidecarId(s), container: s.id, state: s.state, image: s.image, managedBy: s.managedBy ?? 'app',
      }));
      const mounts = inst.sandbox === 'container'
        ? ((await api.get<{ mounts: Array<{ id: string; mode: string; containerPath: string }> }>(`/api/instances/${id}/mounts`)
          .catch(() => ({ mounts: [] }))).mounts ?? []).map((m) => ({ id: m.id, mode: m.mode, path: m.containerPath }))
        : [];
      console.log(renderDocument({ ...status, sidecars, mounts }, output));
      return;
    }
    case 'sidecars': {
      const instToken = opts.instance ?? process.env['APP_INSTANCE_ID'];
      if (!instToken) fail('aura describe sc <id> -i <instance> — which instance does the sidecar belong to?');
      const inst = await resolveInstance(instToken);
      const sc = await resolveSidecar(inst.instanceId, name);
      console.log(renderDocument({ ...sc, id: sidecarId(sc), container: sc.id }, output));
      return;
    }
    case 'capabilities': return dispatch(['cap', 'info', name]);
    case 'services':     return dispatch(['service', 'status', name]);
    default:             unsupported('describe', def);
  }
}

// ─── exec / logs ────────────────────────────────────────────────────────────

async function execCmd(resource: string, name: string, cmd: string[], opts: { container?: string }): Promise<void> {
  const def = resourceOrFail(resource, 'exec');
  if (def.name === 'sidecars') fail('use: aura exec inst <instanceId> -c <sidecar> [-- cmd…]');
  const inst = await resolveInstance(name);
  if (opts.container) {
    const sc = await resolveSidecar(inst.instanceId, opts.container);
    enterSidecar(sc.id, `${inst.instanceId}/${sidecarId(sc)}`, cmd);
    return;
  }
  await dispatch(['inst', 'shell', inst.instanceId, ...(cmd.length ? ['-c', shQuote(cmd)] : [])]);
}

async function logsCmd(resource: string, name: string, opts: { container?: string; follow?: boolean; tail?: string }): Promise<void> {
  const def = resourceOrFail(resource, 'logs');
  if (def.name === 'services') return dispatch(['service', 'logs', name, ...(opts.follow ? ['-f'] : [])]);
  if (def.name === 'sidecars') fail('use: aura logs inst <instanceId> -c <sidecar>');
  const inst = await resolveInstance(name);
  if (!opts.container) return dispatch(['inst', 'logs', inst.instanceId, ...(opts.follow ? ['-f'] : [])]);
  const sc = await resolveSidecar(inst.instanceId, opts.container);
  const args = ['logs', ...(opts.tail ? ['--tail', opts.tail] : []), ...(opts.follow ? ['-f'] : []), sc.id];
  const child = spawn('docker', args, { stdio: 'inherit' });
  await new Promise<void>((resolveP) => {
    child.on('exit', (code) => { process.exitCode = code ?? 0; resolveP(); });
    child.on('error', (err) => fail(
      `docker logs failed: ${err.message}\n  Hint: reading sidecar logs needs the docker CLI and a bound /var/run/docker.sock.`,
    ));
  });
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerVerbs(program: Command): void {
  program
    .command('get <resource> [name] [subresource]')
    .description('List resources as a table (or -o json|yaml|wide|name).')
    .option('-o, --output <format>', 'table (default) | wide | json | yaml | name')
    .option('-a, --app <appId>', 'Only resources of this app')
    .option('-i, --instance <id>', 'Only resources of this instance (instance id or app id)')
    .option('-w, --watch', 'Re-render on every state change (apps, inst, act, sc)')
    .option('--no-headers', 'Omit the table header row')
    .addHelpText('after', resourcesLine('get') + examples([
      'aura get apps',
      'aura get inst -a com.aura.browser',
      'aura get inst com.aura.browser-2 sidecars      # sidecars of one instance, with their IDs',
      'aura get sc -a io.lakner.hermes -o wide',
      'aura get mounts -i com.aura.terminal',
      'aura get app com.aura.notepad -o yaml',
    ]))
    .action(async (resource: string, name: string | undefined, sub: string | undefined, opts: GetOpts) => {
      await getCmd(resource, name, sub, opts);
    });

  program
    .command('describe <resource> <name>')
    .description('Show everything about one resource (YAML, or -o json).')
    .option('-o, --output <format>', 'yaml (default) | json')
    .option('-i, --instance <id>', 'Instance a sidecar belongs to (default: $APP_INSTANCE_ID)')
    .addHelpText('after', resourcesLine('describe') + examples([
      'aura describe app com.aura.notepad',
      'aura describe inst com.aura.terminal            # incl. its sidecars + mounts',
      'aura describe sc runtime -i io.lakner.hermes',
    ]))
    .action(async (resource: string, name: string, opts: { output?: string; instance?: string }) => {
      await describeCmd(resource, name, opts);
    });

  program
    .command('stop <resource> <names...>')
    .description('Stop apps (all their instances), single instances, or services.')
    .addHelpText('after', resourcesLine('stop') + examples(['aura stop app com.aura.notepad', 'aura stop inst com.aura.browser-2', 'aura stop svc sshd']))
    .action(async (resource: string, names: string[]) => {
      const def = resourceOrFail(resource, 'stop');
      if (def.name === 'apps') return dispatchEach(names.map((n) => ['app', 'stop', n]));
      if (def.name === 'services') return dispatchEach(names.map((n) => ['service', 'stop', n]));
      for (const n of names) await dispatch(['inst', 'stop', (await resolveInstance(n)).instanceId]);
    });

  program
    .command('start <resource> <names...>')
    .description('Start services. (Apps: aura run <appId>.)')
    .addHelpText('after', resourcesLine('start') + examples(['aura start svc code-server']))
    .action(async (resource: string, names: string[]) => {
      if (findResource(resource)?.name === 'apps') fail('apps start with: aura run <appId>');
      resourceOrFail(resource, 'start');
      await dispatchEach(names.map((n) => ['service', 'start', n]));
    });

  program
    .command('restart <resource> <names...>')
    .description('Stop all instances of an app and start a fresh one.')
    .addHelpText('after', resourcesLine('restart') + examples(['aura restart app com.aura.notepad']))
    .action(async (resource: string, names: string[]) => {
      resourceOrFail(resource, 'restart');
      await dispatchEach(names.map((n) => ['app', 'restart', n]));
    });

  for (const [verb, desc] of [
    ['kill', 'Force-kill instances (SIGKILL, no lifecycle hooks).'],
    ['pause', 'Pause instances (calls onPause).'],
    ['resume', 'Resume paused instances (calls onResume).'],
  ] as const) {
    program
      .command(`${verb} <resource> <names...>`)
      .description(desc)
      .addHelpText('after', resourcesLine(verb) + examples([`aura ${verb} inst com.aura.browser-2`]))
      .action(async (resource: string, names: string[]) => {
        resourceOrFail(resource, verb);
        for (const n of names) await dispatch(['inst', verb, (await resolveInstance(n)).instanceId]);
      });
  }

  program
    .command('delete <resource> <names...>')
    .alias('rm')
    .description('Delete apps, close activities, uninstall services/capabilities, detach mounts, remove port exposes.')
    .option('-y, --yes', 'apps: skip the confirmation prompt')
    .option('-i, --instance <id>', 'mounts: instance to detach from (default: $APP_INSTANCE_ID)')
    .addHelpText('after', resourcesLine('delete') + examples([
      'aura delete app com.example.hello',
      'aura delete act act-12',
      'aura delete mount com.example.hello -i com.aura.terminal',
      'aura delete port com.aura.browser into-5173      # <ownerApp> <portId>',
    ]))
    .action(async (resource: string, names: string[], opts: { yes?: boolean; instance?: string }) => {
      const def = resourceOrFail(resource, 'delete');
      switch (def.name) {
        case 'apps':         return dispatchEach(names.map((n) => ['app', 'remove', n, ...(opts.yes ? ['-y'] : [])]));
        case 'activities':   return dispatchEach(names.map((n) => ['activity', 'close', n]));
        case 'services':     return dispatchEach(names.map((n) => ['service', 'uninstall', n]));
        case 'capabilities': return dispatchEach(names.map((n) => ['cap', 'remove', n]));
        case 'mounts': {
          const inst = await instanceScope(opts.instance);
          return dispatch(['mount', 'rm', ...names, ...(inst ? ['--instance', inst] : [])]);
        }
        case 'ports':
          if (names.length !== 2) fail('aura delete port <ownerApp> <portId>  (ids from: aura get ports)');
          return dispatch(['port', 'rm', names[0]!, names[1]!]);
        default: unsupported('delete', def);
      }
    });

  program
    .command('install <resource> [names...]')
    .description('Install an app from a directory, capabilities, a service, or the @aura/* SDK packages.')
    .option('--registry <url>', 'sdk: override the OCI registry URL')
    .option('--quiet', 'sdk: only print failures')
    .option('--cwd <path>', 'sdk: run from this directory')
    .addHelpText('after', `\nResources: ${[...resourcesFor('install'), 'sdk'].join(', ')}\n` + examples([
      'aura install app ./my-app',
      'aura install cap ripgrep jq',
      'aura install svc code-server',
      'aura install sdk --quiet',
    ]))
    .action(async (resource: string, names: string[], opts: { registry?: string; quiet?: boolean; cwd?: string }) => {
      if (resource === 'sdk') {
        return dispatch(['sdk', 'install',
          ...(opts.registry ? ['--registry', opts.registry] : []),
          ...(opts.quiet ? ['--quiet'] : []),
          ...(opts.cwd ? ['--cwd', opts.cwd] : [])]);
      }
      const def = resourceOrFail(resource, 'install');
      if (names.length === 0) fail(`aura install ${shortName(def)} <name…>`);
      switch (def.name) {
        case 'apps':         return dispatchEach(names.map((n) => ['app', 'install', n]));
        case 'capabilities': return dispatch(['cap', 'install', ...names]);
        case 'services':     return dispatchEach(names.map((n) => ['service', 'install', n]));
        default:             unsupported('install', def);
      }
    });

  for (const [verb, desc] of [
    ['enable', 'Enable apps — re-arm autoStart/warmPool, show them in dock + launcher.'],
    ['disable', 'Disable apps — stop every instance, hide them from dock + launcher.'],
  ] as const) {
    program
      .command(`${verb} <resource> <names...>`)
      .description(desc)
      .addHelpText('after', resourcesLine(verb) + examples([`aura ${verb} app com.aura.notepad`]))
      .action(async (resource: string, names: string[]) => {
        resourceOrFail(resource, verb);
        await dispatchEach(names.map((n) => ['app', verb, n]));
      });
  }

  program
    .command('open <resource> <instance>')
    .description('Open a new activity (window) on a running instance.')
    .option('-d, --data <json>', "JSON passed to the app's onActivityCreate hook")
    .addHelpText('after', resourcesLine('open') + examples(['aura open act com.aura.notepad', `aura open act com.aura.notepad -d '{"view":"x"}'`]))
    .action(async (resource: string, instance: string, opts: { data?: string }) => {
      resourceOrFail(resource, 'open');
      const inst = await resolveInstance(instance);
      await dispatch(['activity', 'open', inst.instanceId, ...(opts.data ? ['-d', opts.data] : [])]);
    });

  program
    .command('exec <resource> <name> [cmd...]')
    .description('Shell into an instance (or one of its sidecars with -c); run a command after --.')
    .option('-c, --container <sidecar>', 'Target a sidecar of the instance (ID from: aura get inst <id> sidecars)')
    .addHelpText('after', resourcesLine('exec') + examples([
      'aura exec inst com.aura.terminal',
      'aura exec inst com.aura.terminal -- ls -la',
      'aura exec inst io.lakner.hermes -c runtime',
      'aura exec inst io.lakner.hermes -c runtime -- hermes --version',
    ]))
    .action(async (resource: string, name: string, cmd: string[], opts: { container?: string }) => {
      await execCmd(resource, name, cmd, opts);
    });

  program
    .command('logs <resource> <name>')
    .description('Print logs of an instance sidecar (-c) or a service.')
    .option('-c, --container <sidecar>', 'Sidecar of the instance')
    .option('-f, --follow', 'Follow new output')
    .option('--tail <n>', 'Only the last n lines (sidecars)')
    .addHelpText('after', resourcesLine('logs') + examples(['aura logs inst io.lakner.hermes -c runtime --tail 100 -f']))
    .action(async (resource: string, name: string, opts: { container?: string; follow?: boolean; tail?: string }) => {
      await logsCmd(resource, name, opts);
    });

  program
    .command('grant <resource> [app] [names...]')
    .description('Grant permissions or capabilities to an app (picker when names are omitted).')
    .option('-i, --interactive', 'caps: open the picker even when names are given')
    .addHelpText('after', resourcesLine('grant') + examples([
      'aura grant perm com.aura.terminal apps.mount',
      'aura grant cap com.example.hello ripgrep jq',
      'aura grant perm                                  # interactive',
    ]))
    .action(async (resource: string, app: string | undefined, names: string[], opts: { interactive?: boolean }) => {
      const def = resourceOrFail(resource, 'grant');
      const rest = [...(app ? [app] : []), ...names];
      if (def.name === 'permissions') return dispatch(['app', 'perm', 'grant', ...rest]);
      if (def.name === 'capabilities') return dispatch(['cap', 'grant', ...rest, ...(opts.interactive ? ['-i'] : [])]);
      unsupported('grant', def);
    });

  program
    .command('revoke <resource> <app> <names...>')
    .description('Revoke permissions or capabilities from an app.')
    .addHelpText('after', resourcesLine('revoke') + examples(['aura revoke perm com.aura.terminal apps.mount', 'aura revoke cap com.example.hello jq']))
    .action(async (resource: string, app: string, names: string[]) => {
      const def = resourceOrFail(resource, 'revoke');
      if (def.name === 'permissions') return dispatch(['app', 'perm', 'revoke', app, ...names]);
      if (def.name === 'capabilities') return dispatch(['cap', 'revoke', app, ...names]);
      unsupported('revoke', def);
    });

  program
    .command('set <resource> <value>')
    .description('Change a setting — today: the active theme.')
    .option('--tone <tone>', "themes: 'dark' or 'light' slot", 'dark')
    .addHelpText('after', resourcesLine('set') + examples(['aura set theme nord', 'aura set theme paper --tone light']))
    .action(async (resource: string, value: string, opts: { tone: string }) => {
      resourceOrFail(resource, 'set');
      await dispatch(['theme', 'set', value, '--tone', opts.tone]);
    });

  program
    .command('run <appId>')
    .description('Start an app; prints the new instance id.')
    .addHelpText('after', examples(['aura run com.aura.notepad']))
    .action(async (appId: string) => {
      await dispatch(['app', 'start', appId]);
    });

  program
    .command('api-resources')
    .description('List every resource type with its short names and the verbs it supports.')
    .action(() => {
      console.log(table(RESOURCES.map((r) => ({
        NAME: r.name,
        SHORTNAMES: r.aliases.join(','),
        VERBS: r.verbs.join(','),
        DESCRIPTION: r.description,
      })), ['NAME', 'SHORTNAMES', 'VERBS', 'DESCRIPTION']));
    });
}
