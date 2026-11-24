import type { Server } from 'node:http';
import type { AppHostAuth } from './app-host-auth.mjs';

export { classifyHost } from './host-policy.mjs';
export function appHostName(host: unknown): string | null;
export interface AppHostRouterOptions {
  appsList: (opts?: { fresh?: boolean }) => Promise<unknown[]>;
  shellPort?: string;
  log?: (...args: unknown[]) => void;
  services?: () => Promise<unknown>;
  auth?: AppHostAuth | null;
  embedAncestors?: (ctx: never) => string[] | Promise<string[]>;
  env?: Record<string, string | undefined>;
}
export interface AppHostRouter {
  attach(server: Server): void;
  claims(req: unknown): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolve(name: string): Promise<any>;
}
export function createAppHostRouter(opts: AppHostRouterOptions): AppHostRouter;
export function activityHeaders(url: string | undefined, instanceId: string): Record<string, string>;
