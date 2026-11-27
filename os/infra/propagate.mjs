// The D94 propagation API for the dependency-free side (the release builder,
// install.sh's runner, the updater container): the typed twin of
// packages/core/src/infra/propagate.ts (FROZEN signatures, Phase 6 Stage 1b),
// for code that runs before or outside a built core (core cannot be imported
// here, and core cannot import os/ at runtime). Same three functions, same
// answers: packages/core/test/release-contracts.test.mjs runs both on the same
// data roots. IC-5 implements them in both files together.
//
//   renderDigest(dataDir)               `sha256:<hex>` of generated/current, or null without a config
//   infraExecEnv(consumer, { dataDir }) the non-secret env for a child process of that consumer
//   buildSecrets({ jobDir, dataDir })   the secret files of one build; dispose() removes them
//
// Until IC-5: with no rendered config, exactly today's behaviour (an empty env,
// no secrets: D94 acceptance 6); with one, `infra-not-propagated` (fail closed).
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** = infra/types.ts INFRA_CURRENT_LINK (render.mjs's `current` link under infraDir). */
export const INFRA_CURRENT_LINK = 'aura/infra/generated/current';

export class InfraPropagationError extends Error {
  constructor(message) { super(message); this.name = 'InfraPropagationError'; this.code = 'infra-not-propagated'; }
}

const dataRootOf = (dataDir) => dataDir ?? process.env.AURA_DATA_DIR ?? '/data';

export function renderDigest(dataDir) {
  try {
    const name = readlinkSync(join(dataRootOf(dataDir), INFRA_CURRENT_LINK));
    return /^[0-9a-f]{64}$/.test(name) ? `sha256:${name}` : null;
  } catch {
    return null;
  }
}

const notYet = (what) => new InfraPropagationError(
  `an infrastructure configuration is set, but ${what} arrives with D94 IC-5: refused instead of ignoring it`);

export function infraExecEnv(consumer, opts = {}) {
  if (renderDigest(opts.dataDir) === null) return {};
  throw notYet(`the environment for ${consumer}`);
}

export async function buildSecrets(opts) {
  if (renderDigest(opts.dataDir) === null) return { secrets: {}, dispose: async () => undefined };
  throw notYet(`build secrets (${opts.jobDir})`);
}
