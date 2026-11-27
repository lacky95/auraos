import { FRESH_AUTH_REQUIRE_HTTPS, isPrivilegedPermission } from '@aura/core';
import type { AuraErrorBody } from '@aura/core';
import type { AccessReason, DecideResult, PolicyOutcome, RefusalFacts } from './types.ts';

/**
 * The answer to an access refusal (error-messages review Pass A): one
 * structured body (`AuraErrorBody`) per decision, its text from the
 * exhaustive tables below (a new reason or outcome without text fails the
 * typecheck). The decision itself is never changed here: `outcome` and
 * `reason` are the ones decide() made, and the body only says them.
 *
 * What a body may say (review §4.4), held by `view`:
 *   - the caller's own app id and manifest, the route's rule (public
 *     source), and a target app only to the owner or when it is the caller's
 *     own app;
 *   - no grant hint where nothing can be granted: an owner-only rule, a
 *     system app's shipped permissions (`aura grant perms` refuses those),
 *     `admin.*`;
 *   - nothing about the System Terminal or owner agents to an app;
 *   - `unauthenticated` is one class: never which check failed;
 *   - no credential, token, env value or host path, ever.
 */

export interface RefusalView {
  /**
   * Who reads it: the owner (the host operator, the owner's login, a trusted
   * owner agent) or anyone else (an app, an API key, a member, nobody).
   */
  audience: 'owner' | 'app';
  /** The calling app, when the caller is one (or acts through one). */
  callerAppId?: string | null;
  /** The route pattern and method (the manifest's own, never the raw path). */
  route?: string;
  method?: string;
  /** Through the App Host gateway: an app's page. */
  gateway?: boolean;
  /** The install scope an app id resolves to (system apps' permissions ship with AuraOS). */
  scopeOf?(appId: string): string | undefined;
}

export interface RefusalAnswer {
  status: number;
  body: AuraErrorBody;
}

type Text = Pick<AuraErrorBody, 'message' | 'hint' | 'category'> & Partial<AuraErrorBody>;
type TextFn = (facts: RefusalFacts, view: RefusalView) => Text;

const MANIFEST = 'app.manifest.json';
const APPROVAL_STEP = 'ask with POST /api/approvals for this action, then send the same request again with the header X-Aura-Approval: <approval id> (the aura CLI and Settings do this for you)';

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** `POST /api/x` from the manifest's own pattern, or null. */
const routeName = (v: RefusalView): string | null => (v.route ? `${v.method ? `${v.method} ` : ''}${v.route}` : null);

/**
 * Whether the owner can edit an app's permissions[] (`aura grant perms`):
 * not a system app's (it refuses those), and not when the scope is unknown
 * (no grant hint is better than a wrong one).
 */
type Editable = 'editable' | 'system' | 'unknown';
function editable(view: RefusalView, appId: string | null | undefined): Editable {
  const scope = appId ? view.scopeOf?.(appId) : undefined;
  return scope === 'system' ? 'system' : scope ? 'editable' : 'unknown';
}
const isSystemApp = (view: RefusalView, appId: string | null | undefined): boolean => editable(view, appId) === 'system';

/** How the owner grants a declared privileged permission, when there is a command for it. */
function ownerGrantStep(appId: string, permission: string): string {
  if (permission.startsWith('notifications.')) {
    return `the owner grants it: aura grant notif-perms ${appId} ${permission.slice('notifications.'.length)}`;
  }
  return 'the owner grants it (a privileged permission)';
}

/** The fix for an app that does not declare `permission` (never for a system app). */
function declareStep(view: RefusalView, appId: string, permission: string): string {
  const add = `Add "${permission}" to permissions[] in ${MANIFEST}`;
  if (isPrivilegedPermission(permission)) return `${add}; then ${ownerGrantStep(appId, permission)}`;
  return editable(view, appId) === 'editable' ? `${add}, or the owner adds it: aura grant perms ${appId} ${permission}` : add;
}

function missingPermission(f: RefusalFacts, view: RefusalView): Text {
  const p = f.permission;
  if (!p) {
    return {
      message: 'The permission this call needs could not be resolved: the provider or data authority it names is not installed.',
      category: 'not-found',
    };
  }
  const app = view.callerAppId ?? null;
  const who = app ?? 'This caller';
  const facts = { permission: p, holder: f.holder ?? 'caller' } as const;
  switch (f.missing) {
    case 'grant':
      return {
        ...facts, holder: 'owner-grant',
        message: `${who} declares '${p}', but the owner has not granted it.`,
        category: 'missing-permission',
        ...(app ? { hint: upper(ownerGrantStep(app, p)) } : {}),
      };
    case 'scope':
      return {
        ...facts,
        message: `This API key has no scope '${p}'.`,
        category: 'missing-permission',
        hint: 'API key scopes are fixed when the owner creates the key: use a key with this scope.',
      };
    case 'not-grantable':
      return { ...facts, message: `'${p}' cannot be granted to an app.`, category: 'not-grantable' };
    case 'unknown-app':
      return { ...facts, message: `${who} is not an installed app.`, category: 'not-found' };
    default: {
      // 'declaration' (and a caller core cannot say more about)
      const base = { ...facts, manifestField: 'permissions[]', category: 'missing-declaration' as const };
      if (p.startsWith('admin.')) return { ...facts, message: `'${p}' is the owner's and cannot be granted to an app.`, category: 'not-grantable' };
      if (!app) return { ...base, message: `This call needs the permission '${p}'.` };
      if (isSystemApp(view, app)) {
        return {
          ...base, category: 'not-grantable',
          message: `${app} does not declare '${p}' in ${MANIFEST} permissions[]; it is a system app, whose permissions ship with AuraOS.`,
        };
      }
      return { ...base, message: `${app} does not declare '${p}' in ${MANIFEST} permissions[].`, hint: `${declareStep(view, app, p)}.` };
    }
  }
}

function missingTargetPermission(f: RefusalFacts, view: RefusalView): Text {
  const p = f.permission;
  if (!p) return { message: 'The app this call acts on does not hold the permission it needs.', category: 'missing-permission', holder: 'target' };
  const target = f.targetAppId ?? null;
  // Named only to the owner, or when it is the caller's own app (review §4.4: never another app's facts).
  const named = target && (view.audience === 'owner' || target === view.callerAppId) ? target : null;
  const base = { permission: p, holder: 'target' as const, manifestField: 'permissions[]', ...(named ? { target: named } : {}) };
  const subject = named ?? 'The app this call acts on';
  if (target && isSystemApp(view, target)) {
    return {
      ...base, category: 'not-grantable',
      message: `${subject} has to hold '${p}' for this call; ${named ? 'it is' : 'that is'} a system app, whose permissions ship with AuraOS.`,
    };
  }
  const hint = named ? `${declareStep(view, named, p)}.`
    : editable(view, target) === 'editable' ? `The owner adds '${p}' to that app: aura grant perms <that app> ${p}.` : undefined;
  return {
    ...base, category: 'missing-permission',
    message: `${subject} has to hold '${p}' for this call, and does not.`,
    ...(hint ? { hint } : {}),
  };
}

function wrongPrincipal(f: RefusalFacts, view: RefusalView): Text {
  if (f.ownerOnly) {
    return {
      message: view.audience === 'owner'
        ? 'This is the owner\'s action, and this caller cannot act as the owner here.'
        : 'This is the owner\'s action: apps cannot be granted it.',
      category: 'not-grantable',
    };
  }
  if (f.credentials?.length) {
    const token = f.credentials.includes('instance-token');
    return {
      message: `This route accepts only callers identified by: ${f.credentials.join(', ')}.`,
      category: 'not-grantable',
      ...(token && view.audience === 'app'
        ? { hint: 'Call it from the app\'s server with Authorization: Bearer $AURA_INSTANCE_TOKEN (the OS injects it into every app container).' }
        : {}),
    };
  }
  return { message: 'This route does not admit this kind of caller.', category: 'not-grantable' };
}

/** Every reason. The allowing ones never reach a refusal; they have text so the table stays exhaustive. */
const REASON_TEXT: Readonly<Record<AccessReason, TextFn>> = {
  'public': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'owner': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'own-instance': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'app-permission': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'system': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'auto-granted': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'network-caller': () => ({ message: 'Refused.', category: 'permission-denied' }),
  'unclassified': (_f, v) => ({
    message: v.gateway
      ? `${routeName(v) ?? 'This path'} is not an OS API apps can call.`
      : `${routeName(v) ?? 'This route'} has no access rule, so it is refused.`,
    category: 'unsupported-operation',
    ...(v.gateway ? { hint: 'See the SDK reference for the calls an app page can make through osClient.' } : {}),
  }),
  // One class (review §4.4 rule 4): never which check failed.
  'unauthenticated': () => ({
    message: 'No valid caller identity: this route needs a signed-in caller or an app instance token.',
    category: 'not-authenticated',
    hint: 'From an app\'s server send Authorization: Bearer $AURA_INSTANCE_TOKEN (the OS injects it into every app container); from an app page call through osClient.',
  }),
  'wrong-principal': wrongPrincipal,
  'wrong-target': (f, v) => (f.ownerOnly
    ? { message: 'This is the owner\'s action: apps cannot be granted it.', category: 'not-grantable' }
    : {
      message: 'A caller may act only on its own instance, app or resources here.',
      category: 'not-grantable',
      ...(v.audience === 'app' ? { hint: 'Use your own instance id ($AURA_INSTANCE_ID).' } : {}),
    }),
  'missing-permission': missingPermission,
  'missing-target-permission': missingTargetPermission,
  'rule-denied': () => ({ message: 'This route is closed to every caller.', category: 'not-grantable' }),
  'ambiguous-rule': () => ({
    message: 'This request matches several access rules, and only its body could tell them apart.',
    category: 'invalid-request',
  }),
  'approval-required': () => ({
    message: 'This request needs the owner\'s approval.',
    category: 'needs-approval',
    hint: `${upper(APPROVAL_STEP)}.`,
  }),
  'fresh-auth-required': () => ({
    message: 'This change needs the owner\'s fresh approval.',
    category: 'needs-approval',
    hint: `${upper(APPROVAL_STEP)}; the owner approves it in the desktop.`,
  }),
  'operator-required': () => ({
    message: `Over plain HTTP this approval is the host operator's (security option ${FRESH_AUTH_REQUIRE_HTTPS}).`,
    category: 'needs-approval',
    policy: FRESH_AUTH_REQUIRE_HTTPS,
    hint: 'Open AuraOS over HTTPS, or approve it on the host: aura approve <approval id>.',
  }),
  'https-required': () => ({
    message: 'Signing in over plain HTTP is refused on a public deployment.',
    category: 'not-grantable',
    hint: 'Open AuraOS over HTTPS.',
  }),
  'policy-error': () => ({
    message: 'AuraOS could not decide this request, so it is refused (fails closed).',
    category: 'unavailable',
    hint: 'Retry; if it persists, the owner checks aura status.',
  }),
};

/** The code and status of each outcome; `deny` is `access-denied` (401 `unauthenticated`). */
const OUTCOME_CODE: Readonly<Record<Exclude<PolicyOutcome, 'allow' | 'deny'>, string>> = {
  'needs-approval': 'needs-approval',
  'needs-fresh-auth': 'needs-fresh-auth',
  'needs-https': 'needs-https',
  'needs-operator': 'needs-operator',
};


/** The status and body of a decision that is not `allow`. */
export function refusalBody(result: DecideResult, view: RefusalView): RefusalAnswer {
  const text = REASON_TEXT[result.reason](result.facts ?? {}, view);
  const { message, ...rest } = text;
  const body: AuraErrorBody = { error: 'access-denied', message, reason: result.reason, ...rest };
  if (result.outcome !== 'deny' && result.outcome !== 'allow') return { status: 403, body: { ...body, error: OUTCOME_CODE[result.outcome] } };
  if (result.reason === 'unauthenticated') return { status: 401, body: { ...body, error: 'unauthenticated' } };
  return { status: 403, body };
}

