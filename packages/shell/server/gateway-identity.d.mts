import type { GatewayIdentityClaim } from '@aura/core';

export const GATEWAY_CLAIM_TTL_S: number;
export interface OwnerUiApp {
  readonly groups: readonly string[];
  readonly routes: readonly string[];
}
export const OWNER_UI_APPS: Readonly<Record<string, OwnerUiApp>>;
export function ownerUiApp(appId: string): OwnerUiApp | null;
/** What the system-installation rule reads (core AppHostStore). */
export interface InstallationReader {
  getInstallation?(id: string): Promise<{ appId: string; scope: string; state: string } | null>;
  /** Track P: whether an installation is an approved overlay of its system app. */
  approvedOverlay?(installation: never): Promise<boolean>;
}

export function isSystemInstallation(
  registry: InstallationReader | null | undefined,
  ref: { appId: string; installationId: string },
): Promise<boolean>;
export function isOwnerUiInstallation(
  registry: InstallationReader | null | undefined,
  ref: { appId: string; installationId: string },
): Promise<boolean>;
export function ownerUiCovers(appId: string, path: string): boolean;
export function ownerUiActs(
  ref: { appId: string; installationId: string; sid: string; userId: string; path: string },
  svc: {
    registry: InstallationReader | null | undefined;
    sessionLive(sid: string, userId: string): Promise<false | { role: string }>;
  },
): Promise<boolean>;
export function gatewayKey(): Buffer;
export function signGatewayClaim(claim: GatewayIdentityClaim): string;
export function verifyGatewayClaim(
  token: string,
  opts: { method: string; path: string; now?: number },
): GatewayIdentityClaim | null;
export function gatewayClaimOf(request: Request): GatewayIdentityClaim | false | null;

/** The owner SSR claim (D45): a trusted system UI's page render acting for the owner. */
export interface OwnerSsrClaim {
  v: 1;
  use: 'owner-ssr';
  appId: string;
  installationId: string;
  instanceId: string;
  userId: string;
  owner: { userId: string; sid: string };
  iat: number;
  exp: number;
}
export const OWNER_SSR_CLAIM_TTL_S: number;
export function signOwnerSsrClaim(ref: { appId: string; installationId: string; instanceId: string; userId: string; sid: string }): string;
export function verifyOwnerSsrClaim(token: string, opts?: { now?: number }): OwnerSsrClaim | null;
export function ownerSsrClaimOf(request: Request): OwnerSsrClaim | null;
