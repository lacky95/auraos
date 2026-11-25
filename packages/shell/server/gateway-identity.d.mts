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
    sessionLive(sid: string, userId: string): Promise<boolean>;
  },
): Promise<boolean>;
export function gatewayKey(): Buffer;
export function signGatewayClaim(claim: GatewayIdentityClaim): string;
export function verifyGatewayClaim(
  token: string,
  opts: { method: string; path: string; now?: number },
): GatewayIdentityClaim | null;
export function gatewayClaimOf(request: Request): GatewayIdentityClaim | false | null;
