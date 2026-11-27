/**
 * The Aura app contract (D48): what an app declares in its manifest, which
 * contract version it was built for, and the manifest checks `aura dev
 * validate` and the shell's contract report share.
 *
 * Phase 3 backs the contract with today's mechanisms. Phases 5 and 6 change
 * only what sits behind it: an app on contract 1 needs no further change for
 * private homes, granted Context, or the locked release.
 *
 * What an app declares (all in app.manifest.json):
 *   permissions   the shell permissions it uses
 *   context       the Aura Context keys it reads (`osClient.context.get`)
 *   services      its sidecars and their images
 *   consumes      other apps' interfaces it dials
 *   tools         `docker` when it drives the container runtime itself
 *   sidecars.privileged  when a sidecar needs privileged, capabilities, devices or publish
 *   auraContract  the contract version it was built for
 *
 * Phase 6 (D48): an unknown major `auraContract` is refused (contract/types.ts
 * `refuseUnknownMajor`, shared with the ARI): at install and patch
 * activation, at registry load (listed `incompatible`, never started) and by
 * `aura dev validate` (an error). Everything else here is reported only.
 */
import { closestPermission, isKnownPermission, type AppManifest } from '../types/manifest.js';
import { toolsGrant } from '../capabilities/tool-allowlist.js';
import { AURA_CONTRACT, contractRefusal, declaredSetupKeys, operationalBlock, type ContractStatus } from './types.js';

export {
  AURA_CONTRACT, CONTRACT_AUDIT_ACTIONS, CONTRACT_UNSUPPORTED, contractRefusal, declaredSetupKeys, operationalBlock,
  OperationalBlockError, operationalBlockOf, refuseUnknownMajor, RESERVED_SETUP_KEYS,
} from './types.js';
export type { ContractKind, ContractStatus, MajorRefusal, OperationalBlock, OperationalState, ReservedSetupKey } from './types.js';

/** Which contract an app was built for: `none` before the contract, `incompatible` for a newer major. */
export function contractStatus(manifest: Pick<AppManifest, 'auraContract'>): { version: number | null; status: ContractStatus } {
  const v = manifest.auraContract ?? null;
  if (v === null) return { version: null, status: 'none' };
  return { version: v, status: contractRefusal({ id: '', auraContract: v }) ? 'incompatible' : 'current' };
}

/** Everything a manifest declares that the contract covers, in one flat view. */
export interface ContractDeclarations {
  auraContract: number | null;
  permissions: string[];
  context: string[];
  sidecars: Array<{ name: string; image: string }>;
  consumes: string[];
  docker: boolean;
  privileged: boolean;
}

type ContractManifest = Pick<AppManifest, 'auraContract' | 'permissions' | 'tools' | 'services' | 'consumes'> & { context?: string[]; setup?: unknown; profiles?: unknown; ports?: AppManifest['ports'] };

const PRIVILEGED_SIDECAR = (s: AppManifest['services'][number]): boolean =>
  s.privileged === true || (s.capabilities?.length ?? 0) > 0 || (s.devices?.length ?? 0) > 0 || (s.publish?.length ?? 0) > 0;

export function contractDeclarations(m: ContractManifest): ContractDeclarations {
  return {
    auraContract: m.auraContract ?? null,
    permissions: [...(m.permissions ?? [])],
    context: [...(m.context ?? [])],
    sidecars: (m.services ?? []).map((s) => ({ name: s.name, image: s.image })),
    consumes: (m.consumes ?? []).map((c) => `${c.appId ? `${c.appId}/` : ''}${c.name}`),
    docker: toolsGrant(m.tools ?? [], 'docker'),
    privileged: (m.permissions ?? []).includes('sidecars.privileged'),
  };
}

export interface ContractFinding {
  severity: 'error' | 'warn' | 'info';
  code: string;
  /** Dotted manifest path the finding is about. */
  path: string;
  message: string;
}

/**
 * The manifest's own consistency with the contract: declarations that are
 * missing for what the manifest itself says it uses. Source-level checks
 * (an undeclared `context.get` key, a raw `/run/context` read) live in the
 * CLI's lint, which sees the files.
 */
export function contractFindings(m: ContractManifest): ContractFinding[] {
  const out: ContractFinding[] = [];
  const d = contractDeclarations(m);
  const { status } = contractStatus(m);
  const refused = contractRefusal({ id: (m as { id?: string }).id ?? 'this app', auraContract: m.auraContract ?? null });
  if (status === 'none') {
    out.push({ severity: 'warn', code: 'contract-missing', path: 'auraContract',
      message: `no auraContract: add "auraContract": ${AURA_CONTRACT} once the app follows the app contract (docs: The Aura app contract)` });
  } else if (refused) {
    // An error: AuraOS refuses to install or start the app (D48).
    out.push({ severity: 'error', code: refused.code, path: 'auraContract', message: refused.message });
  }
  // D108 A1: reserved until the setup engine exists; AuraOS refuses to install or start the app.
  if (declaredSetupKeys(m).length > 0) {
    const block = operationalBlock({ id: (m as { id?: string }).id ?? 'this app', setup: m.setup, profiles: m.profiles })!;
    out.push({ severity: 'error', code: block.error, path: block.manifestField, message: `${block.message} (${block.hint})` });
  }
  (m.services ?? []).forEach((s, i) => {
    if (PRIVILEGED_SIDECAR(s) && !d.privileged && !d.docker) {
      out.push({ severity: 'warn', code: 'privileged-undeclared', path: `services.${i}`,
        message: `sidecar '${s.name}' asks for privileged, capabilities, devices or publish: declare the permission sidecars.privileged` });
    }
    if (s.inheritDockerSocket) {
      out.push({ severity: 'warn', code: 'docker-socket-removed', path: `services.${i}.inheritDockerSocket`,
        message: `sidecar '${s.name}' asks for the Docker socket: no sidecar gets it any more, and the sidecar is refused (use OS sidecars, sidecars.spawn)` });
    }
  });
  if (d.docker) {
    out.push({ severity: 'warn', code: 'docker-socket-removed', path: 'tools',
      message: 'tools[] lists docker: apps get no Docker socket any more (the owner\'s `aura root` tab has it); drive containers through OS sidecars (sidecars.spawn)' });
  }
  if ((m.services ?? []).length > 0 && !d.docker && !d.permissions.includes('sidecars.spawn')) {
    out.push({ severity: 'warn', code: 'sidecars-undeclared', path: 'services',
      message: 'services[] are declared, but neither the permission sidecars.spawn (OS sidecars) nor the docker tool (SDK sidecars) runs them' });
  }
  // D105 Pass B: a permission AuraOS does not know grants nothing (a typo, most often).
  d.permissions.forEach((p, i) => {
    if (isKnownPermission(p)) return;
    const near = closestPermission(p);
    out.push({ severity: 'warn', code: 'permission-unknown', path: `permissions.${i}`,
      message: `permissions[${i}] '${p}' is not a known permission, so it grants nothing${near ? ` — did you mean '${near}'?` : ' (docs: Permissions)'}` });
  });
  // D105 Pass B: without apps.port the OS ignores ports{} at every start (it only logged it).
  const ports = m.ports;
  if (ports && ((ports.exposes?.length ?? 0) > 0 || (ports.hostPublish?.length ?? 0) > 0) && !d.permissions.includes('apps.port')) {
    const id = (m as { id?: string }).id ?? '<app>';
    out.push({ severity: 'warn', code: 'ports-undeclared', path: 'ports',
      message: `ports{} is ignored: the app does not declare 'apps.port' — add it to permissions[] (or the owner runs: aura grant perms ${id} apps.port)` });
  }
  if (d.context.length > 0 && new Set(d.context).size !== d.context.length) {
    out.push({ severity: 'info', code: 'context-duplicate', path: 'context', message: 'context[] lists a key twice' });
  }
  return out;
}
