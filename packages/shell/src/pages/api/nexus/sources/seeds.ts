import type { APIRoute } from 'astro';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { applySourceSeeds, lastSeedReport, readSeeds, seedDirs, SEED_ENV_VAR } from '../../../../lib/nexusSeedsApply.js';

/**
 * Pre-registered sources (lib/nexusSeeds.ts):
 *
 *   GET  → where seeds are read from, what they declare, and the outcome of
 *          the last apply (boot or re-apply). No passwords, only `login: true`.
 *   POST → re-read every seed now and apply it — no shell restart needed
 *          after editing a sources.d file.
 */
export const GET: APIRoute = async () => {
  const { seeds, files, problems } = readSeeds();
  return jsonResponse({
    dirs: seedDirs(),
    envVar: SEED_ENV_VAR,
    envSet: !!process.env[SEED_ENV_VAR]?.trim(),
    files,
    seeds: seeds.map((s) => ({
      name: s.entry.name, policy: s.policy, origin: s.origin, kind: s.entry.kind, url: s.entry.url, login: !!s.login,
    })),
    problems,
    last: lastSeedReport(),
  });
};

export const POST: APIRoute = async () => {
  const report = await applySourceSeeds();
  return jsonResponse({ ok: report.problems.length === 0, report });
};
