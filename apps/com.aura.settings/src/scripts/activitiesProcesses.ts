/**
 * Settings → Apps → ACTIVITIES & PROCESSES (D101): the user's switch for the
 * shell's last-window question, and the per-app choices they remembered in
 * it, each resettable.
 *
 * The document is the user's own preference `os/lastWindow` (per user, D46;
 * the shell's lib/lastWindow.ts owns the format and the decision):
 *
 *   { ask: boolean, apps: { <installationId | appId>: { choice: 'keep' | 'stop', appId, name?, at } } }
 *
 * No SDK import here, so a DOM test can run it: the page hands in `url`
 * (the SDK's osUrl) and its `fetch`.
 */

export type Choice = 'keep' | 'stop';
export interface Remembered { choice: Choice; appId: string; name?: string; at: number }
export interface LastWindowDoc { ask: boolean; apps: Record<string, Remembered> }

export const PREF_PATH = '/api/kv/os/lastWindow';

/** The same reading as the shell's normalizeLastWindowPrefs: unknown entries drop, `ask` defaults on. */
export function readDoc(raw: unknown): LastWindowDoc {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const src = r['apps'] && typeof r['apps'] === 'object' && !Array.isArray(r['apps']) ? r['apps'] as Record<string, unknown> : {};
  const apps: Record<string, Remembered> = {};
  for (const [key, v] of Object.entries(src)) {
    const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    if ((e['choice'] !== 'keep' && e['choice'] !== 'stop') || typeof e['appId'] !== 'string' || !e['appId']) continue;
    apps[key] = {
      choice: e['choice'], appId: e['appId'],
      ...(typeof e['name'] === 'string' && e['name'] ? { name: e['name'] } : {}),
      at: typeof e['at'] === 'number' ? e['at'] : 0,
    };
  }
  return { ask: typeof r['ask'] === 'boolean' ? r['ask'] : true, apps };
}

export interface ActivitiesProcessesDeps {
  /** The section (`#lw-section`). */
  root: HTMLElement;
  url: (path: string) => string;
  fetch?: typeof fetch;
  /** App names by id, for apps whose entry has none (the page's app list). */
  names?: Record<string, string>;
  /** Status line. */
  status?: (msg: string, tone?: 'error') => void;
}

export interface ActivitiesProcesses {
  /** Re-read the document and redraw. */
  refresh(): Promise<void>;
  doc(): LastWindowDoc;
}

const CHOICE_LABEL: Record<Choice, string> = { keep: 'KEEP RUNNING', stop: 'STOP' };

export function initActivitiesProcesses(deps: ActivitiesProcessesDeps): ActivitiesProcesses {
  const f = deps.fetch ?? fetch.bind(globalThis);
  const root = deps.root;
  const ask = root.querySelector<HTMLButtonElement>('#lw-ask')!;
  const list = root.querySelector<HTMLUListElement>('#lw-list')!;
  const empty = root.querySelector<HTMLElement>('#lw-empty')!;
  const resetAll = root.querySelector<HTMLButtonElement>('#lw-reset-all')!;
  let doc: LastWindowDoc = readDoc(null);
  let busy = false;

  async function load(): Promise<LastWindowDoc> {
    const r = await f(deps.url(PREF_PATH));
    if (r.status === 404) return readDoc(null);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return readDoc(((await r.json()) as { value?: unknown }).value);
  }

  /** Read-modify-write on the newest document: the desktop may have remembered a choice meanwhile. */
  async function change(edit: (d: LastWindowDoc) => LastWindowDoc, what: string): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = edit(await load());
      const r = await f(deps.url(PREF_PATH), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: next }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      doc = next;
      deps.status?.(`saved · ${what}`);
    } catch (err) {
      deps.status?.(`could not save (${(err as Error).message})`, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  function render(): void {
    ask.dataset['on'] = String(doc.ask);
    ask.setAttribute('aria-checked', String(doc.ask));
    const entries = Object.entries(doc.apps).sort(([, a], [, b]) => labelOf(a).localeCompare(labelOf(b)));
    list.replaceChildren(...entries.map(([key, e]) => row(key, e)));
    empty.hidden = entries.length > 0;
    resetAll.hidden = entries.length === 0;
  }

  function labelOf(e: Remembered): string {
    return deps.names?.[e.appId] ?? e.name ?? e.appId;
  }

  function row(key: string, e: Remembered): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'lw-item';
    li.dataset['key'] = key;
    const meta = document.createElement('span');
    meta.className = 'lw-item-meta';
    const name = document.createElement('span');
    name.className = 'lw-item-name';
    name.textContent = labelOf(e);
    const id = document.createElement('span');
    id.className = 'lw-item-id';
    id.textContent = e.appId;
    meta.append(name, id);
    const pill = document.createElement('span');
    pill.className = `pill ${e.choice === 'keep' ? 'on' : 'off'}`;
    pill.dataset['choice'] = e.choice;
    pill.textContent = CHOICE_LABEL[e.choice];
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'lw-reset';
    reset.textContent = 'RESET';
    reset.title = `Ask again when the last window of ${labelOf(e)} closes`;
    reset.setAttribute('aria-label', `Reset the remembered choice for ${labelOf(e)}`);
    reset.addEventListener('click', () => {
      void change((d) => { const apps = { ...d.apps }; delete apps[key]; return { ...d, apps }; }, `${labelOf(e)} asks again`);
    });
    li.append(meta, pill, reset);
    return li;
  }

  ask.addEventListener('click', () => {
    const on = ask.dataset['on'] !== 'true';
    void change((d) => ({ ...d, ask: on }), on ? 'the question is on' : 'the question is off');
  });
  resetAll.addEventListener('click', () => { void change((d) => ({ ...d, apps: {} }), 'every app asks again'); });

  async function refresh(): Promise<void> {
    try { doc = await load(); } catch (err) { deps.status?.(`could not read (${(err as Error).message})`, 'error'); }
    render();
  }
  render();
  return { refresh, doc: () => doc };
}
