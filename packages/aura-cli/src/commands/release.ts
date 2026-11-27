import type { Command } from 'commander';
import { fail } from '../lib/format.js';

/**
 * `aura release` (Phase 6, registered in Stage 1b; stream U fills it in, stream L the Normal-mode
 * side): the locked releases of a Normal-mode install. Until then every subcommand says so and
 * exits 1; nothing is called. Docs: the release pages arrive with stream U.
 *
 *   aura release status              the current and previous release, channel, provenance, updates
 *   aura release ls                  the releases on disk
 *   aura release build [ref]         build a release (the owner decides)
 *   aura release activate <id>       switch to a built release (approval system.release.activate)
 *   aura release rollback            back to the previous release (data restore only on request)
 */
const NOT_YET = 'arrives with Phase 6 (streams U and L: locked releases, updates, rollback). '
  + 'Developer Mode keeps `aura dev rebuild`.';

export function registerRelease(program: Command): void {
  const release = program
    .command('release')
    .description('Locked releases of a Normal-mode install: status, build, activate, rollback (Phase 6).');
  const stub = (name: string) => () => fail(`aura release ${name}: ${NOT_YET}`);
  release.command('status').description('The current and previous release, channel, provenance and available updates.').action(stub('status'));
  release.command('ls').description('The releases on disk.').action(stub('ls'));
  release.command('build [ref]').description('Build a release from the update channel (the owner decides).').action(stub('build'));
  release.command('activate <id>').description('Switch to a built release (the owner approves the exact release).').action(stub('activate'));
  release.command('rollback').description('Switch back to the previous release; restoring its data is a separate choice.').action(stub('rollback'));
}
