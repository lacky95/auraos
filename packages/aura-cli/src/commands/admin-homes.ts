/**
 * `aura admin homes plan|ownership --dry-run|import|reset` (Phase 5 streams
 * I and H). Registered once under `aura admin` (Stage 1), so the streams add
 * their commands here and touch no registry. Adds nothing yet.
 */
import type { Command } from 'commander';

export function registerAdminHomes(admin: Command): void {
  void admin;
}
