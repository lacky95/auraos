import type { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const MUX_PATH: string;
export function toUpstreamUrl(origin: string, raw: unknown): string | null;
export function streamHeaders(baseHeaders: Record<string, string>, url: string): Record<string, string>;
export function createSseParser(
  onEvent: (event: { data: string; event?: string; id?: string }) => void,
  onRetry?: (ms: number) => void,
): (chunk: string) => void;
export interface SseMuxScope {
  stream(rawUrl: unknown): { url: string; headers: Record<string, string> } | null;
}
export interface SseMux {
  serveScoped(req: IncomingMessage, socket: Duplex, head: Buffer, scope: SseMuxScope): void;
}
export function attachSseMux(httpServer: EventEmitter, origin: string, log?: (...args: unknown[]) => void): Promise<SseMux>;
