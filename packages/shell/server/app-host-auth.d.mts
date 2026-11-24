export const HANDOFF_TTL_MS: number;
export const APP_COOKIE_TTL_MS: number;
export const LOGIN_DARK_SID: string;
export function safeReturnPath(value: unknown): string | null;
export function cookieValues(header: unknown, name: string): string[];
export interface AppHostServices {
  registry: import('@aura/core').AppHostRegistry & {
    getInstallation(installationId: string): Promise<import('@aura/core').AppInstallation | null>;
  };
  frameRoute(appId: string): Promise<'proxy' | 'host'>;
  sessionLive(sid: string): Promise<boolean>;
}
export interface HandoffInput {
  aud: string; label: string; installationId: string; appId: string; slot: number;
  userId: string; sid: string; returnPath: string; sessionExpiresAt?: number | null;
}
export interface AppHostAuth {
  issueCode(input: HandoffInput): { code: string; expiresAt: number };
  consumeCode(code: unknown, expected: { aud: string; label: string }): { claim: import('@aura/core').AppHostHandoffClaim; sessionExpiresAt: number | null } | null;
  sealCookie(entry: { claim: import('@aura/core').AppHostHandoffClaim; sessionExpiresAt: number | null }): { value: string; maxAgeSeconds: number; payload: import('@aura/core').AppHostCookiePayload };
  readCookie(header: unknown, name: string, expected: { aud: string; label: string; installationId: string }): import('@aura/core').AppHostCookiePayload | null;
}
export function createAppHostAuth(opts: { secret: Buffer | string; now?: () => number }): AppHostAuth;
export function appHostAuth(): AppHostAuth;
export function loadAppHostServices(): Promise<AppHostServices | null>;
