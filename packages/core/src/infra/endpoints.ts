/**
 * AuraOS's own default endpoints (philosophy audit #7, D94): the official Nexus store and the
 * GitHub it is published on. One place for the built-in public defaults; an infrastructure
 * config's `endpoints:` (rendered `generated/current/endpoints.json`) replaces any of them, e.g.
 * with an internal mirror of the store or GitHub Enterprise.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InfraEndpoints } from './types.js';
import { dataRootOf, renderedSubpath } from './propagate.js';

export const DEFAULT_ENDPOINTS: Readonly<InfraEndpoints> = Object.freeze({
  nexusIndex: 'https://nexus.aura.lakner.io/index.yaml',
  nexusStoreRepo: 'lacky95/auraos-store',
  github: 'https://github.com',
  githubApi: 'https://api.github.com',
});

/** The effective endpoints, and which of them are the built-in public defaults. */
export function infraEndpoints(dataDir?: string): InfraEndpoints & { configured: ReadonlyArray<keyof InfraEndpoints> } {
  const sub = renderedSubpath(dataDir);
  let over: Partial<InfraEndpoints> = {};
  if (sub) {
    try { over = JSON.parse(readFileSync(join(dataRootOf(dataDir), sub, 'endpoints.json'), 'utf8')) as Partial<InfraEndpoints>; } catch { /* none configured */ }
  }
  const configured = (Object.keys(DEFAULT_ENDPOINTS) as Array<keyof InfraEndpoints>).filter((k) => typeof over[k] === 'string' && over[k]);
  const out = { ...DEFAULT_ENDPOINTS, configured } as InfraEndpoints & { configured: Array<keyof InfraEndpoints> };
  for (const k of configured) out[k] = over[k]!;
  return out;
}
