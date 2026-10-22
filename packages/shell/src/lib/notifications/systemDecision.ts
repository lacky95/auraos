/**
 * DEV test hook for AuraOS desktop decisions (`scope:'desktop'`) — the logic
 * of `POST /api/admin/dev/system-decision`, injectable so it is unit tested.
 *
 * The policy is not weakened: only the in-process SYSTEM_CALLER may create a
 * desktop-wide modal. This hook exists only on the dev server, needs an admin
 * session (the CLI's `aura admin dev system-decision`, never an app page), and
 * every call is audited. The payload is validated by the normal notification
 * schema (in `create`); whatever it says, the result is a `type:'dialogue'`
 * with `scope:'desktop'`.
 */
export const DEFAULT_DECISION_COMPONENTS = [
  { kind: 'button', id: 'allow', label: 'Allow', variant: 'primary', action: 'resolve' },
  { kind: 'button', id: 'deny', label: 'Deny', variant: 'secondary', action: 'resolve' },
];

/**
 * The create input for a decision. `body.payload` (an object) is a full
 * notification input; the legacy flat fields `title`, `text`, `priority`,
 * `components` still work. Defaults fill title / text / priority /
 * components; `type` and `scope` are always forced.
 */
export function buildSystemDecisionInput(body: Record<string, unknown>): Record<string, unknown> {
  const p = body['payload'] && typeof body['payload'] === 'object' && !Array.isArray(body['payload'])
    ? { ...(body['payload'] as Record<string, unknown>) }
    : {
        ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
        ...(typeof body['text'] === 'string' ? { text: body['text'] } : {}),
        ...(typeof body['priority'] === 'string' ? { priority: body['priority'] } : {}),
        ...(Array.isArray(body['components']) ? { components: body['components'] } : {}),
      };
  return {
    title: 'AuraOS needs a decision (dev test)',
    text: 'This is a development test of a desktop-wide system decision.',
    priority: 'high',
    components: DEFAULT_DECISION_COMPONENTS,
    ...p,
    type: 'dialogue',
    scope: 'desktop',
  };
}

export interface SystemDecisionDeps {
  dev: boolean;
  requireAdmin(request: Request): Promise<unknown>;
  audit(admin: unknown, action: string, entry: Record<string, unknown>): Promise<void>;
  /** Creates as SYSTEM_CALLER; throws NotificationError-like `{status}` on invalid input. */
  create(input: Record<string, unknown>): Promise<{ notification: { id: string }; warnings?: unknown[] }>;
  readJson(request: Request): Promise<Record<string, unknown> | Response>;
  errorResponse(err: unknown): Response;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleSystemDecision(request: Request, deps: SystemDecisionDeps): Promise<Response> {
  if (!deps.dev) return json({ error: 'not found', hint: 'the system-decision test hook exists only on the dev shell (astro dev)' }, 404);
  const admin = await deps.requireAdmin(request);
  if (admin instanceof Response) {
    await deps.audit(null, 'dev.systemDecision', { outcome: 'denied' });
    return admin;
  }
  const body = await deps.readJson(request);
  if (body instanceof Response) return body;
  const input = buildSystemDecisionInput(body);
  try {
    const result = await deps.create(input);
    await deps.audit(admin, 'dev.systemDecision', { target: result.notification.id, outcome: 'ok', detail: { title: input['title'] } });
    return json({ ok: true, ...result }, 201);
  } catch (err) {
    await deps.audit(admin, 'dev.systemDecision', { outcome: 'failed', detail: { error: (err as Error).message } });
    return deps.errorResponse(err);
  }
}
