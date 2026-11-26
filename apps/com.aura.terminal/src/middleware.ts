import type { MiddlewareHandler } from 'astro';
import { LIFECYCLE_TOKEN_HEADER } from '@aura/app-sdk/runtime/lifecycle-guard';
import { RELAY_CLAIM_HEADER, checkShellRelay, relayServesSessionUser, shellOnlyResponse } from '@aura/app-sdk/shell-peer';

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
 * (`x-aura-relay`), or the kernel's lifecycle token on a lifecycle call;
 * `relay-strict` (strict by default since 5-main) refuses one without.
 *
 * D69 (stream T): this instance hosts one user's sessions
 * (`AURA_SESSION_USER`), and the claim must name that user (app-sdk
 * `relayServesSessionUser`): the shell checked it before relaying, and this
 * server never serves another user, whoever's address a call comes from.
 */
export const onRequest: MiddlewareHandler = async (ctx, next) => {
  let peer: string | undefined;
  try { peer = ctx.clientAddress; } catch { peer = undefined; }
  const url = new URL(ctx.request.url);
  const relay = await checkShellRelay({
    peer, header: ctx.request.headers.get(RELAY_CLAIM_HEADER), method: ctx.request.method, path: `${url.pathname}${url.search}`,
    lifecycle: ctx.request.headers.get(LIFECYCLE_TOKEN_HEADER),
  });
  if (!relayServesSessionUser(relay)) return shellOnlyResponse(ctx.url.pathname);
  return next();
};
