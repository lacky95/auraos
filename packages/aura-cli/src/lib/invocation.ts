/**
 * The invocation pre-parse (D109 AF3): what the command line selects before
 * commander parses it.
 *
 * `--agent` is reserved for the agent interface (D109; the Addendum: an
 * interface selector, never an authorization). No command may define an
 * option of that name (test/invocation.test.ts walks the tree). Until the
 * agent interface exists, `src/index.ts` answers an `--agent` with a usage
 * error and runs nothing. Without `--agent` the human CLI is untouched: the
 * same tree, the same parse, the same output.
 *
 * Argument boundaries are respected, so a literal `--agent` that belongs to
 * something else is never taken:
 *   - nothing after a bare `--` (`aura exec inst x -- tool --agent`);
 *   - nothing that is the value of an option taking one
 *     (`aura dev new x --description --agent`), walking the command path the
 *     way commander resolves it (subcommands and aliases, without running
 *     anything).
 */
import type { Command, Option } from 'commander';

export interface Invocation {
  /** `--agent` was given (as an option, not as a literal). */
  agent: boolean;
  /** A usage problem with it, e.g. `--agent=x` (it takes no value). */
  agentError?: string;
  /** `-h` / `--help` was given as an option. */
  help: boolean;
  /** The command path it resolves to, e.g. `['dev', 'new']`. */
  path: string[];
  /** The arguments without `--agent`. */
  args: string[];
}

export const AGENT_FLAG = '--agent';
/** A usage error (commander's own errors exit 1; nothing else uses 2). */
export const EXIT_USAGE = 2;

function findOption(chain: readonly Command[], flag: string): Option | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const o = chain[i]!.options.find((opt) => opt.long === flag || opt.short === flag);
    if (o) return o;
  }
  return undefined;
}

const findSub = (cmd: Command, name: string): Command | undefined =>
  cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));

/** Pure: reads `program`'s tree, runs nothing. `args` is argv without node and the script. */
export function parseInvocation(args: readonly string[], program: Command): Invocation {
  const chain: Command[] = [program];
  const path: string[] = [];
  const out: string[] = [];
  let agent = false;
  let agentError: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === '--') { out.push(...args.slice(i)); break; }
    if (tok === AGENT_FLAG) { agent = true; continue; }
    if (tok.startsWith(`${AGENT_FLAG}=`)) { agent = true; agentError = `${AGENT_FLAG} takes no value`; continue; }
    out.push(tok);
    if (tok === '-h' || tok === '--help') { help = true; continue; }
    if (tok.startsWith('-') && tok.length > 1) {
      // `--opt=value` and `-ovalue` carry their value; otherwise the next token may be it.
      if (tok.includes('=') || (!tok.startsWith('--') && tok.length > 2)) continue;
      const opt = findOption(chain, tok);
      const next = args[i + 1];
      if (opt && next !== undefined && (opt.required || (opt.optional && !next.startsWith('-')))) { out.push(next); i++; }
      continue;
    }
    const sub = findSub(chain[chain.length - 1]!, tok);
    if (sub) { chain.push(sub); path.push(sub.name()); }
  }
  return { agent, ...(agentError ? { agentError } : {}), help, path, args: out };
}

/** What `aura … --agent` answers until the agent interface exists. Nothing was run. */
export function agentUnavailableText(inv: Invocation): string {
  const cmd = ['aura', ...inv.path].join(' ');
  return inv.agentError
    ? `error: ${inv.agentError}\n`
    : `error: ${AGENT_FLAG} selects the agent interface, which this version of aura does not have yet. Nothing was run.\n`
      + `Run the command without ${AGENT_FLAG}; \`${cmd} --help\` shows its usage.\n`;
}
