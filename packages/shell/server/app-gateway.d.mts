import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AppHostCookiePayload } from '@aura/core';

export const GATEWAY_MUX_PATH: string;
export const GATEWAY_CSRF_PATH: string;
export const GATEWAY_CSRF_HEADER: string;
export interface AppGatewayContext {
  record: { appId: string; installationId: string; instanceScope?: { kind: string; userId?: string } };
  slot: { slot: number; label: string; instanceId: string | null };
  session?: AppHostCookiePayload | null;
}
export function gatewayShellPath(rawUrl: unknown): string | null;
export function browserBoundaryError(req: IncomingMessage, session: { aud: string; sid?: string }): string | null;
export function handleAppGateway(req: IncomingMessage, res: ServerResponse, ctx: AppGatewayContext): void;
export function handleAppGatewayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: AppGatewayContext): Promise<void>;
export function serveAppRuntime(req: IncomingMessage, res: ServerResponse, ctx: AppGatewayContext): void;
