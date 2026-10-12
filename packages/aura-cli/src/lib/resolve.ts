/**
 * Turn what a user types into an instance: an exact instance id, an app id
 * (when exactly one instance of it is live), or an unambiguous instance-id
 * prefix. Shared by `aura jump <target>`, `aura exec/logs inst`, and the
 * sidecar subresource.
 *
 * The pure half (`matchInstance`) takes the app list so it can be tested
 * without a shell.
 */
import { fail } from './format.js';
import { fuzzyScore } from './fuzzy.js';
import { fetchApps, fetchSidecars, liveInstances, sidecarId, sidecarMatches, type AppDto, type InstanceDto, type SidecarDto } from './resources.js';

export type InstanceMatch =
  | { ok: true; instance: InstanceDto }
  | { ok: false; reason: string };

export function matchInstance(apps: AppDto[], token: string): InstanceMatch {
  const all = apps.flatMap((a) => a.instances);
  const exact = all.find((i) => i.instanceId === token);
  if (exact) return { ok: true, instance: exact };

  const live = liveInstances(apps);
  if (apps.some((a) => a.manifest.id === token)) {
    const ofApp = live.filter((i) => i.appId === token);
    if (ofApp.length === 1) return { ok: true, instance: ofApp[0]! };
    if (ofApp.length === 0) return { ok: false, reason: `${token} has no running instance — start it with: aura run ${token}` };
    return {
      ok: false,
      reason: `${token} has ${ofApp.length} running instances — pick one:\n  ${ofApp.map((i) => i.instanceId).join('\n  ')}`,
    };
  }

  const prefixed = live.filter((i) => i.instanceId.startsWith(token));
  if (prefixed.length === 1) return { ok: true, instance: prefixed[0]! };
  if (prefixed.length > 1) {
    return { ok: false, reason: `'${token}' matches several instances:\n  ${prefixed.map((i) => i.instanceId).join('\n  ')}` };
  }

  const names = [...new Set([...apps.map((a) => a.manifest.id), ...live.map((i) => i.instanceId)])];
  const best = names
    .map((n) => ({ n, s: fuzzyScore(token, n) }))
    .filter((x): x is { n: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)[0];
  return { ok: false, reason: `no app or instance '${token}'${best ? ` — did you mean ${best.n}?` : ''}` };
}

/** Resolve or exit with the reason. */
export async function resolveInstance(token: string): Promise<InstanceDto> {
  const m = matchInstance(await fetchApps(), token);
  if (!m.ok) fail(m.reason);
  return m.instance;
}

/** A sidecar of `instanceId` by ID / container name, or exit listing what exists. */
export async function resolveSidecar(instanceId: string, token: string): Promise<SidecarDto> {
  const list = await fetchSidecars(instanceId);
  const hit = list.find((s) => sidecarMatches(s, token));
  if (hit) return hit;
  if (list.length === 0) fail(`${instanceId} has no sidecars.`);
  fail(`no sidecar '${token}' in ${instanceId} — available: ${list.map(sidecarId).join(', ')}`);
}
