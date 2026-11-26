import type { MiddlewareHandler } from 'astro';
import { RELAY_CLAIM_HEADER, checkShellRelay, shellOnlyResponse } from '@aura/app-sdk/shell-peer';

/**
 * The Terminal's server is the owner's shell: its MCP runs commands and its
 * session API types into the owner's sessions. Until the private Terminal
 * network (D58, Phase 5) it is on `aura-net`, so it answers only connections
 * the shell relays (its proxy and App Host, which decide who may come
 * through: the owner, the System Terminal, granted embedders) and its own
 * container (H4 stopgap). The PTY socket has the same check at its upgrade
 * (server.mjs, astro.config.mjs).
 *
 * D89 B4: a call from the shell's address carries the shell's relay claim
 * (`x-aura-relay`); `relay-strict` decides whether one without it is still
 * served (warn, reported in this log) or refused (strict).
 */
export const onRequest: MiddlewareHandler = async (ctx, next) => {
  let peer: string | undefined;
  try { peer = ctx.clientAddress; } catch { peer = undefined; }
  const url = new URL(ctx.request.url);
  const relay = await checkShellRelay({
    peer, header: ctx.request.headers.get(RELAY_CLAIM_HEADER), method: ctx.request.method, path: `${url.pathname}${url.search}`,
  });
  if (!relay.ok) return shellOnlyResponse(ctx.url.pathname);
  return next();
};
