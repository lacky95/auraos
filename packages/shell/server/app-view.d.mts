import type { AppAccessError, AppAccessErrorCode, AppAccessErrorContext, AppAccessTargetFacts, AppHostViewClaim, GrantRecord, GrantScope } from '@aura/core';

export const VIEW_PERMISSION: 'apps.view';
export function appProtection(appId: string): string | null;

export interface AppViewDeps {
  access: {
    appAccessTargetRefusal(consumer: string, target: string, facts: AppAccessTargetFacts, ctx?: Omit<AppAccessErrorContext, 'target' | 'consumer' | 'reason'>): AppAccessError | null;
    appAccessCounts(record: { appScope?: string; installationId?: string | null; scope?: GrantScope } | null, consumer: { scope?: string; installationId: string | null }, targetInstallationId: string | null): boolean;
  };
  manifest(appId: string): AppAccessTargetFacts['manifest'];
  scope(appId: string): string | undefined;
  trustedSystemCopy(appId: string): boolean;
  installation(appId: string): Promise<string | null>;
  grant(consumer: string, target: string): Promise<GrantRecord | null>;
  ownerLive(userId: string): Promise<boolean>;
}

export interface AppView {
  targetFacts(appId: string): AppAccessTargetFacts;
  targetRefusal(consumer: string, target: string, ctx?: Omit<AppAccessErrorContext, 'target' | 'consumer' | 'reason'>): AppAccessError | null;
  declares(consumer: string): boolean;
  binding(appId: string): Promise<{ scope: string | undefined; installationId: string | null }>;
  viewLive(view: AppHostViewClaim | undefined, userId: string, target: { appId: string; installationId: string }): Promise<boolean>;
}

export function createAppView(deps: AppViewDeps): AppView;
export function liveAppView(): Promise<AppView>;
export function viewRefusalBody(code: AppAccessErrorCode, ctx: AppAccessErrorContext): Promise<{ status: number; body: import('@aura/core').AuraErrorBody }>;
export function browserShaped(headers: Record<string, string | string[] | undefined>): boolean;
