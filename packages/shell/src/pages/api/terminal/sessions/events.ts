import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { callerOwnsTerminal, grantedAppCaller } from '../../../../lib/terminalCaller.ts';
import { createAgentEventsRoute } from '../../../../lib/terminalAgents.ts';
import { fetchTerminal, holdsListGrant } from '../../../../../server/terminal-embed.mjs';

/**
 * A Terminal instance's agent events as SSE, for an app holding
 * `terminal.sessions.list` (TerminalX's watcher). Rules: lib/terminalAgents.ts.
 */
const handle = createAgentEventsRoute({
  caller: grantedAppCaller,
  holdsListGrant,
  owns: callerOwnsTerminal,
  open: (instanceId, signal) => fetchTerminal(core.getAppManager(), instanceId, '/api/sessions/events?stream=1', { signal }, null),
});

export const GET: APIRoute = ({ request }) => handle(request);
