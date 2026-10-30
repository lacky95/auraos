/**
 * Builds the `aura` command tree. A factory (not a module-level singleton) so
 * the kubectl verbs can re-run an old command group on a fresh program
 * (commands/verbs.ts `dispatch`) and tests can inspect the tree without
 * parsing argv.
 */
import { Command, Help } from 'commander';
import { registerApp } from './commands/app.js';
import { registerInst } from './commands/inst.js';
import { registerActivity } from './commands/activity.js';
import { registerPs } from './commands/ps.js';
import { registerStatus } from './commands/status.js';
import { registerCap } from './commands/cap.js';
import { registerService } from './commands/service.js';
import { registerDev } from './commands/dev.js';
import { registerTheme } from './commands/theme.js';
import { registerData } from './commands/data.js';
import { registerEvents } from './commands/events.js';
import { registerWhereami } from './commands/whereami.js';
import { registerJump } from './commands/jump.js';
import { registerMount } from './commands/mount.js';
import { registerPort } from './commands/port.js';
import { registerNexus } from './commands/nexus.js';
import { registerScope } from './commands/scope.js';
import { registerSdk } from './commands/sdk.js';
import { registerVerbs, setProgramFactory } from './commands/verbs.js';
import { registerAdmin, registerApiKey } from './commands/admin.js';
import { registerShellMode } from './commands/shellMode.js';
import { LEGACY_GROUPS, markLegacy } from './lib/deprecate.js';
import { color, visibleWidth } from './lib/format.js';
import { RESOURCES, fetchApps, findResource, liveInstances, shortName } from './lib/resources.js';

export const VERSION = '0.1.0';

/**
 * The main help page: one task-oriented list. Every line is a command that
 * exists in exactly that form — test/kubectl.test.ts checks each one against
 * the command tree and the resource registry, so this can't silently drift.
 */
export const HELP_SECTIONS: Array<{ title: string; lines: Array<[string, string]>; note?: string }> = [
  { title: 'Basics', lines: [
    ['aura jump', 'Pick a running app or service and shell into it'],
    ['aura jump <app|inst>', 'Shell into an app sandbox'],
    ['aura jump <app> --sidecar <name>', 'Shell into a sidecar'],
    ['aura mount', 'Pick apps to mount into a container, live (wizard)'],
    ['aura mount add <app...>', 'Mount apps into this app (--wr writable, --instance <inst>)'],
    ['aura cap grant', 'Pick the CLI tools an app may use'],
    ['aura dev new', 'Start the create-new-app wizard'],
    ['aura ps', 'Running instances (= aura get inst)'],
    ['aura run <app>', 'Start an app, print instance id'],
    ['aura status', 'Health: shell, apps, capabilities, services'],
    ['aura info', 'Execution context: layers, OS, env, mounts'],
  ] },
  { title: 'Inspect', note: 'Output for get: -o wide | json | yaml | name', lines: [
    ['aura get apps [name]', 'Installed apps + instance count'],
    ['aura get inst [name]', 'Running instances'],
    ['aura get inst <name> sidecars', 'Sidecars of one instance + their IDs'],
    ['aura get sidecars [name]', 'All sidecars'],
    ['aura get act [name]', 'Open windows of running instances'],
    ['aura get caps [name]', 'Shareable CLI capabilities'],
    ['aura get svc [name]', 'Services on the master (sshd, code-server …)'],
    ['aura get mounts [name]', 'Cross-app mounts'],
    ['aura get ports [name]', 'Port exposes (app-to-app or host)'],
    ['aura get scopes [name]', 'Install scopes (system / global / user)'],
    ['aura get themes [name]', 'Theme presets, ACTIVE marks the one in use'],
    ['aura get perms [app]', 'Declared manifest permissions'],
    ['aura describe <resource> <name>', 'Full YAML of one resource (-o json)'],
    ['aura logs inst <name>', 'Output of an instance (-f to follow)'],
    ['aura logs inst <name> -c <sidecar>', 'Logs of an instance sidecar'],
    ['aura logs svc <name>', 'Logs of a service'],
    ['aura events', 'Live stream of OS state changes'],
  ] },
  { title: 'Lifecycle', lines: [
    ['aura start|stop|restart app <app...>', 'Start, stop or restart an app (all its instances)'],
    ['aura start|stop|restart inst <inst...>', 'Start (resume), stop or restart single instances'],
    ['aura start|stop|restart svc <svc...>', 'Start, stop or restart services'],
    ['aura pause inst <inst...>', 'Pause instances (onPause)'],
    ['aura resume inst <inst...>', 'Resume paused instances (onResume)'],
    ['aura kill inst <inst...>', 'Force-kill (SIGKILL, no hooks)'],
    ['aura enable app <app...>', 'Re-arm autoStart/warmPool, show in dock + launcher'],
    ['aura disable app <app...>', 'Stop all instances, hide from dock + launcher'],
  ] },
  { title: 'Install & remove', lines: [
    ['aura install app <dir>', 'Install an app from a directory'],
    ['aura install cap [names...]', 'Install capabilities (picker if empty)'],
    ['aura install svc <name>', 'Install a service'],
    ['aura install sdk', 'Install the @aura/* SDK packages'],
    ['aura rm app <app...>', 'Delete apps'],
    ['aura rm act <act...>', 'Close windows'],
    ['aura rm svc <svc...>', 'Uninstall services'],
    ['aura rm cap <cap...>', 'Uninstall capabilities'],
    ['aura rm mount <mount...>', 'Detach mounts (-i <inst> if several have it)'],
    ['aura rm port <port...>', 'Remove port exposes (ids from aura get ports)'],
    ['aura rm sc <sidecar...>', 'Delete OS-managed sidecars (inside their app)'],
  ] },
  { title: 'Connect', lines: [
    ['aura exec inst <name>', 'Shell into an instance'],
    ['aura exec inst <name> -c <sidecar>', 'Shell into a sidecar'],
    ['aura exec inst <name> -- <cmd...>', 'Run a command'],
    ['aura open inst <name>', 'Open a new window on an instance'],
    ['aura mount ...', "Mount another app's files, live"],
    ['aura port ...', 'Expose a TCP port to an app or the host'],
    ['aura data ...', 'Query / write / watch content providers'],
  ] },
  { title: 'Access', lines: [
    ['aura grant perms <app> [names...]', 'Grant permissions (picker if empty)'],
    ['aura grant caps <app> [names...]', 'Grant capabilities (picker if empty)'],
    ['aura revoke perms <app> <names...>', 'Revoke permissions'],
    ['aura revoke caps <app> <names...>', 'Revoke capabilities'],
    ['aura grant|revoke caps … --template <t>', 'Caps of a sidecar template (persistent)'],
    ['aura grant|revoke caps … --sidecar <n>', 'Caps of one running OS sidecar (inside its app)'],
    ['aura cap ...', 'Manage the capability registry'],
    ['aura grant nperm <app> <locked|popup>', 'Grant Locked / pop-up notifications (admin)'],
    ['aura grant nperm <app> read --scope app:<id>|sender:<key>|all', "Let an app read other senders' notifications (--include-secret)"],
    ['aura revoke nperm <app> <locked|popup|read>', 'Revoke them again, takes effect at once'],
    ['aura get nperm [app]', 'Requested vs granted notification features'],
    ['aura admin login', 'Unlock admin with the shared credential (--save: 15 min)'],
    ['aura admin ...', 'logout · status · audit · credential · rotate (master)'],
    ['aura apikey ...', 'API keys for REST callers: create · ls · revoke (admin)'],
  ] },
  { title: 'Ecosystem & dev', lines: [
    ['aura nexus ...', 'Find, install, update, publish apps'],
    ['aura dev ...', 'Scaffold, validate, run apps standalone'],
  ] },
  { title: 'Settings', lines: [
    ['aura set theme <name>', 'Switch the active theme'],
    ['aura completion bash|zsh', 'eval "$(aura completion bash)"'],
    ['aura api-resources', 'All resource types, short names, verbs'],
  ] },
];

/** Verbs that take `<resource>` as their first argument (completion, tests). */
export const RESOURCE_VERBS = ['get', 'describe', 'start', 'stop', 'restart', 'kill', 'pause', 'resume', 'delete',
  'install', 'enable', 'disable', 'open', 'exec', 'logs', 'grant', 'revoke', 'set'];

const HELP_COL = 41;

function rootHelp(program: Command, helper: Help): string {
  const line = (left: string, right: string) => `  ${left}${' '.repeat(Math.max(2, HELP_COL - visibleWidth(left)))}${right}`;
  const out: string[] = [
    `${color.bold('aura')} — control AuraOS from the terminal`,
    '',
    'Usage: aura <command> [resource] [name...] [flags]',
    '       aura <command> --help',
    '',
  ];
  for (const s of HELP_SECTIONS) {
    out.push('', color.bold(s.title));
    for (const [usage, desc] of s.lines) out.push(line(usage, desc));
    if (s.note) out.push(`  ${color.dim(s.note)}`);
  }
  // From the registry, so a new resource type shows up here by itself.
  out.push('', `${color.bold('Short names:')} ${RESOURCES.map((r) => shortName(r)).join(' ')}`);
  out.push('', color.bold('Flags'));
  for (const o of program.options.filter((x) => x.long !== '--version')) {
    const desc = o.long === '--shell-url' ? 'Default: $OS_API_BASE or http://127.0.0.1:3000' : o.description;
    out.push(line(helper.optionTerm(o), desc));
  }
  out.push(line('-V, --version', 'Print version'));
  out.push(line('-h, --help', 'Show help'));
  return out.join('\n') + '\n';
}

// ─── Completion ──────────────────────────────────────────────────────────────

/** Options whose next word is a value, not a positional — skipped when completing. */
const VALUE_OPTS = new Set(['-o', '--output', '-a', '--app', '-i', '--instance', '-c', '--container', '-s', '--sidecar',
  '--tail', '-d', '--data', '--tone', '--shell-url', '--registry', '--cwd']);

/** Verbs whose second positional is an object name we can list live. */
const NAMED_VERBS = new Set(['get', 'describe', 'stop', 'kill', 'pause', 'resume', 'restart', 'exec', 'logs',
  'enable', 'disable', 'delete', 'open', 'grant', 'revoke', 'start', 'set']);

export async function completions(program: Command, rawWords: string[]): Promise<string[]> {
  const words: string[] = [];
  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i]!;
    if (VALUE_OPTS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    words.push(w);
  }
  const visible = program.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden && c.name() !== '__complete');
  if (words.length === 0) return visible.map((c) => c.name());

  const verb = words[0]!;
  const verbCmd = program.commands.find((c) => c.name() === verb || c.aliases().includes(verb));
  if (!verbCmd) return [];

  if (RESOURCE_VERBS.includes(verbCmd.name())) {
    if (words.length === 1) {
      const names = RESOURCES.filter((r) => r.verbs.includes(verbCmd.name())).flatMap((r) => [r.name, ...r.aliases]);
      return verbCmd.name() === 'install' ? [...names, 'sdk'] : names;
    }
    if (words.length === 2 && NAMED_VERBS.has(verbCmd.name())) {
      const def = findResource(words[1]!);
      if (!def) return [];
      try { return (await withTimeout(def.list({}), 2000)).map((o) => def.nameOf(o)); } catch { return []; }
    }
    if (words.length === 3 && verbCmd.name() === 'get' && findResource(words[1]!)?.name === 'instances') return ['sidecars'];
    return [];
  }
  if ((verbCmd.name() === 'jump' || verbCmd.name() === 'run') && words.length === 1) {
    try {
      const apps = await withTimeout(fetchApps(), 2000);
      return verbCmd.name() === 'run'
        ? apps.map((a) => a.manifest.id)
        : [...new Set([...apps.map((a) => a.manifest.id), ...liveInstances(apps).map((i) => i.instanceId)])];
    } catch { return []; }
  }
  // Classic groups: complete their subcommand names.
  let cmd: Command = verbCmd;
  for (const w of words.slice(1)) {
    const next = cmd.commands.find((c) => c.name() === w || c.aliases().includes(w));
    if (!next) return [];
    cmd = next;
  }
  return cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden).map((c) => c.name());
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

const BASH_COMPLETION = `_aura_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local IFS=$'\\n'
  COMPREPLY=( $(compgen -W "$(aura __complete "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)" -- "$cur") )
}
complete -o default -F _aura_complete aura
`;

// ─── Program ─────────────────────────────────────────────────────────────────

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('aura')
    .description('AuraOS control CLI — manage apps, instances, sidecars, capabilities and OS state.')
    .version(VERSION)
    .option('--shell-url <url>', 'Override AuraOS shell URL (default: $OS_API_BASE or http://127.0.0.1:3000)')
    // Inherited by every subcommand created below: a stray extra argument is
    // an error instead of being silently dropped (`aura jump foo` used to open
    // the picker and ignore `foo`).
    .allowExcessArguments(false)
    .showHelpAfterError(color.dim('(run with --help for usage)'))
    .configureHelp({
      formatHelp: (cmd, helper) => (cmd === program ? rootHelp(program, helper) : Help.prototype.formatHelp.call(helper, cmd, helper)),
    })
    .hook('preAction', (thisCmd) => {
      const url = thisCmd.opts()['shellUrl'];
      if (typeof url === 'string') process.env['AURA_SHELL_URL'] = url;
    });

  registerPs(program);
  registerStatus(program);
  registerWhereami(program);
  registerJump(program);
  registerVerbs(program);
  registerMount(program);
  registerPort(program);
  registerCap(program);
  registerNexus(program);
  registerDev(program);
  registerEvents(program);
  registerData(program);
  registerAdmin(program);
  registerShellMode(program);
  registerApiKey(program);
  // Pre-kubectl groups: registered so they keep working, then hidden.
  registerApp(program);
  registerInst(program);
  registerActivity(program);
  registerService(program);
  registerTheme(program);
  registerScope(program);
  registerSdk(program);
  for (const g of LEGACY_GROUPS) markLegacy(program, g);

  program
    .command('completion <shell>')
    .description('Print a shell completion script (bash | zsh): eval "$(aura completion bash)"')
    .action((shell: string) => {
      if (shell === 'bash') process.stdout.write(BASH_COMPLETION);
      else if (shell === 'zsh') process.stdout.write(`#compdef aura\nautoload -U +X bashcompinit && bashcompinit\n${BASH_COMPLETION}`);
      else { console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`); process.exit(1); }
    });

  program
    .command('__complete [words...]', { hidden: true })
    .allowExcessArguments(true)
    .action(async (words: string[]) => {
      const out = await completions(program, words ?? []);
      if (out.length) process.stdout.write(out.join('\n') + '\n');
    });

  setProgramFactory(buildProgram);
  return program;
}
