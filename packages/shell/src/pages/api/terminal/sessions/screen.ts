import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { verifiedAppCaller } from '../../../../lib/terminalCaller.ts';
import { createScreenStateRoute } from '../../../../lib/terminalScreen.ts';
import {
  fetchTerminal, isSystemTerminal, mayReadScreens, terminalSessionInstance,
} from '../../../../../server/terminal-embed.mjs';

/**
 * What a Terminal session's screen shows, as derived facts only, for an app
 * holding `terminal.sessions.list` and `terminal.screen.read` (5.16). The
 * rules and the reasons: lib/terminalScreen.ts.
 */

const TIMEOUT_MS = 10_000;

async function terminalJson<T>(instanceId: string, path: string): Promise<T | null> {
  const res = await fetchTerminal(core.getAppManager(), instanceId, path, {}, TIMEOUT_MS);
  if (!res) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as T;
}

const handle = createScreenStateRoute({
  caller: (request) => verifiedAppCaller(request, core.getAppManager()),
  isSystemTerminal,
  mayReadScreens,
  sessionInstance: (id) => terminalSessionInstance(id) ?? null,
  listed: async (instanceId) => {
    const r = await terminalJson<{ sessions?: Array<{ id?: unknown }> }>(instanceId, '/api/sessions');
    return r ? (r.sessions ?? []).map((s) => s.id).filter((id): id is string => typeof id === 'string') : null;
  },
  screen: async (instanceId, sessionId) => {
    const r = await terminalJson<{ screen?: unknown }>(instanceId, `/api/sessions/screen?id=${encodeURIComponent(sessionId)}`);
    if (!r) throw new Error('not running');
    return Array.isArray(r.screen) ? r.screen.filter((row): row is string => typeof row === 'string') : [];
  },
});

export const GET: APIRoute = ({ request }) => handle(request);
