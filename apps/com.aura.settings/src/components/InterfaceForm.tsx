/**
 * InterfaceForm — Settings › Interfaces › Add / Edit.
 *
 * Registers an external endpoint (a remote MCP server, a REST API, a
 * WebSocket) as a custom interface. Step one picks the kind; the fields below
 * follow from it. Validation mirrors CustomInterfaceSchema in @aura/core —
 * the shell re-validates, this only saves a round trip.
 *
 * Styled like Settings › Layout Managers (cards on surface-2, primary titles,
 * full-contrast body text) via interface-form.css — plain elements, so the
 * contrast is ours to set rather than inherited from scificn defaults.
 */
import * as React from 'react';
// Styles: interface-form.css, imported by the pages (a CSS import here would
// only be injected by Vite's client runtime, which the proxied iframe lacks).

export interface CustomInterface {
  name: string;
  kind: string;
  address: string;
  version?: string;
  description?: string;
  schema?: string;
}

interface KindSpec {
  kind: string;
  label: string;
  hint: string;
  placeholder: string;
}

const KIND_GROUPS: Array<{ transport: string; kinds: KindSpec[] }> = [
  {
    transport: 'HTTP',
    kinds: [
      { kind: 'http/rest',    label: 'REST',           hint: 'JSON over HTTP. Optionally link an OpenAPI document.', placeholder: 'https://api.example.com/v1' },
      { kind: 'http/mcp',     label: 'MCP · streamable', hint: 'MCP over streamable HTTP — the current transport. One endpoint for POST + GET.', placeholder: 'https://host.example.com/mcp' },
      { kind: 'http/mcp-sse', label: 'MCP · SSE',      hint: 'Legacy MCP SSE transport. Give the SSE stream endpoint; the server announces where to POST.', placeholder: 'https://host.example.com/sse' },
      { kind: 'http/raw',     label: 'Plain HTTP',     hint: 'Any other HTTP endpoint.', placeholder: 'https://host.example.com/' },
    ],
  },
  {
    transport: 'WebSocket',
    kinds: [
      { kind: 'ws/raw', label: 'WebSocket',  hint: 'Any WebSocket endpoint.', placeholder: 'wss://host.example.com/socket' },
      { kind: 'ws/acp', label: 'ACP',        hint: 'Agent Client Protocol — JSON-RPC over WebSocket.', placeholder: 'wss://host.example.com/acp' },
      { kind: 'ws/cdp', label: 'Chrome CDP', hint: 'Chrome DevTools Protocol endpoint.', placeholder: 'ws://host.example.com:9222/devtools/browser' },
    ],
  },
];
const KIND_SPECS = KIND_GROUPS.flatMap((g) => g.kinds);

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function validate(v: CustomInterface): string | null {
  if (!v.kind) return 'Pick a kind.';
  if (!NAME_RE.test(v.name)) return 'Name must be kebab-case, starting with a letter (e.g. remote-mcp).';
  const scheme = v.kind.startsWith('ws/') ? /^wss?:\/\// : /^https?:\/\//;
  if (!scheme.test(v.address)) {
    return v.kind.startsWith('ws/') ? 'URL must start with ws:// or wss://.' : 'URL must start with http:// or https://.';
  }
  try { new URL(v.address); } catch { return 'URL is not valid.'; }
  return null;
}

/** `/api/proxy/com.aura.settings/interfaces/new` → `/api/proxy/com.aura.settings/interfaces`. */
function listPath(): string {
  return location.pathname.replace(/\/interfaces(\/.*)?$/, '/interfaces');
}

export interface InterfaceFormProps {
  /** Present when editing; its `name` is the entry being replaced. */
  initial?: CustomInterface | null;
}

export default function InterfaceForm({ initial }: InterfaceFormProps): React.ReactElement {
  const editing = !!initial;
  const [v, setV] = React.useState<CustomInterface>(
    initial ?? { name: '', kind: '', address: '', version: '1', description: '', schema: '' },
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const spec = KIND_SPECS.find((k) => k.kind === v.kind);

  const set = (patch: Partial<CustomInterface>) => setV((prev) => ({ ...prev, ...patch }));

  async function save(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const problem = validate(v);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    const body: CustomInterface = {
      name: v.name, kind: v.kind, address: v.address.trim(), version: v.version?.trim() || '1',
      ...(v.description?.trim() ? { description: v.description.trim() } : {}),
      ...(v.kind === 'http/rest' && v.schema?.trim() ? { schema: v.schema.trim() } : {}),
    };
    try {
      const r = await fetch(
        editing ? `/api/interfaces/custom/${encodeURIComponent(initial!.name)}` : '/api/interfaces/custom',
        { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!r.ok) {
        const msg = await r.json().then((j: { error?: string }) => j.error).catch(() => null);
        throw new Error(msg ?? `HTTP ${r.status}`);
      }
      location.href = listPath();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const cancel = () => { location.href = listPath(); };

  return (
    <form className="if-form" onSubmit={(e) => void save(e)}>
      <section className="if-card">
        <div className="if-card-head">
          <span className="if-step">1</span>
          <div>
            <div className="if-card-title">Kind</div>
            <p className="if-card-desc">How the endpoint is reached, and what it speaks.</p>
          </div>
        </div>
        <div className="if-card-body">
          {KIND_GROUPS.map((g) => (
            <div key={g.transport} className="if-group">
              <div className="if-label">{g.transport}</div>
              <div className="if-kinds">
                {g.kinds.map((k) => (
                  <button
                    key={k.kind}
                    type="button"
                    className="if-kind"
                    aria-pressed={v.kind === k.kind}
                    onClick={() => set({ kind: k.kind })}
                  >
                    <span className="if-kind-name">{k.label}</span>
                    <span className="if-kind-id">{k.kind}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {spec && (
        <section className="if-card">
          <div className="if-card-head">
            <span className="if-step">2</span>
            <div>
              <div className="if-card-title">
                {spec.label} <span className="if-card-id">{spec.kind}</span>
              </div>
              <p className="if-card-desc">{spec.hint}</p>
            </div>
          </div>
          <div className="if-card-body if-fields">
            <Field label="Name" hint={`Listed as custom/${v.name || '<name>'}`}>
              <input className="if-input" type="text" value={v.name} placeholder="remote-mcp"
                     autoComplete="off" spellCheck={false} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label={spec.kind === 'http/mcp-sse' ? 'SSE endpoint URL' : 'URL'}>
              <input className="if-input" type="text" value={v.address} placeholder={spec.placeholder}
                     autoComplete="off" spellCheck={false} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            {spec.kind === 'http/rest' && (
              <Field label="OpenAPI / schema URL" hint="Optional. Descriptive only.">
                <input className="if-input" type="text" value={v.schema ?? ''}
                       placeholder="https://api.example.com/openapi.json" autoComplete="off" spellCheck={false}
                       onChange={(e) => set({ schema: e.target.value })} />
              </Field>
            )}
            <Field label="Version" hint="Free-form contract version consumers may pin.">
              <input className="if-input" type="text" value={v.version ?? ''} placeholder="1"
                     onChange={(e) => set({ version: e.target.value })} />
            </Field>
            <Field label="Description">
              <input className="if-input" type="text" value={v.description ?? ''}
                     placeholder="What this endpoint is for" onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </div>
          <div className="if-card-foot">
            <button type="submit" className="if-btn if-btn-primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save' : 'Add interface'}
            </button>
            <button type="button" className="if-btn" onClick={cancel}>Cancel</button>
            {error && <span className="if-error">{error}</span>}
          </div>
        </section>
      )}
      {!spec && (
        <div><button type="button" className="if-btn" onClick={cancel}>Cancel</button></div>
      )}
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="if-field">
      <span className="if-label">{label}</span>
      {children}
      {hint && <span className="if-hint">{hint}</span>}
    </label>
  );
}
