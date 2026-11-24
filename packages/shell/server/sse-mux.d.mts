import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

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
export function createSseMux(log?: (...args: unknown[]) => void): Promise<SseMux>;
