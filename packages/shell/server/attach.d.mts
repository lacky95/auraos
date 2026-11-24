import type { Server } from 'node:http';

export function nsEnabled(ns: string, filter: string): boolean;
export function fetchAppsList(): Promise<unknown[]>;
export function appsListCached(opts?: { fresh?: boolean }): Promise<unknown[]>;
export function attachWsProxy(httpServer: Server): void;
export function attachSio(httpServer: Server): Promise<void>;
export function attachAppHosts(httpServer: Server): void;
export function attachShellServers(httpServer: Server): Promise<void>;
