/**
 * `apps.view` (D104): the one-time view handoff for a consuming app's server.
 *
 *   POST /api/app-hosts/view  {appId, desktop} | {host}
 *     → 200 {url, origin, host, appId, expiresAt}
 *       `url` is the target's `/_aura/handoff?code=…`; the consuming server
 *       redeems it once (no browser in between) and gets the restricted view
 *       cookie, which reads the target with GET/HEAD only (app-hosts.mjs)
 *     → 202 needs-approval: the owner decides in the AuraOS dialog (one click,
 *       `session`; D102 class deferrable); the caller sends the same request
 *       again with `X-Aura-Approval` and the grant is recorded
 *     → 4xx: the one error body (`AuraErrorBody`) with the hint
 *
 * Only an app instance's own token (its server or a sidecar), never a page,
 * the gateway or the owner's login: the credential never reaches a browser.
 * The decisions are server/app-view.mjs's and core auth/appAccess.ts's.
 */
import * as core from '@aura/core';
import type { AccessPrincipal, AuraErrorBody, GrantRecord, GrantScope, GrantSubject } from '@aura/core';
import { AURA_RESERVED_PATHS, buildAppHost } from '@aura/core/host-rules';
import type { ResolvedPrincipal } from './access/identify.ts';
import { appViewDisplay, type AppViewAsk } from './approvals/display.ts';
import { actionGate, json, liveApprovalDeps, presentedApproval, type ApprovalServiceDeps } from './approvals/service.ts';
import { errorResponse } from './appResponse.js';
import { VIEW_PERMISSION, liveAppView, type AppView } from '../../server/app-view.mjs';
import { classifyHost, edgeView, hostListed, originOf } from '../../server/host-policy.mjs';

const MAX_BODY_BYTES = 4 * 1024;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

interface HostRecord {
  appId: string;
  installationId: string;
  state: string;
  slots: Array<{ slot: number; label: string; instanceId: string | null }>;
}

export interface AppViewRouteDeps extends ApprovalServiceDeps {
  resolve(request: Request): Promise<ResolvedPrincipal>;
  view: AppView;
  grants: {
    get(subject: GrantSubject, permission: string, scope: GrantScope): Promise<GrantRecord | null>;
    grant(subject: GrantSubject, permission: string, opts: {
      by: core.GrantedBy; appScope?: string; scope: GrantScope; installationId: string;
    }): Promise<{ record: GrantRecord }>;
  };
  registry: {
    listForApp(appId: string): Promise<HostRecord[]>;
    resolveLabel(label: string): Promise<{ status: string; record?: HostRecord; slot?: HostRecord['slots'][number] }>;
  };
  issueCode(input: {
    aud: string; label: string; installationId: string; appId: string; slot: number; userId: string; sid: string;
    returnPath: string; sessionExpiresAt: number; view: core.AppHostViewClaim;
  }): { code: string; expiresAt: number };
  now(): number;
}

export async function liveAppViewDeps(): Promise<AppViewRouteDeps> {
  const { appHostAuth } = await import('../../server/app-host-auth.mjs');
  return {
    ...liveApprovalDeps(),
    resolve: async (request) => (await import('./auth.ts')).resolveCaller(request),
    view: await liveAppView(),
    grants: core.getAuthServices().grants,
    registry: core.getAppHostServices().registry as unknown as AppViewRouteDeps['registry'],
    issueCode: (input) => appHostAuth().issueCode(input),
    now: Date.now,
  };
}

const refuse = (e: core.AppAccessError): Response => errorResponse(e.status, core.appAccessErrorBody(e));

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
  const text = await request.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** The target and the App Host to read it at: from an App Host address, or an app id plus the desktop host. */
async function resolveTarget(
  body: Record<string, unknown>, deps: AppViewRouteDeps,
): Promise<{ appId: string; record?: HostRecord; label?: string; base?: string } | { invalid: true } | { unknown: string }> {
  const { host, appId, desktop } = body;
  if (typeof host === 'string' && host) {
    const h = classifyHost(host);
    if (h.kind !== 'app' || !hostListed(h)) return { invalid: true };
    const found = await deps.registry.resolveLabel(h.label);
    if (found.status !== 'active' || !found.record || !found.slot) return { unknown: host };
    return { appId: found.record.appId, record: found.record, label: found.slot.label, base: h.base };
  }
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId) || typeof desktop !== 'string' || !desktop) return { invalid: true };
  const d = classifyHost(desktop);
  if (d.kind !== 'shell' || d.internal || !hostListed(d)) return { invalid: true };
  return { appId, base: desktop.trim().toLowerCase() };
}

export async function requestAppView(request: Request, deps: AppViewRouteDeps, peer?: string): Promise<Response> {
  const r = await deps.resolve(request);
  if (r.rejected) return json({ error: 'invalid-credential' }, 401);
  const p = r.principal;
  if (p.kind !== 'instance' || r.via !== 'instance-token') return refuse(core.appAccessError('server-only'));
  const consumer = p.appId;
  const consumerName = deps.appName(consumer) ?? consumer;
  const body = await readBody(request);
  if (!body) return refuse(core.appAccessError('invalid-request', { consumer, consumerName }));
  if (typeof body['level'] === 'string' && body['level'] !== 'view') {
    return refuse(core.appAccessError('level-not-available', { consumer, consumerName, permission: `apps.${String(body['level']).slice(0, 32)}` }));
  }
  const t = await resolveTarget(body, deps);
  if ('invalid' in t) return refuse(core.appAccessError('invalid-request', { consumer, consumerName }));
  if ('unknown' in t) return refuse(core.appAccessError('target-unknown', { consumer, consumerName, target: t.unknown }));
  const target = t.appId;
  const ctx = { consumer, consumerName, target };

  const blocked = deps.view.targetRefusal(consumer, target, { consumerName });
  if (blocked) return refuse(blocked);
  if (!deps.view.declares(consumer)) return refuse(core.appAccessError('not-declared', ctx));
  if (!p.userId) return refuse(core.appAccessError('no-user', ctx));

  // The target's current installation and the App Host label of its first slot (or the label named).
  const targetInstallation = (await deps.view.binding(target)).installationId;
  const record = t.record ?? (await deps.registry.listForApp(target))
    .find((rec) => rec.state === 'active' && rec.installationId === targetInstallation);
  if (!record || record.installationId !== targetInstallation) return refuse(core.appAccessError('target-no-app-host', ctx));
  const slot = t.label ? record.slots.find((s) => s.label === t.label) : (record.slots.find((s) => s.slot === 1) ?? record.slots[0]);
  const appHost = slot && t.base ? buildAppHost(slot.label, t.base) : null;
  if (!slot || !appHost) return refuse(core.appAccessError('target-no-app-host', ctx));

  const binding = await deps.view.binding(consumer);
  if (!binding.installationId) return json({ error: 'unavailable', message: `${consumerName} has no installation record yet; restart it.` }, 503);

  const subject: GrantSubject = { kind: 'app', id: consumer };
  let rec = await deps.grants.get(subject, VIEW_PERMISSION, core.appTargetScope(target, targetInstallation));
  if (!core.appAccessCounts(rec, binding, targetInstallation)) {
    const ask: AppViewAsk = { consumer, consumerInstallation: binding.installationId, target, targetInstallation };
    const gate = actionGate(deps, p as AccessPrincipal, { approvalId: presentedApproval(request) });
    if (!(await gate.allows('apps.view', ask))) {
      const why = core.appAccessErrorBody(core.appAccessError(rec ? 'grant-stale' : 'not-granted', ctx));
      const facts: Partial<AuraErrorBody> = { message: why.message, reason: why.reason, hint: why.hint, docs: why.docs, permission: why.permission, holder: why.holder, target };
      return gate.needsApproval({
        action: 'apps.view', payload: ask, level: 'session',
        display: (by) => appViewDisplay(ask, consumerName, deps.appName(target) ?? target, by),
      }, facts);
    }
    const decided = gate.consumed()?.decidedBy;
    const by = decided?.kind === 'user' ? core.userAttribution({ userId: decided.userId, sessionId: decided.sessionId }) : core.operatorAttribution();
    rec = (await deps.grants.grant(subject, VIEW_PERMISSION, {
      by, scope: core.appTargetScope(target, targetInstallation), installationId: binding.installationId,
      ...(binding.scope ? { appScope: binding.scope } : {}),
    })).record;
    try {
      await deps.audit({
        by, action: 'apps.view-granted', target: `app:${target}`, outcome: 'ok',
        detail: { consumer, target, approval: gate.consumed()?.id },
      });
    } catch { /* the audit trail must not fail the request */ }
  }

  // The audience is the address this caller reaches the shell by, with the target's App Host name.
  const edge = edgeView({ peer, header: (name: string) => request.headers.get(name) });
  const origin = originOf(edge.scheme, appHost);
  const now = deps.now();
  const { code, expiresAt } = deps.issueCode({
    aud: origin, label: slot.label, installationId: targetInstallation, appId: target, slot: slot.slot,
    userId: p.userId, sid: `view:${p.instanceId}`, returnPath: '/',
    sessionExpiresAt: now + core.APP_VIEW_CREDENTIAL_TTL_MS,
    view: { by: consumer, byInstallation: binding.installationId, grantedAt: rec!.grantedAt },
  });
  const url = new URL(AURA_RESERVED_PATHS.handoff, origin);
  url.searchParams.set('code', code);
  return json({ url: url.href, origin, host: appHost, appId: target, codeExpiresAt: expiresAt, expiresAt: now + core.APP_VIEW_CREDENTIAL_TTL_MS });
}
