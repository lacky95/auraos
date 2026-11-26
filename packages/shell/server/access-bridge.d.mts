export const INTERNAL_SERVICE_HEADER: string;
export const SESSION_COOKIES: ReadonlySet<string>;
export function reportSurface(observation: unknown): void;
export function countSurfaceEvent(subject: string): void;
export function countCredential(kind: string, surface: string): void;
export function surfaceIdentity(
  headers: unknown,
  opts?: {
    method?: string;
    url?: string;
    appHost?: { appId: string; instanceId?: string; userId: string; sid: string } | null;
    peer?: string | null;
  },
): SurfaceIdentityLike | null;
export interface SurfaceIdentityLike {
  verified: Promise<{ principal: { kind: string }; via: string } | null> | null;
  referer: string | null;
  instanceId: string | null;
  peer: string | null;
}
export function requestIdentity(
  req: unknown,
  opts?: { appHost?: { appId: string; instanceId?: string; userId: string; sid: string } | null },
): SurfaceIdentityLike | null;
export function followIdentity(identity: SurfaceIdentityLike | null, end: () => void): () => void;
export function surfaceGate(observation: {
  subject: string; method: string; appId?: string | null; identity: SurfaceIdentityLike | null;
}): Promise<boolean>;
export function gatedHttpSurface(req: unknown): boolean;
export function staticSurface(url: unknown): string | null;
export function observeHttpSurface(req: unknown, res: unknown): void;
export function internalServiceHeaders(url: string): Record<string, string>;

/** D89 B4: the shell's relay claim for a call forwarded to an owner-agent app, or null (lib/access/relay.ts). */
export function relayClaimOf(call: {
  appId: string | null | undefined;
  instanceId: string;
  method: string;
  path: string;
  principal?: unknown;
  session?: { userId?: string; sid?: string } | null;
  system?: boolean;
}): string | null;
