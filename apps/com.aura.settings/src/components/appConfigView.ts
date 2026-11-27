/**
 * Settings → Apps → <app> → Configuration (D108 P8): a non-wizard view over
 * the same setup API as the desktop wizard and the CLI
 * (`/api/apps/<id>/setup/**`, shell lib/setup/api.ts), built only from the
 * @aura/ui/setup components (decision W2: one renderer). Shown for apps that
 * declare `setup` or `profiles` (their `/api/apps` entry carries
 * `setupState`); a simple app gets no panel.
 *
 *   state, degraded       GET …/setup/plan (state, profiles, fields, requirements)
 *   profile, values       the owner edits a proposal; PREVIEW asks
 *                         POST …/setup/change (the privileges it adds and
 *                         gives up, the approval, §5.5 refusals, the data
 *                         that stays behind: never copied) and writes nothing
 *   APPLY / REPAIR / RESUME  POST …/reconfigure | …/repair | …/resume; an
 *                         approval is the engine's `app.setup.apply`, decided
 *                         in the desktop's dialog (on hold → RESUME continues)
 *   last applied          GET|POST …/setup/restore (decision 13; app data is
 *                         not rolled back, the notice says so)
 *   Private Home          GET|DELETE …/setup/home-private (the owner's own
 *                         grants; revoking blocks the app)
 *
 * DOM only; the page hands in `io` (reads through the gateway, changes
 * through `ownerFetch`). Never a secret value: secret fields carry handles.
 */
import type {
  HomePrivateGrantView, LastAppliedView, SetupChangePlan, SetupOutcome, SetupPlan, SetupProposal,
} from '@aura/core';
import {
  renderChangePlan, renderDependencies, renderFieldViews, renderLastApplied, renderPrivateHomeGrants, renderProfileSelector,
  type SchemaForm,
} from '@aura/ui/setup';

export interface AppConfigIo {
  /** A read (GET, or the read-only POST …/change): the JSON answer, or throws with the server's message. */
  read<T>(path: string, body?: unknown): Promise<T>;
  /** A change through the owner's gateway: status and JSON answer. */
  change(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(doc: Document, text: string, action: string, onClick: () => void): HTMLButtonElement {
  const b = el(doc, 'button', 'btn', text);
  b.type = 'button';
  b.dataset['action'] = action;
  b.addEventListener('click', onClick);
  return b;
}

/** The answer of a change in one line (no value: outcomes and D105 bodies carry none). */
export function outcomeLine(status: number, body: unknown): string {
  const o = body as Partial<SetupOutcome> & { message?: string; error?: unknown; notice?: string };
  const notice = typeof o?.notice === 'string' ? ` ${o.notice}` : '';
  switch (o?.status) {
    case 'ready': return `Ready.${notice}`;
    case 'unchanged': return `Nothing changed.${notice}`;
    case 'initializing': return `Initializing…${notice}`;
    case 'on-hold': return `Waiting for your approval in the desktop; then RESUME.${notice}`;
    case 'refused': return `Refused: ${(o.error as { message?: string } | undefined)?.message ?? 'see the reasons'}.${notice}`;
    default: return `${typeof o?.message === 'string' ? o.message : `HTTP ${status}`}${notice}`;
  }
}

const base = (appId: string): string => `/api/apps/${encodeURIComponent(appId)}/setup`;

/** Render (and wire) the Configuration panel of one app into `root`. Resolves after the first load. */
export async function renderAppConfig(root: HTMLElement, appId: string, io: AppConfigIo): Promise<void> {
  const doc = root.ownerDocument;
  const proposal: SetupProposal = {};
  let form: SchemaForm | null = null;
  const status = el(doc, 'p', 'ac-status');
  status.setAttribute('role', 'status');
  const say = (text: string, tone?: 'error'): void => {
    status.textContent = text;
    if (tone) status.dataset['tone'] = tone; else delete status.dataset['tone'];
  };

  const load = async (): Promise<void> => {
    root.replaceChildren();
    let plan: SetupPlan;
    try {
      plan = await io.read<SetupPlan>(`${base(appId)}/plan`);
    } catch (err) {
      root.append(el(doc, 'p', 'ac-note', `The configuration can't be read: ${(err as Error).message}`));
      return;
    }
    const st = plan.state;
    const head = el(doc, 'p', 'ac-state', `State: ${st.state}${st.profile ? ` · profile ${st.profile}` : ''}`);
    head.dataset['state'] = st.state;
    root.append(head);
    if (st.error) root.append(el(doc, 'p', 'ac-note', st.error.message));

    if (plan.profiles.length) {
      const p = el(doc, 'div');
      renderProfileSelector(p, { profiles: plan.profiles, selected: proposal.profile ?? st.profile }, {
        onSelect(id) { proposal.profile = id; void preview(); },
      });
      root.append(p);
    }
    if (plan.fields.length) {
      const f = el(doc, 'div');
      form = renderFieldViews(f, plan.fields, { profile: proposal.profile ?? st.profile });
      root.append(f);
    }
    const req = el(doc, 'div');
    renderDependencies(req, { dependencies: [], requirements: plan.requirements, degraded: plan.degraded });
    root.append(req);

    const changeBox = el(doc, 'div', 'ac-change');
    changeBox.dataset['changePlan'] = '';
    const actions = el(doc, 'div', 'ac-actions');
    actions.append(
      btn(doc, 'PREVIEW', 'preview', () => { void preview(); }),
      btn(doc, 'APPLY…', 'apply', () => { void act('/reconfigure', 'POST', collect()); }),
      ...(st.state === 'repair-required' || st.state === 'setup-failed' ? [btn(doc, 'REPAIR…', 'repair', () => { void act('/repair', 'POST', collect()); })] : []),
      ...(st.state === 'awaiting-approval' || st.state === 'blocked' || st.state === 'initializing' ? [btn(doc, 'RESUME', 'resume', () => { void act('/resume', 'POST', {}); })] : []),
    );
    root.append(changeBox, actions, status);

    const last = el(doc, 'div');
    const home = el(doc, 'div');
    root.append(last, home);
    try {
      const l = await io.read<{ lastApplied: LastAppliedView | null }>(`${base(appId)}/restore`);
      renderLastApplied(last, { view: l.lastApplied }, { restore() { void act('/restore', 'POST', undefined); } });
    } catch { /* an older shell: no restore */ }
    try {
      const grants = await io.read<HomePrivateGrantView[]>(`${base(appId)}/home-private`);
      renderPrivateHomeGrants(home, { grants }, {
        revoke(sidecar) { void act(`/home-private${sidecar ? `?sidecar=${encodeURIComponent(sidecar)}` : ''}`, 'DELETE', undefined); },
      });
    } catch { /* an older shell: no revoke surface */ }

    async function preview(): Promise<void> {
      try {
        const plan2 = await io.read<SetupChangePlan>(`${base(appId)}/change`, collect());
        renderChangePlan(changeBox, { plan: plan2, appName: appId });
        say('');
      } catch (err) {
        say((err as Error).message, 'error');
      }
    }
  };

  const collect = (): SetupProposal => {
    const values = form?.read() ?? {};
    const secrets = form?.secrets() ?? {};
    return {
      ...(proposal.profile !== undefined ? { profile: proposal.profile } : {}),
      ...(Object.keys(values).length ? { values } : {}),
      ...(Object.keys(secrets).length ? { secrets } : {}),
    };
  };

  const act = async (sub: string, method: string, body: unknown): Promise<void> => {
    say('Working…');
    try {
      const r = await io.change(`${base(appId)}${sub}`, method, body);
      const line = outcomeLine(r.status, r.body);
      await load();
      say(line, r.status >= 400 ? 'error' : undefined);
    } catch (err) {
      say((err as Error).message, 'error');
    }
  };

  await load();
}
