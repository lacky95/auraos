/**
 * The shell API for `<script is:inline>` blocks, which cannot import the SDK.
 * Every page that has one imports this from its bundled `<script>`. Modules run
 * after the inline scripts, so an inline script reads `window.auraOs` when it
 * acts (a click, a timer), never while the page is still being parsed.
 *
 *   url(path)          osUrl(): the shell API through the same-origin gateway
 *   bodylessHeaders()  what a mutation without a body needs at the gateway
 *   appHost()          the App Host bootstrap, or null when the runtime is missing
 *   askOwner(id)       show an approval in the Shell's own dialog; true only when approved
 *   owner(m, path, b)  an owner call through the gateway (D45), approval included
 */
import { ApprovalsApi, APPROVAL_HEADER, postToShell, isFromShell } from '@aura/app-sdk';
import { appHostRuntime, bodylessMutationHeaders, osUrl } from '@aura/app-sdk/os-auth';

declare global {
  interface Window {
    auraOs?: {
      url: typeof osUrl;
      bodylessHeaders: typeof bodylessMutationHeaders;
      appHost: typeof appHostRuntime;
      postToShell: typeof postToShell;
      isFromShell: typeof isFromShell;
      askOwner: typeof askOwner;
      owner: typeof owner;
    };
  }
}

/**
 * Ask AuraOS to show the approval a change created, in the Shell's own
 * dialog (the SDK's `approvals.wait`). Resolves true only when the owner
 * approved it there; false without an App Host.
 */
async function askOwner(approvalId: string): Promise<boolean> {
  if (!appHostRuntime()) return false;
  return (await new ApprovalsApi().wait(approvalId)).approved;
}

/**
 * An owner call through the gateway (D45): a read answers at once; a change
 * answers 202 needs-approval, the owner decides in the Shell's dialog, and the
 * same change goes again with that approval. Throws `cancelled` on a no.
 */
async function owner(method: string, path: string, body?: unknown): Promise<any> {
  let approvalId: string | null = null;
  for (;;) {
    const headers: Record<string, string> = body !== undefined ? { 'Content-Type': 'application/json' } : { ...bodylessMutationHeaders() };
    if (approvalId) headers[APPROVAL_HEADER] = approvalId;
    const r = await fetch(osUrl(path), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json().catch(() => ({}));
    if (r.status === 202 && data.needsApproval && data.approvalId && !approvalId) {
      if (!(await askOwner(data.approvalId))) throw new Error('cancelled');
      approvalId = data.approvalId;
      continue;
    }
    if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
    return data;
  }
}

window.auraOs = {
  url: osUrl,
  bodylessHeaders: bodylessMutationHeaders,
  appHost: appHostRuntime,
  postToShell,
  isFromShell,
  askOwner,
  owner,
};
