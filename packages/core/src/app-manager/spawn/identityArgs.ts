/**
 * The process identity of an app container (Phase 5 Stage 1 extraction;
 * stream A owns this file: `--user <app uid>`, `--cap-drop ALL`,
 * `no-new-privileges` and the passwd mounts for `runAs: app`).
 *
 * Today every app container runs as root with Docker's default capabilities,
 * so this adds nothing; the spawn context's identity is not applied yet.
 */
import type { SpawnIdentity } from '../../identity/types.js';

export function containerIdentityArgs(identity?: SpawnIdentity): string[] {
  void identity;
  return [];
}
