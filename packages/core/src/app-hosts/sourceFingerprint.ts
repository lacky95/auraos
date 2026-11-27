/**
 * Where an installation's files came from: a leaf (node only, plus type
 * imports), so Execution can read it without entangling with the App Host
 * lifecycle (D97, Phase 6 K: no app-manager <-> app-hosts module cycle).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeDefinition } from '../scopes/types.js';
import type { AppSourceFingerprint } from './contracts.js';

/** Where an installed app came from, from its Nexus record when it has one. */
export function appSourceFingerprint(scope: ScopeDefinition, appId: string): AppSourceFingerprint {
  if (scope.id === 'system') return { kind: 'system', ref: appId };
  const recordPath = join(scope.dataDir, 'nexus', 'installed', `${appId}.json`);
  if (existsSync(recordPath)) {
    try {
      const r = JSON.parse(readFileSync(recordPath, 'utf-8')) as { source?: AppSourceFingerprint['kind']; ref?: string; digest?: string };
      if (r.source && typeof r.ref === 'string') {
        return { kind: r.source, ref: r.ref, ...(r.digest ? { digest: r.digest } : {}) };
      }
    } catch { /* unreadable record: treated as a local app */ }
  }
  return { kind: 'local', ref: join(scope.appsDir, appId) };
}

