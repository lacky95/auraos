/**
 * The D94 propagation API: FROZEN signatures (Phase 6 Stage 1b, 6B.0); IC-5 implements them.
 *
 * Every consumer that reaches the network (the release builder, the updater, the installer, the
 * cap installer, Nexus/oras, app and sidecar spawns, the Terminal session env) gets its
 * infrastructure settings through these three functions, never by reading os/infra files itself:
 *
 *   renderDigest()          the digest of the rendered config (`sha256:<hex>`), or null without one
 *   infraExecEnv(consumer)  the non-secret env for a child process of that consumer
 *   buildSecrets(...)       the secret files of one build (BuildKit secret mounts), removed after it
 *
 * Until IC-5: with no rendered config, the answers are exactly today's behaviour (an empty env, no
 * secrets: D94 acceptance 6). With a rendered config, `infraExecEnv` and `buildSecrets` refuse with
 * `infra-not-propagated` instead of silently ignoring it (fail closed).
 */
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { INFRA_CURRENT_LINK, type BuildSecrets, type InfraConsumer } from './types.js';

export class InfraPropagationError extends Error {
  readonly code = 'infra-not-propagated';
  constructor(message: string) { super(message); this.name = 'InfraPropagationError'; }
}

const dataRootOf = (dataDir?: string): string => dataDir ?? process.env['AURA_DATA_DIR'] ?? '/data';

/** The digest of the rendered infrastructure config (`generated/current`), or null when none is configured. */
export function renderDigest(dataDir?: string): string | null {
  try {
    const name = readlinkSync(join(dataRootOf(dataDir), INFRA_CURRENT_LINK));
    return /^[0-9a-f]{64}$/.test(name) ? `sha256:${name}` : null;
  } catch {
    return null;
  }
}

const notYet = (what: string) => new InfraPropagationError(
  `an infrastructure configuration is set, but ${what} arrives with D94 IC-5: refused instead of ignoring it`);

/** The non-secret infrastructure env for a child process of `consumer` (never a credential). */
export function infraExecEnv(consumer: InfraConsumer, opts: { dataDir?: string } = {}): Readonly<Record<string, string>> {
  if (renderDigest(opts.dataDir) === null) return {};
  throw notYet(`the environment for ${consumer}`);
}

/**
 * The secret files of one build under `jobDir` (0400, the job's own directory), for BuildKit
 * `--secret id=…,src=…` and the throwaway build container; the caller disposes them in a `finally`.
 */
export async function buildSecrets(opts: { jobDir: string; dataDir?: string }): Promise<BuildSecrets> {
  if (renderDigest(opts.dataDir) === null) return { secrets: {}, dispose: async () => undefined };
  throw notYet(`build secrets (${opts.jobDir})`);
}
