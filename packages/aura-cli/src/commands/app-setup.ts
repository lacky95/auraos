import type { Command } from 'commander';
import { fail } from '../lib/format.js';

/**
 * `aura app setup|config|profile` (D108): the CLI client of the setup engine
 * (`/api/apps/<id>/setup/**`, core setup/contracts.ts). Non-interactive with
 * `--profile` and `--values`; secrets only by vault handle
 * (`--secret <field>=@vault:<handle>`), never a value on the command line.
 * Approvals are never skipped (no `--yes`): an agent without a TTY gets exit
 * 75 (on hold, D102), a TTY waits, the host operator decides with `aura
 * approve`. Exit codes: 3 needs setup or blocked, 5 invalid input, 75 on hold.
 *
 * D108 P0: the command tree and its options (the contract); P5 implements the
 * actions.
 */

/** Exit when the app needs setup or is blocked (D105 `needs-setup`). */
export const EXIT_NEEDS_SETUP = 3;
/** Exit on invalid values, an unknown profile or field (D105 `invalid-request`). */
export const EXIT_INVALID_INPUT = 5;

const notYet = (): never => fail('app setup is not implemented yet (D108 P5)');

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];

export function registerAppSetup(app: Command): void {
  app
    .command('setup <app>')
    .description('Set up an app that declares setup or operating profiles (resumes where it stopped).')
    .option('--profile <id>', 'the operating profile (required non-interactively when the app has more than one feasible profile)')
    .option('--values <file>', 'a JSON file of field values')
    .option('--secret <field=@vault:handle>', 'a secret field by vault handle (repeatable)', collect)
    .option('--resume', 'continue an interrupted setup at its recorded step')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(notYet);

  const config = app.command('config').description('Read or change an app\'s setup values (secrets show as handles only).');
  config
    .command('get <app>')
    .description('Show the desired and effective setup values, the state and what is degraded.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(notYet);
  config
    .command('set <app> [assignments...]')
    .description('Change setup values (field=value); a change that adds privileges asks the owner.')
    .option('--values <file>', 'a JSON file of field values')
    .option('--secret <field=@vault:handle>', 'a secret field by vault handle (repeatable)', collect)
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(notYet);

  const profile = app.command('profile').description('List or change an app\'s operating profile.');
  profile
    .command('ls <app>')
    .alias('list')
    .description('List the app\'s operating profiles, which are available here and why not.')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(notYet);
  profile
    .command('use <app> <profile>')
    .description('Switch to another operating profile (shows what changes; data stays where it is).')
    .option('--values <file>', 'a JSON file of field values')
    .option('-o, --output <format>', 'json for machine-readable output')
    .action(notYet);
}
