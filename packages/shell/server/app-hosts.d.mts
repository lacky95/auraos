import type { Server } from 'node:http';
import type { AppHostAuth } from './app-host-auth.mjs';

export { classifyHost } from './host-policy.mjs';
export interface AppHostRouterOptions {
  appsList: (opts?: { fresh?: boolean }) => Promise<unknown[]>;
  shellPort?: string;
  log?: (...args: unknown[]) => void;
  services?: () => Promise<unknown>;
  auth?: AppHostAuth | null;
  embedAncestors?: (ctx: never) => string[] | Promise<string[]>;
  env?: Record<string, string | undefined>;
  /** D104 `apps.view` decisions (app-view.mjs); default the live ones. */
  appView?: import('./app-view.mjs').AppView | Promise<import('./app-view.mjs').AppView> | null;
}
export interface AppHostRouter {
  attach(server: Server): void;
}
export function createAppHostRouter(opts: AppHostRouterOptions): AppHostRouter;
export function activityHeaders(url: string | undefined, instanceId: string): Record<string, string>;
export function viewRequestRefusal(req: { method?: string; headers: Record<string, unknown> }, url: string, path: string): 'read-only' | 'not-through-target' | null;
