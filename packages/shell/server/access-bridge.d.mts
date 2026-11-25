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
  },
): {
  verified: Promise<{ principal: { kind: string }; via: string } | null> | null;
  referer: string | null;
  instanceId: string | null;
} | null;
export function staticSurface(url: unknown): string | null;
export function observeHttpSurface(req: unknown, res: unknown): void;
export function internalServiceHeaders(url: string): Record<string, string>;
