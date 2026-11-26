import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { authenticate } from '../../../lib/auth.ts';
import { agentHooksDisplay } from '../../../lib/approvals/display.ts';
import { approvedOrAsk, liveApprovalDeps } from '../../../lib/approvals/service.ts';
import { callerOwnsTerminal, grantedAppCaller } from '../../../lib/terminalCaller.ts';
import { createAgentHooksRoute } from '../../../lib/terminalAgents.ts';
import { fetchTerminal } from '../../../../server/terminal-embed.mjs';

/**
 * The Terminal's agent hooks in the owner's home: status for an app holding
 * `terminal.sessions.list`; install and remove also with the owner's
 * approval. Rules: lib/terminalAgents.ts.
 */
const TIMEOUT_MS = 10_000;

const handle = createAgentHooksRoute({
  caller: grantedAppCaller,
  owns: callerOwnsTerminal,
  approve: async (request, change) => {
    const principal = await authenticate(request);
    if (principal instanceof Response) return principal;
    return approvedOrAsk(liveApprovalDeps(), principal, request, {
      action: 'terminal.agent-hooks', payload: change, level: 'session', display: (by) => agentHooksDisplay(change, by),
    });
  },
  forward: async (instanceId, method) => {
    const res = await fetchTerminal(core.getAppManager(), instanceId, '/api/agent-hooks', { method }, TIMEOUT_MS);
    if (!res) return null;
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  },
});

export const GET: APIRoute = ({ request }) => handle(request);
export const POST: APIRoute = ({ request }) => handle(request);
export const DELETE: APIRoute = ({ request }) => handle(request);
