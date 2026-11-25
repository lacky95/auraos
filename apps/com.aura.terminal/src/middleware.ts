import type { MiddlewareHandler } from 'astro';
import { fromShell, shellOnlyResponse } from '@aura/app-sdk/shell-peer';

/**
 * The Terminal's server is the owner's shell: its MCP runs commands and its
 * session API types into the owner's sessions. Until the private Terminal
 * network (D58, Phase 5) it is on `aura-net`, so it answers only connections
 * the shell relays (its proxy and App Host, which decide who may come
 * through: the owner, the System Terminal, granted embedders) and its own
 * container (H4 stopgap). The PTY socket has the same check at its upgrade
 * (server.mjs, astro.config.mjs).
 */
export const onRequest: MiddlewareHandler = async (ctx, next) => {
  let peer: string | undefined;
  try { peer = ctx.clientAddress; } catch { peer = undefined; }
  if (!(await fromShell(peer))) return shellOnlyResponse(ctx.url.pathname);
  return next();
};
