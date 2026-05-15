/**
 * WorkspaceManager — Settings › Workspaces page, composed of @aura/ui
 * (scificn) primitives. Replaces the hand-rolled HTML/JS rendering that
 * previously lived in workspaces.astro.
 *
 * Reads + writes through the same content provider as before
 * (`api/data/workspaces` + `api/data/layouts`) so the StatusBar pill row
 * and other shell-side consumers continue to work unchanged.
 */
import * as React from 'react';
import {
  Panel,
  PanelHeader,
  PanelContent,
  PanelFooter,
  Button,
  Badge,
  Label,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@aura/ui';

export interface Workspace {
  id: string;
  name: string;
  layoutId: string;
  members: string[];
}
export interface WorkspaceState {
  workspaces:        Workspace[];
  activeWorkspaceId: string;
}
export interface LayoutMeta {
  id: string;
  name: string;
  description: string;
  icon?: string;
}

export interface WorkspaceManagerProps {
  initialState: WorkspaceState;
}

function nextWorkspaceId(existing: Workspace[]): { id: string; name: string } {
  let maxN = 0;
  for (const w of existing) {
    const m = /^ws-(\d+)$/.exec(w.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return { id: `ws-${maxN + 1}`, name: `WS ${maxN + 1}` };
}

function layoutGlyph(id: string, icon?: string): string {
  if (icon) return icon;
  switch (id) {
    case 'tiling':     return '▦';
    case 'fullscreen': return '▣';
    case 'cascade':    return '▤';
    case 'columns':    return '▥';
    case 'rows':       return '▤';
    case 'stack':      return '▧';
    default:           return '▦';
  }
}

export function WorkspaceManager({ initialState }: WorkspaceManagerProps): React.JSX.Element {
  const [state, setState]     = React.useState<WorkspaceState>(initialState);
  const [layouts, setLayouts] = React.useState<LayoutMeta[]>([]);
  const [status, setStatus]   = React.useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);

  const statusTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(msg: string, kind: 'ok' | 'err' = 'ok'): void {
    setStatus({ msg, kind });
    if (statusTimer.current) clearTimeout(statusTimer.current);
    if (kind === 'ok') {
      statusTimer.current = setTimeout(() => setStatus(null), 2500);
    }
  }

  // We render inside an iframe served by the proxy; the OS KV lives at
  // the shell's root, so we hit absolute `/api/kv/...` paths. The iframe
  // is same-origin (proxy mounts it on the shell host), so no CORS work.
  async function fetchShell(path: string, init?: RequestInit): Promise<Response> {
    return fetch(path, init);
  }
  async function refreshState(): Promise<void> {
    try {
      const r = await fetchShell('/api/kv/os/workspaces');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json() as { value: WorkspaceState };
      setState(body.value);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }
  async function refreshLayouts(): Promise<void> {
    try {
      const r = await fetchShell('/api/os/layouts');
      if (!r.ok) return;
      setLayouts(await r.json() as LayoutMeta[]);
    } catch { /* keep the inline fallback */ }
  }
  async function putState(next: WorkspaceState): Promise<void> {
    const r = await fetchShell('/api/kv/os/workspaces', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ value: next }),
    });
    if (!r.ok) throw new Error(await r.text());
    const body = await r.json() as { value: WorkspaceState };
    setState(body.value);
  }

  React.useEffect(() => {
    void refreshLayouts();
    const onFocus = () => { void refreshState(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mutations ──────────────────────────────────────────────────────────
  async function activate(id: string): Promise<void> {
    try {
      await putState({ ...state, activeWorkspaceId: id });
      flash(`Activated ${id}`);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }
  async function rename(id: string, name: string): Promise<void> {
    const ws = state.workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (!name.trim() || name === ws.name) return;
    try {
      await putState({ ...state, workspaces: state.workspaces.map((w) => w.id === id ? { ...w, name } : w) });
      flash(`Renamed ${id} → ${name}`);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }
  async function pickLayout(id: string, layoutId: string): Promise<void> {
    try {
      await putState({ ...state, workspaces: state.workspaces.map((w) => w.id === id ? { ...w, layoutId } : w) });
      flash(`${id} → ${layoutId}`);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }
  async function remove(id: string): Promise<void> {
    if (state.workspaces.length <= 1) return;
    const victim = state.workspaces.find((w) => w.id === id);
    if (!victim) return;
    const remaining = state.workspaces.filter((w) => w.id !== id);
    // Migrate members into the first remaining workspace so we don't strand
    // running activities off-grid.
    if (victim.members.length > 0) {
      remaining[0]!.members = [...remaining[0]!.members, ...victim.members];
    }
    const nextActive = state.activeWorkspaceId === id ? remaining[0]!.id : state.activeWorkspaceId;
    try {
      await putState({ workspaces: remaining, activeWorkspaceId: nextActive });
      flash(`Deleted ${id}`);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }
  async function createNew(): Promise<void> {
    const { id, name } = nextWorkspaceId(state.workspaces);
    try {
      await putState({
        workspaces: [...state.workspaces, { id, name, layoutId: 'tiling', members: [] }],
        activeWorkspaceId: id,
      });
      flash(`Created ${id}`);
    } catch (err) { flash((err as Error).message ?? String(err), 'err'); }
  }

  // ── Render ────────────────────────────────────────────────────────────
  const onlyOne   = state.workspaces.length <= 1;
  const active    = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const summary   = `${state.workspaces.length} WORKSPACE${state.workspaces.length === 1 ? '' : 'S'} · ACTIVE: ${(active?.name ?? '—').toUpperCase()}`;

  return (
    <div className="space-y-6">
      <section>
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs tracking-[0.14em] uppercase text-[var(--text-muted)]">// WORKSPACES</h2>
          <span className="text-[0.55rem] tracking-[0.16em] uppercase text-[var(--text-muted)]">{summary}</span>
        </header>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {state.workspaces.map((w) => (
            <WorkspaceCard
              key={w.id}
              ws={w}
              isActive={w.id === state.activeWorkspaceId}
              onlyOne={onlyOne}
              layouts={layouts}
              onActivate={() => void activate(w.id)}
              onRename={(name) => void rename(w.id, name)}
              onPickLayout={(layoutId) => void pickLayout(w.id, layoutId)}
              onDelete={() => void remove(w.id)}
            />
          ))}
          <NewWorkspaceCard onCreate={() => void createNew()} />
        </div>

        {status && (
          <div className="mt-3 text-[0.7rem] tracking-wider"
               style={{ color: status.kind === 'err' ? 'var(--color-red)' : 'var(--text-muted)' }}>
            {status.kind === 'err' ? <b>ERROR — {status.msg}</b> : status.msg}
          </div>
        )}
      </section>

      <section>
        <header className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs tracking-[0.14em] uppercase text-[var(--text-muted)]">// AVAILABLE LAYOUTS</h2>
          <span className="text-[0.55rem] tracking-[0.16em] uppercase text-[var(--text-muted)]">REGISTRY · READ-ONLY</span>
        </header>

        {layouts.length === 0 ? (
          <div className="p-3 text-[0.7rem] tracking-wider text-[var(--text-muted)]">LOADING…</div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {layouts.map((L) => (
              <Panel key={L.id} className="grid grid-cols-[44px_1fr] gap-3 p-3 items-start">
                <div
                  className="w-11 h-11 flex items-center justify-center border border-[var(--border)] bg-[var(--color-bg)] text-[1.15rem] text-[var(--color-green)]"
                  aria-hidden="true"
                >{layoutGlyph(L.id, L.icon)}</div>
                <div className="min-w-0">
                  <div className="text-[0.8rem] tracking-widest uppercase text-[var(--color-green)] font-mono">{L.name}</div>
                  <div className="text-[0.55rem] tracking-[0.14em] uppercase text-[var(--text-muted)] mt-0.5 font-mono">{L.id}</div>
                  <div className="text-[0.7rem] leading-relaxed text-[var(--text-muted)] mt-1">{L.description}</div>
                </div>
              </Panel>
            ))}
          </div>
        )}

        <p className="text-[0.6rem] tracking-[0.1em] text-[var(--text-muted)] mt-3">
          // PLUGIN-DECLARED LAYOUTS COMING SOON — APPS WILL EXPOSE STRATEGIES VIA THEIR MANIFEST
        </p>
      </section>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────

interface WorkspaceCardProps {
  ws: Workspace;
  isActive: boolean;
  onlyOne: boolean;
  layouts: LayoutMeta[];
  onActivate: () => void;
  onRename:   (name: string) => void;
  onPickLayout: (layoutId: string) => void;
  onDelete: () => void;
}

function WorkspaceCard({
  ws, isActive, onlyOne, layouts, onActivate, onRename, onPickLayout, onDelete,
}: WorkspaceCardProps): React.JSX.Element {
  const [draftName, setDraftName] = React.useState(ws.name);
  React.useEffect(() => setDraftName(ws.name), [ws.name]);

  function commitName(): void {
    if (draftName.trim() && draftName !== ws.name) onRename(draftName.trim());
    else                                            setDraftName(ws.name); // revert empty/no-change
  }

  return (
    <Panel
      className="relative gap-2 p-3"
      data-active={isActive ? 'true' : 'false'}
      style={isActive ? { borderColor: 'var(--color-green)' } : undefined}
    >
      {isActive && (
        <span
          aria-hidden="true"
          style={{
            position:   'absolute',
            left:       0,
            top:        0,
            bottom:     0,
            width:      '3px',
            background: 'var(--color-green)',
            zIndex:     1,
          }}
        />
      )}

      <PanelHeader>
        <input
          type="text"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          spellCheck={false}
          className="ws-name-input flex-1 min-w-0 bg-transparent border-0 border-b border-dashed border-transparent text-[0.9rem] tracking-wider px-0 py-0.5 outline-none font-mono text-[var(--aura-color-text)] hover:border-[var(--aura-color-secondary)] focus:border-[var(--aura-color-primary)]"
        />
        <span className="text-[0.55rem] tracking-[0.16em] uppercase text-[var(--text-muted)] font-mono">{ws.id}</span>
        {isActive && <Badge variant="ACTIVE">ACTIVE</Badge>}
      </PanelHeader>

      <PanelContent className="p-0">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center text-[0.65rem] tracking-wider text-[var(--text-muted)]">
          <Label className="text-[0.55rem] tracking-[0.16em] uppercase opacity-70">Members</Label>
          <MembersChip count={ws.members.length} />

          <Label className="text-[0.55rem] tracking-[0.16em] uppercase opacity-70">Layout</Label>
          <Select value={ws.layoutId} onValueChange={onPickLayout}>
            <SelectTrigger className="h-7 text-[0.65rem] shadow-none focus:shadow-none">
              <SelectValue>
                <span className="font-mono uppercase tracking-wider">
                  {layoutGlyph(ws.layoutId, layouts.find((L) => L.id === ws.layoutId)?.icon)}
                  {' '}
                  {(layouts.find((L) => L.id === ws.layoutId)?.name ?? ws.layoutId).toUpperCase()}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(layouts.length > 0 ? layouts : [{ id: ws.layoutId, name: ws.layoutId, description: '', icon: '▦' } as LayoutMeta]).map((L) => (
                <SelectItem key={L.id} value={L.id}>
                  <span className="font-mono uppercase tracking-wider">{layoutGlyph(L.id, L.icon)} {L.name.toUpperCase()}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PanelContent>

      <PanelFooter className="flex gap-2 pt-2 mt-1 border-t border-dashed border-[var(--border)]">
        <Button
          variant={isActive ? 'GHOST' : 'OUTLINE'}
          size="SM"
          disabled={isActive}
          onClick={onActivate}
          className="flex-1 shadow-none hover:shadow-none focus-visible:shadow-none"
        >
          {isActive ? 'ACTIVE' : '◉ ACTIVATE'}
        </Button>
        <Button
          variant="ABORT"
          size="SM"
          disabled={onlyOne}
          onClick={onDelete}
          title={onlyOne ? 'At least one workspace must exist' : 'Delete this workspace'}
          className="flex-1 shadow-none hover:shadow-none focus-visible:shadow-none"
        >
          ✕ DELETE
        </Button>
      </PanelFooter>
    </Panel>
  );
}

function MembersChip({ count }: { count: number }): React.JSX.Element {
  const max = 5;
  const shown = Math.min(count, max);
  const dots  = '•'.repeat(shown) + (count > max ? '…' : '');
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[var(--color-green)]">
      <span className="tracking-widest opacity-70">{dots || '·'}</span>
      <span>{count} APP{count === 1 ? '' : 'S'}</span>
    </span>
  );
}

function NewWorkspaceCard({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onCreate}
      className="
        min-h-[120px] flex items-center justify-center
        border border-dashed border-[var(--border)] bg-transparent
        text-[var(--text-muted)] hover:text-[var(--color-green)]
        hover:border-[var(--color-green)]
        hover:bg-[color-mix(in_srgb,var(--color-green)_4%,transparent)]
        font-mono text-[0.7rem] tracking-[0.18em] uppercase
        cursor-pointer transition-all duration-150
      "
    >
      + NEW WORKSPACE
    </button>
  );
}

export default WorkspaceManager;
