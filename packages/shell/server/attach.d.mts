import type { Server } from 'node:http';

export function nsEnabled(ns: string, filter: string): boolean;
export function fetchAppsList(): Promise<unknown[]>;
export function appsListCached(opts?: { fresh?: boolean }): Promise<unknown[]>;
export function wsProxySubject(appId: string | null, proxyPath: string): 'terminal-pty' | 'ws-proxy';
export function attachWsProxy(httpServer: Server): void;
/** socket.io's upgrade options: it ends an upgrade it does not own only after this long. */
export const OS_EVENTS_UPGRADE: { destroyUpgrade: boolean; destroyUpgradeTimeout: number };
export function attachSio(httpServer: Server): Promise<void>;
export function attachAppHosts(httpServer: Server): void;
export function attachShellServers(httpServer: Server): Promise<void>;
