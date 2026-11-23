import type { GatewayIdentityClaim } from '@aura/core';

export const GATEWAY_CLAIM_TTL_S: number;
export function gatewayKey(): Buffer;
export function signGatewayClaim(claim: GatewayIdentityClaim): string;
export function verifyGatewayClaim(
  token: string,
  opts: { method: string; path: string; now?: number },
): GatewayIdentityClaim | null;
export function gatewayClaimOf(request: Request): GatewayIdentityClaim | false | null;
