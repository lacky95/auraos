export const INTERNAL_SERVICE_HEADER: string;
export const SESSION_COOKIES: ReadonlySet<string>;
export function accessReportEnabled(): boolean;
export function reportSurface(observation: unknown): void;
export function countSurfaceEvent(subject: string): void;
export function countCredential(kind: string, surface: string): void;
export function surfaceIdentity(headers: unknown): {
  authorization: string | null;
  sessionCookie: boolean;
  referer: string | null;
  instanceId: string | null;
} | null;
export function staticSurface(url: unknown): string | null;
export function observeHttpSurface(req: unknown, res: unknown): void;
export function internalServiceHeaders(url: string): Record<string, string>;
