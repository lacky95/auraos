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
import { api, shellUrl, subscribeEvents } from '../lib/client.js';
import { color, fail, table } from '../lib/format.js';
import { enterSidecar } from '../lib/enter-sandbox.js';
import { BACK, PromptCancelled, promptConfirm, promptMultiSelect } from '../lib/prompts.js';
import { parseOutput, renderDocument, renderObjects, type OutputFormat } from '../lib/output.js';
import { ownersOf, resolveInstance, resolveSidecar } from '../lib/resolve.js';
import {
  RESOURCES, fetchApps, findResource, fetchSidecars, liveInstances, resourcesFor, shortName, sidecarId, sidecarMatches,
  type Ctx, type MountDto, type PortDto, type ResourceDef,
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

// ─── OS-sidecar API (token) ─────────────────────────────────────────────────

/**
 * The bearer for the token-gated sidecar routes — only when the CLI runs
 * inside that very instance (or one of its OS sidecars), where the OS put
 * AURA_INSTANCE_TOKEN in the env. Everywhere else there is no token, by design.
 */
function ownToken(instanceId: string): string | null {
  const token = process.env['AURA_INSTANCE_TOKEN'];
  const self = process.env['APP_INSTANCE_ID'] ?? process.env['AURA_INSTANCE_ID'];
  return token && self === instanceId ? token : null;
}

async function sidecarApi<T>(method: string, instanceId: string, path: string, token: string): Promise<T> {
  const res = await fetch(`${shellUrl()}/api/instances/${encodeURIComponent(instanceId)}/sidecars${path}`, {
    method, headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) fail((data as { error?: string } | undefined)?.error ?? `${method} failed with ${res.status}`);
  return data as T;
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
  if (def.name === 'services') {
    return dispatch(['service', 'logs', name, ...(opts.follow ? ['-f'] : []), ...(opts.tail ? ['--tail', opts.tail] : [])]);
  }
  if (def.name === 'sidecars') fail('use: aura logs inst <instanceId> -c <sidecar>');
  const inst = await resolveInstance(name);
  if (!opts.container) {
    // The app's own output. A container instance's stdout/stderr are what
    // `docker logs` holds; a PRoot instance has no container — its output
    // only goes into the shell's log, prefixed with [<instanceId>].
    if (inst.sandbox !== 'container') {
      fail(`${inst.instanceId} runs in a PRoot sandbox — its output is in the shell log: docker logs aura-shell 2>&1 | grep '\\[${inst.instanceId}\\]'`);
    }
    return dockerLogs(`aura-${inst.instanceId}`, opts);
  }
  const sc = await resolveSidecar(inst.instanceId, opts.container);
  // Inside the app that owns an OS sidecar: the OS reads the logs, no docker needed.
  const token = sc.managedBy === 'os' && !opts.follow ? ownToken(inst.instanceId) : null;
  if (token) {
    const q = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : '';
    const out = await sidecarApi<{ stdout: string; stderr: string }>('GET', inst.instanceId, `/${encodeURIComponent(sc.service)}/logs${q}`, token);
    process.stdout.write(out.stdout);
    process.stderr.write(out.stderr);
    return;
  }
  return dockerLogs(sc.id, opts);
}

/** `docker logs` passthrough (needs the docker CLI + socket in the caller). */
async function dockerLogs(container: string, opts: { follow?: boolean; tail?: string }): Promise<void> {
  const args = ['logs', ...(opts.tail ? ['--tail', opts.tail] : []), ...(opts.follow ? ['-f'] : []), container];
  const child = spawn('docker', args, { stdio: 'inherit' });
  await new Promise<void>((resolveP) => {
    child.on('exit', (code) => { process.exitCode = code ?? 0; resolveP(); });
    child.on('error', (err) => fail(
      `docker logs failed: ${err.message}\n  Hint: reading container logs needs the docker CLI and a bound /var/run/docker.sock.`,
    ));
  });
}

// ─── start / restart / rm by id ─────────────────────────────────────────────

/**
 * `aura start inst <id>`: a paused instance is resumed; the id of a stopped
 * single-instance app (whose instance id IS the app id) starts the app.
 * Anything else has no "start" — stopped instances are gone, not parked.
 */
async function startInstance(token: string): Promise<void> {
  const apps = await fetchApps();
  const inst = apps.flatMap((a) => a.instances).find((i) => i.instanceId === token);
  if (inst) {
    if (inst.state === 'paused') return dispatch(['inst', 'resume', inst.instanceId]);
    if (['resumed', 'started', 'created', 'resuming', 'starting', 'creating'].includes(inst.state)) {
      console.log(`${color.dim('•')} ${inst.instanceId} is already running (${inst.state})`);
      return;
    }
    fail(`${inst.instanceId} is ${inst.state} — use: aura restart inst ${inst.instanceId}`);
  }
  const app = apps.find((a) => a.manifest.id === token);
  if (app && (app.manifest.instanceMode ?? 'single') === 'single') return dispatch(['app', 'start', token]);
  if (app) fail(`${token} is a multi-instance app — start a new instance with: aura run ${token}`);
  fail(`no instance '${token}' — stopped instances are gone; start the app again with: aura run <app>`);
}

/** Stop an instance and start a fresh one of its app (a multi-instance app gets a new id). */
async function restartInstance(token: string): Promise<void> {
  const inst = await resolveInstance(token);
  await dispatch(['inst', 'stop', inst.instanceId]);
  await dispatch(['app', 'start', inst.appId]);
}

/**
 * The instance was inferred, not named — say which one before removing
 * anything there: a confirm on a TTY, `-y` (or naming it with -i) otherwise.
 */
async function confirmInferred(what: string, owner: string, yes: boolean | undefined, nameIt: string): Promise<boolean> {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(`${what} ${owner}? Confirm with -y, or name it: ${nameIt}`);
  }
  try {
    const ok = await promptConfirm(`${what} ${color.bold(owner)}?`, false);
    if (ok !== true) console.log(`${color.dim('•')} aborted`);
    return ok === true;
  } catch (err) {
    if (err instanceof PromptCancelled) { console.log(`${color.dim('•')} aborted`); return false; }
    throw err;
  }
}

/** `aura rm mount <id>` without -i: the one instance that has it, else ask. */
async function deleteMountById(id: string, yes: boolean | undefined): Promise<void> {
  const all = (await findResource('mounts')!.list({})) as MountDto[];
  // Sidecar consumers (`<inst>--<sc>`) are listed too, but detached through their app.
  const owners = ownersOf(all.filter((m) => !m.instanceId.includes('--')), id, (m) => m.instanceId,
    (m, want) => m.id === want || m.targetAppId === want);
  if (owners.length === 0) fail(`no mount '${id}' in any running instance (see: aura get mounts)`);
  if (owners.length > 1) fail(`'${id}' is mounted into ${owners.length} instances — pick one with -i:\n  ${owners.join('\n  ')}`);
  if (!await confirmInferred(`Detach ${id} from`, owners[0]!, yes, `aura rm mount ${id} -i ${owners[0]}`)) return;
  await dispatch(['mount', 'rm', id, '--instance', owners[0]!]);
}

/** `aura rm port <id>` without the owner: the one instance that has it, else ask. */
async function deletePortById(id: string, yes: boolean | undefined): Promise<void> {
  const all = (await findResource('ports')!.list({})) as PortDto[];
  const owners = ownersOf(all, id, (p) => p.ownerInstanceId, (p, want) => p.id === want);
  if (owners.length === 0) fail(`no port expose '${id}' (see: aura get ports)`);
  if (owners.length > 1) fail(`'${id}' exists on ${owners.length} instances — use: aura rm port <ownerApp> ${id}\n  ${owners.join('\n  ')}`);
  // The pair form names the owner by APP id (port rm resolves it to its instance).
  const ownerApp = (await fetchApps()).flatMap((a) => a.instances).find((i) => i.instanceId === owners[0])?.appId ?? owners[0]!;
  if (!await confirmInferred(`Remove port expose ${id} from`, owners[0]!, yes, `aura rm port ${ownerApp} ${id}`)) return;
  try {
    await api.del(`/api/instances/${encodeURIComponent(owners[0]!)}/ports/${encodeURIComponent(id)}`);
  } catch (err) { fail((err as Error).message); }
  console.log(`${color.green('✓')} removed ${id} from ${owners[0]}`);
}

/** `aura install cap` without names: pick from the registry's not-yet-installed capabilities. */
async function installCapsInteractive(def: ResourceDef): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('aura install cap <name…>  (no TTY for the picker)');
  const caps = (await def.list({})) as Array<{ name: string; source: string; installed: boolean }>;
  const available = caps.filter((c) => !c.installed);
  if (available.length === 0) { console.log(`${color.dim('•')} every capability in the registry is already installed`); return; }
  try {
    const res = await promptMultiSelect<string>('Install which capabilities?', [{
      label: 'capabilities',
      options: available.map((c) => ({ value: c.name, label: c.name, tag: color.dim(c.source) })),
    }], 0, { allowBack: true });
    if (res === BACK || res.selected.length === 0) { console.log(`${color.dim('•')} nothing selected`); return; }
    await dispatch(['cap', 'install', ...res.selected]);
  } catch (err) {
    if (err instanceof PromptCancelled) { console.log(`${color.dim('•')} cancelled`); return; }
    throw err;
  }
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
    .description('Start apps (a new instance each), paused instances, or services.')
    .addHelpText('after', resourcesLine('start') + examples([
      'aura start app com.aura.notepad          # = aura run',
      'aura start inst com.aura.browser-2       # resumes it if paused',
      'aura start svc code-server',
    ]))
    .action(async (resource: string, names: string[]) => {
      const def = resourceOrFail(resource, 'start');
      if (def.name === 'apps') return dispatchEach(names.map((n) => ['app', 'start', n]));
      if (def.name === 'services') return dispatchEach(names.map((n) => ['service', 'start', n]));
      for (const n of names) await startInstance(n);
    });

  program
    .command('restart <resource> <names...>')
    .description('Restart apps (all instances → one fresh), single instances, or services.')
    .addHelpText('after', resourcesLine('restart') + examples([
      'aura restart app com.aura.notepad',
      'aura restart inst com.aura.terminal-13   # stop it, start a fresh instance of its app',
      'aura restart svc sshd',
    ]))
    .action(async (resource: string, names: string[]) => {
      const def = resourceOrFail(resource, 'restart');
      if (def.name === 'apps') return dispatchEach(names.map((n) => ['app', 'restart', n]));
      if (def.name === 'services') return dispatchEach(names.flatMap((n) => [['service', 'stop', n], ['service', 'start', n]]));
      for (const n of names) await restartInstance(n);
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
    .option('-y, --yes', 'skip the confirmation (apps; mounts/ports whose instance was inferred)')
    .option('-i, --instance <id>', 'mounts, sc: instance (default: $APP_INSTANCE_ID)')
    .addHelpText('after', resourcesLine('delete') + examples([
      'aura delete app com.example.hello',
      'aura delete act act-12',
      'aura rm mount com.example.hello                  # the instance that has it (-i when several do)',
      'aura rm port into-5173                           # ids from: aura get ports',
      'aura delete sc worker-7                          # an OS sidecar of the app you are in',
    ]))
    .action(async (resource: string, names: string[], opts: { yes?: boolean; instance?: string }) => {
      const def = resourceOrFail(resource, 'delete');
      switch (def.name) {
        case 'apps':         return dispatchEach(names.map((n) => ['app', 'remove', n, ...(opts.yes ? ['-y'] : [])]));
        case 'activities':   return dispatchEach(names.map((n) => ['activity', 'close', n]));
        case 'services':     return dispatchEach(names.map((n) => ['service', 'uninstall', n]));
        case 'capabilities': return dispatchEach(names.map((n) => ['cap', 'remove', n]));
        case 'mounts': {
          const scope = opts.instance ?? process.env['APP_INSTANCE_ID'];
          if (scope) {
            const inst = await instanceScope(scope);
            return dispatch(['mount', 'rm', ...names, '--instance', inst!]);
          }
          for (const n of names) await deleteMountById(n, opts.yes);
          return;
        }
        case 'ports': {
          // Old pair form `<ownerApp> <portId>` still works.
          if (names.length === 2 && (await fetchApps()).some((a) => a.manifest.id === names[0])) {
            return dispatch(['port', 'rm', names[0]!, names[1]!]);
          }
          for (const n of names) await deletePortById(n, opts.yes);
          return;
        }
        case 'sidecars': {
          const instToken = opts.instance ?? process.env['APP_INSTANCE_ID'];
          if (!instToken) fail('aura delete sc <id> -i <instance>');
          const inst = await resolveInstance(instToken);
          for (const n of names) {
            const sc = await resolveSidecar(inst.instanceId, n);
            if (sc.managedBy !== 'os') fail(`${sidecarId(sc)} is app-managed — ${inst.appId} runs it itself; stop it there (or stop the instance)`);
            const token = ownToken(inst.instanceId);
            if (!token) fail(`deleting an OS sidecar needs ${inst.instanceId}'s token — run this inside the app (aura jump ${inst.instanceId}), or stop the instance`);
            await sidecarApi('DELETE', inst.instanceId, `/${encodeURIComponent(sc.service)}`, token);
            console.log(`${color.green('✓')} deleted sidecar ${sidecarId(sc)} of ${inst.instanceId}`);
          }
          return;
        }
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
      'aura install cap                         # picker: what is not installed yet',
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
      if (names.length === 0 && def.name === 'capabilities') return installCapsInteractive(def);
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
    .description('Open a new window (activity) on a running instance.')
    .option('-d, --data <json>', "JSON passed to the app's onActivityCreate hook")
    .addHelpText('after', resourcesLine('open') + examples(['aura open inst com.aura.notepad', `aura open inst com.aura.notepad -d '{"view":"x"}'`]))
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
    .description('Print the output of an instance (container sandbox), one of its sidecars (-c), or a service.')
    .option('-c, --container <sidecar>', 'Sidecar of the instance')
    .option('-f, --follow', 'Follow new output')
    .option('--tail <n>', 'Only the last n lines')
    .addHelpText('after', resourcesLine('logs') + examples([
      'aura logs inst com.aura.terminal --tail 50',
      'aura logs inst io.lakner.hermes -c runtime --tail 100 -f',
      'aura logs svc sshd -f',
    ]))
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
