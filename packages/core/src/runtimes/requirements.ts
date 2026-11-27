/**
 * What an app and a request need from a runtime (Phase 5b stream Q; D85 A5):
 * the ONE derivation (D36). The registry's resolve, the D75 migration, the
 * Runtimes check API, `aura dev validate` and the Home Resolver all call it;
 * nothing else computes needs.
 *
 *   requirementsOf(manifest, installation?)   an app's requirements, pure and
 *                                             JSON-serializable (A5), with the
 *                                             A4 host-filesystem reasons and
 *                                             the A6 portability notes
 *   requestNeeds(kind, opts?)                 a request's needs: a jump home
 *                                             mode, a cross-uid writable mount,
 *                                             the check API's names
 *
 * A miss is `RuntimeCapabilityError` (`capability-missing`) at the caller;
 * nothing is downgraded and no runtime is picked for the app (Q17).
 *
 * Imports no other core module at runtime (only types), so any module may
 * call it without an import cycle.
 */
import type { AppManifest } from '../types/manifest.js';
import type { ExecutionContext, JumpHomeMode } from '../homes/types.js';
import type { RuntimeCapabilities, RuntimeCapability } from './types.js';

/** The manifest fields the requirements are derived from (a raw, unparsed manifest is fine too). */
export type RequirementsManifest = Pick<AppManifest, 'id'> & Partial<Pick<AppManifest,
  'sandbox' | 'services' | 'ports' | 'warmPool' | 'permissions' | 'tools' | 'context' | 'consumes'>>;

/** The installation facts that add needs (ARI-4, J.5). */
export interface RequirementsInstallation {
  runAs?: 'app' | 'root';
  sourceMode: 'open' | 'closed';
}

/** An app's runtime requirements (A5; `AppRequirements` in the plan, renamed: Nexus has its own). Plain data: an API answers it as is. */
export interface RuntimeRequirements {
  /** The names of the capabilities in `needs`, sorted. */
  capabilities: RuntimeCapability[];
  /** What `requireCapabilities` / `missingCapabilities` consume. */
  needs: Partial<RuntimeCapabilities>;
  /** `services[].name`. */
  sidecars: string[];
  ports: { exposes: string[]; hostPublish: number[] };
  /** `context[]`: the Context keys it asks for. */
  contextKeys: string[];
  /** `consumes[]` as `kind:name`. */
  consumes: string[];
  /** A4: features that bind host paths, and which. */
  hostFilesystem: { needed: boolean; because: string[] };
  installation?: { runAs: 'app' | 'root'; sourceMode: 'open' | 'closed' };
  /** A6: environment-bound fields, informational only (never a failure). */
  notes: Array<{ field: string; note: string }>;
}

const sortedKeys = (needs: Partial<RuntimeCapabilities>): RuntimeCapability[] =>
  (Object.keys(needs) as RuntimeCapability[]).filter((k) => needs[k] !== undefined).sort();

/**
 * The derivation table (one row per rule):
 *   services[]                       sidecars
 *   ports.exposes                    portExpose
 *   warmPool > 0                     warmPool
 *   permission apps.mount            mounts (cross-app mounts)
 *   A4 host-bound features           hostFilesystem: the `docker` tool,
 *                                    services[].inheritDockerSocket, apps.mount,
 *                                    ports.hostPublish, services[].devices,
 *                                    privileged or publish
 *   installation sourceMode closed   readOnlyBinds (ARI-4)
 */
export function requirementsOf(m: RequirementsManifest, installation?: RequirementsInstallation): RuntimeRequirements {
  const services = m.services ?? [];
  const exposes = m.ports?.exposes ?? [];
  const hostPublish = m.ports?.hostPublish ?? [];
  const mounts = (m.permissions ?? []).includes('apps.mount');
  const needs: Partial<RuntimeCapabilities> = {};
  if (services.length) needs.sidecars = true;
  if (exposes.length) needs.portExpose = true;
  if ((m.warmPool ?? 0) > 0) needs.warmPool = true;
  if (mounts) needs.mounts = true;
  if (installation?.sourceMode === 'closed') needs.readOnlyBinds = true;

  const because: string[] = [];
  if ((m.tools ?? []).includes('docker')) because.push('tools: docker');
  if (mounts) because.push('permissions: apps.mount');
  if (hostPublish.length) because.push('ports.hostPublish');
  const notes: RuntimeRequirements['notes'] = [];
  for (const [i, p] of hostPublish.entries()) {
    if (p.hostPort !== undefined) notes.push({ field: `ports.hostPublish[${i}].hostPort`, note: `host port ${p.hostPort} is a fact of this host` });
  }
  for (const s of services) {
    const at = `services[${s.name}]`;
    if (s.inheritDockerSocket) because.push(`${at}.inheritDockerSocket`);
    if (s.devices?.length) because.push(`${at}.devices`);
    if (s.privileged) because.push(`${at}.privileged`);
    if (s.publish?.length) because.push(`${at}.publish`);
    if (s.publish?.length) notes.push({ field: `${at}.publish`, note: 'host port publishing binds this host\'s ports' });
    if (s.devices?.length) notes.push({ field: `${at}.devices`, note: 'host devices exist only on this host' });
    if (s.privileged) notes.push({ field: `${at}.privileged`, note: 'privileged mode is a host privilege' });
    if (s.inheritDockerSocket) notes.push({ field: `${at}.inheritDockerSocket`, note: 'the Docker socket is this host\'s engine' });
    if (s.dns?.length) notes.push({ field: `${at}.dns`, note: 'DNS servers are this network\'s' });
    if (s.restart !== undefined && s.restart !== 'unless-stopped') notes.push({ field: `${at}.restart`, note: 'the restart policy is the local engine\'s' });
  }
  if (because.length) needs.hostFilesystem = true;

  return {
    capabilities: sortedKeys(needs),
    needs,
    sidecars: services.map((s) => s.name),
    ports: { exposes: exposes.map((e) => `${e.sourceApp}:${e.sourcePort}`), hostPublish: hostPublish.map((p) => p.port) },
    contextKeys: [...(m.context ?? [])],
    consumes: (m.consumes ?? []).map((c) => `${c.kind}:${c.name}`),
    hostFilesystem: { needed: because.length > 0, because },
    ...(installation ? { installation: { runAs: installation.runAs ?? 'root', sourceMode: installation.sourceMode } } : {}),
    notes,
  };
}

/**
 * A request's kind, as a caller (or the check API, by name) asks it:
 *   jump / home-private / home-ephemeral   a session with the Private (or an
 *                                          ephemeral) Home: an isolated session
 *                                          inside the instance (D67, D74)
 *   home-app                               a session as the app (D79)
 *   terminal-session                       a user's session host: a namespace
 *                                          boundary at least (D65 §11)
 *   application, sidecar                   an app process: nothing extra
 *   mount, idmap-mount                     a cross-app mount; a writable one
 *                                          between different app uids (D80)
 *   closed, sidecars, port-expose,         the manifest rows by name
 *   host-filesystem
 */
export const REQUEST_KINDS = [
  'jump', 'home-private', 'home-ephemeral', 'home-app', 'terminal-session', 'application', 'sidecar',
  'mount', 'idmap-mount', 'closed', 'sidecars', 'port-expose', 'host-filesystem',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const isRequestKind = (v: unknown): v is RequestKind => (REQUEST_KINDS as readonly unknown[]).includes(v);

/** The runtime capabilities a request needs (a fresh object; `missingCapabilities` semantics). */
export function requestNeeds(kind: RequestKind | ExecutionContext, opts: { jumpHomeMode?: JumpHomeMode } = {}): Partial<RuntimeCapabilities> {
  switch (kind) {
    case 'jump': return opts.jumpHomeMode === 'app' ? { sessionExec: true } : { sessionExec: true, privateHomeSession: true };
    case 'home-private':
    case 'home-ephemeral': return { sessionExec: true, privateHomeSession: true };
    case 'home-app': return { sessionExec: true };
    case 'terminal-session': return { isolation: 'namespace' };
    case 'application':
    case 'sidecar': return {};
    case 'mount': return { mounts: true };
    case 'idmap-mount': return { mounts: true, idmappedMounts: true };
    case 'closed': return { readOnlyBinds: true };
    case 'sidecars': return { sidecars: true };
    case 'port-expose': return { portExpose: true };
    case 'host-filesystem': return { hostFilesystem: true };
  }
}

/** The installation facts an instance latched at its start (AppInstance `runAs`). */
export interface InstanceFacts {
  /** `user`: a Terminal instance runs as its user's uid (D69). Absent: root (a record from before 5-apps). */
  runAs?: 'app' | 'root' | 'user';
}

/**
 * An instance's effective capabilities (5b G): its runtime's, narrowed by
 * the installation facts. A root instance (legacy or an approved root
 * request) runs everything as uid 0 whatever the runtime enforces, so for
 * its sessions `identity` is `none` and there is no Private Home boundary
 * (J.5; the runtime flag `identity: enforced` is static, P-2). Never widens a
 * capability. The gates read this, never a runtime id (ARI §9.5).
 */
export function instanceCapabilities(runtime: RuntimeCapabilities, facts: InstanceFacts): RuntimeCapabilities {
  if (facts.runAs === 'app' || facts.runAs === 'user') return { ...runtime };
  return { ...runtime, identity: 'none', privateHomeSession: false };
}
