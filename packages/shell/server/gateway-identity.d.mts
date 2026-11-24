import type { GatewayIdentityClaim } from '@aura/core';

export const GATEWAY_CLAIM_TTL_S: number;
export interface OwnerUiApp {
  readonly groups: readonly string[];
  readonly routes: readonly string[];
}
export const OWNER_UI_APPS: Readonly<Record<string, OwnerUiApp>>;
export function ownerUiApp(appId: string): OwnerUiApp | null;
export function isSystemInstallation(
  registry: { getInstallation?(id: string): Promise<{ appId: string; scope: string; state: string } | null> } | null | undefined,
  ref: { appId: string; installationId: string },
): Promise<boolean>;
export function isOwnerUiInstallation(
  registry: { getInstallation?(id: string): Promise<{ appId: string; scope: string; state: string } | null> } | null | undefined,
  ref: { appId: string; installationId: string },
): Promise<boolean>;
export function gatewayKey(): Buffer;
export function signGatewayClaim(claim: GatewayIdentityClaim): string;
export function verifyGatewayClaim(
  token: string,
  opts: { method: string; path: string; now?: number },
): GatewayIdentityClaim | null;
export function gatewayClaimOf(request: Request): GatewayIdentityClaim | false | null;
