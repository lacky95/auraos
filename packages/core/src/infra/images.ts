/**
 * Image references AuraOS pulls itself (OS sidecars) through `registries.oci.mirrors` (D94 §5.2,
 * the rendered `oci/mirrors` table; the same rule as os/infra/config.mjs rewriteImage). The host
 * daemon's own pulls stay operator-owned (O6). No config: the reference unchanged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataRootOf, renderedSubpath } from './propagate.js';

export function infraImageRef(ref: string, dataDir?: string): string {
  const sub = renderedSubpath(dataDir);
  if (!sub) return ref;
  let table = '';
  try { table = readFileSync(join(dataRootOf(dataDir), sub, 'oci', 'mirrors'), 'utf8'); } catch { return ref; }
  const mirrors = new Map(table.split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]));
  const first = ref.split('/')[0]!;
  const explicit = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = explicit ? first : 'docker.io';
  let path = explicit ? ref.slice(first.length + 1) : ref;
  if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  const m = mirrors.get(registry);
  return m ? `${m.replace(/\/$/, '')}/${path}` : ref;
}
