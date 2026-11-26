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
 * Reporting only: nothing here refuses an app. From Phase 6 the shell
 * refuses an unknown major `auraContract` with a clear message.
 */
import type { AppManifest } from '../types/manifest.js';
import { toolsGrant } from '../app-manager/tool-allowlist.js';

/** The contract this AuraOS implements. The SDK exports the same value (`AURA_CONTRACT`). */
export const AURA_CONTRACT = 1;

export type ContractStatus = 'current' | 'none' | 'unknown';

/** Which contract an app was built for: `none` before the contract, `unknown` for a newer major. */
export function contractStatus(manifest: Pick<AppManifest, 'auraContract'>): { version: number | null; status: ContractStatus } {
  const v = manifest.auraContract ?? null;
  if (v === null) return { version: null, status: 'none' };
  return { version: v, status: v <= AURA_CONTRACT ? 'current' : 'unknown' };
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

type ContractManifest = Pick<AppManifest, 'auraContract' | 'permissions' | 'tools' | 'services' | 'consumes'> & { context?: string[] };

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
  severity: 'warn' | 'info';
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
  const { status, version } = contractStatus(m);
  if (status === 'none') {
    out.push({ severity: 'warn', code: 'contract-missing', path: 'auraContract',
      message: `no auraContract: add "auraContract": ${AURA_CONTRACT} once the app follows the app contract (docs: The Aura app contract)` });
  } else if (status === 'unknown') {
    out.push({ severity: 'warn', code: 'contract-unknown', path: 'auraContract',
      message: `auraContract ${version} is newer than this AuraOS (${AURA_CONTRACT}); from Phase 6 it refuses to start the app` });
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
  if (d.context.length > 0 && new Set(d.context).size !== d.context.length) {
    out.push({ severity: 'info', code: 'context-duplicate', path: 'context', message: 'context[] lists a key twice' });
  }
  return out;
}
