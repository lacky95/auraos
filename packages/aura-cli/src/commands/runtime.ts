/**
 * `aura runtime ls|show <id>|set <id> k=v|enable|disable|default <id>`,
 * `aura runtime override ls|rm <app>` and `aura runtime migrate` (Phase 5
 * stream R, ARI). Registered once in program.ts (Stage 1), so the stream adds
 * its commands here and touches no registry. Adds nothing yet.
 */
import type { Command } from 'commander';

export function registerRuntime(program: Command): void {
  void program;
}
