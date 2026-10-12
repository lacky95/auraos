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
import { LEGACY_GROUPS, markLegacy } from './lib/deprecate.js';
import { color, visibleWidth } from './lib/format.js';
import { RESOURCES, fetchApps, findResource, liveInstances } from './lib/resources.js';

export const VERSION = '0.1.0';

/** Main-help sections, in display order. Visible commands not listed land in "Other". */
export const HELP_GROUPS: Array<{ title: string; commands: string[] }> = [
  { title: 'Basic commands', commands: ['ps', 'run', 'jump', 'info', 'status'] },
  {
    title: 'Resource commands (kubectl-style: aura <verb> <resource> [name])',
    commands: ['get', 'describe', 'stop', 'start', 'restart', 'kill', 'pause', 'resume', 'delete',
      'install', 'enable', 'disable', 'open', 'exec', 'logs', 'grant', 'revoke', 'set', 'api-resources'],
  },
  { title: 'Tools', commands: ['mount', 'port', 'cap', 'nexus', 'dev', 'events', 'data', 'completion'] },
];

const EXAMPLES = [
  'aura ps                                       # running instances',
  'aura run com.aura.notepad                     # start an app',
  'aura get apps                                 # installed apps (-o wide|json|yaml)',
  'aura get inst com.aura.browser-2 sidecars     # sidecars of an instance + their IDs',
  'aura jump io.lakner.hermes --sidecar runtime  # shell inside that sidecar',
  'aura describe inst com.aura.terminal',
  'aura stop app com.aura.notepad',
];

function rootHelp(program: Command, helper: Help): string {
  const visible = program.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden);
  const byName = new Map(visible.map((c) => [c.name(), c]));
  const term = (c: Command) => helper.subcommandTerm(c).replace(' [options]', '');
  const width = Math.max(...visible.map((c) => visibleWidth(term(c)))) + 2;
  const line = (left: string, right: string) => `  ${left.padEnd(width)}${right}`;

  // One line per command: the explicit summary, else the description's first sentence.
  const blurb = (c: Command) => (c.summary() || c.description()).split(/(?<=\.)\s/)[0]!;

  const out: string[] = [
    `${color.bold('aura')} — AuraOS control CLI`,
    '',
    `Usage: aura <command> [options]`,
    '',
  ];
  const listed = new Set<string>();
  for (const g of HELP_GROUPS) {
    const cmds = g.commands.map((n) => byName.get(n)).filter((c): c is Command => Boolean(c));
    if (cmds.length === 0) continue;
    out.push(color.bold(`${g.title}:`));
    for (const c of cmds) { out.push(line(term(c), blurb(c))); listed.add(c.name()); }
    out.push('');
  }
  const rest = visible.filter((c) => !listed.has(c.name()) && c.name() !== 'help');
  if (rest.length) {
    out.push(color.bold('Other:'));
    for (const c of rest) out.push(line(term(c), blurb(c)));
    out.push('');
  }

  out.push(color.bold('Resource types') + color.dim('  (aura api-resources — short names work everywhere):'));
  const rw = Math.max(...RESOURCES.map((r) => r.name.length)) + 2;
  for (const r of RESOURCES) out.push(`  ${r.name.padEnd(rw)}${color.dim(r.aliases.join(', ').padEnd(28))}${r.description}`);
  out.push('');

  out.push(color.bold('Examples:'));
  for (const e of EXAMPLES) out.push(`  ${e}`);
  out.push('');

  out.push(color.bold('Global options:'));
  for (const o of program.options) out.push(line(helper.optionTerm(o), o.description));
  out.push(line('-h, --help', 'Show help; `aura <command> --help` for one command'));
  out.push('');
  out.push(color.dim('The pre-kubectl groups (aura app/inst/activity/service/theme/scope/whereami) still work, hidden.'));
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

  if (HELP_GROUPS[1]!.commands.includes(verbCmd.name()) && verbCmd.name() !== 'api-resources' && verbCmd.name() !== 'run') {
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
