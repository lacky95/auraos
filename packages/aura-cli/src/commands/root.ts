/**
 * `aura root`: the dedicated root tab with the Docker socket in that tab only
 * (Phase 5 stream J, P5-4, D55). Registered once in program.ts (Stage 1), so
 * the stream adds its command here and touches no registry. Adds nothing yet.
 */
import type { Command } from 'commander';

export function registerRoot(program: Command): void {
  void program;
}
