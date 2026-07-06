/**
 * KeymapManager — Settings › Keyboard page. Edits the OS keymap overlay
 * stored at KV `os/keymap`.
 *
 * Reads:
 *   • registry catalogue from `/api/os/keymap`  → KeyAction[]
 *   • user overlay        from `/api/kv/os/keymap` → OsKeymapState
 *
 * Writes:
 *   • PUT `/api/kv/os/keymap` with the merged state. The shell broadcasts
 *     `kv:changed os/keymap` over SSE; OSLayout's KeyDispatcher refreshes
 *     bindings in-place and rebroadcasts claim lists to every iframe.
 *
 * No tests + no plugin hooks: a binding change just mutates one KV value.
 * Idempotent, single-PUT path keeps this simple.
 */
import * as React from 'react';
import {
  Panel,
  PanelHeader,
  PanelContent,
  PanelFooter,
  Button,
  Badge,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@aura/ui';

// Mirror the @aura/core types verbatim so this file stays free of an
// @aura/core import (apps don't depend on @aura/core directly).
type KeyScope = 'os-always' | 'os-nav' | 'os-modifier' | 'app';
interface KeyAction {
  id:           string;
  category:     string;
  label:        string;
  description?: string;
  scope:        KeyScope;
  defaultCombo: string | null;
}
interface KeymapBindings { [actionId: string]: string | null }
interface OsKeymapState {
  bindings:    KeymapBindings;
  appOverlays: { [appId: string]: KeymapBindings };
}

interface Props {
  initialActions: KeyAction[];
  initialState:   OsKeymapState;
}

export default function KeymapManager({ initialActions, initialState }: Props) {
  const [actions]       = React.useState(initialActions);
  const [state, setState] = React.useState<OsKeymapState>(initialState);
  const [error, setError] = React.useState<string | null>(null);
  const [capturingFor, setCapturingFor] = React.useState<KeyAction | null>(null);

  // Tell the outer page-level arrow-nav helper (installed in
  // keyboard.astro via `osClient.nav.installGridNav`) to pause while the
  // combo-capture dialog is open. Otherwise the user's first arrow press
  // would be eaten by the helper instead of recorded as the new binding.
  React.useEffect(() => {
    if (capturingFor) document.body.dataset['keymapCapture'] = 'true';
    else              delete document.body.dataset['keymapCapture'];
    return () => { delete document.body.dataset['keymapCapture']; };
  }, [capturingFor]);

  // ---- Effective combo for an action (default OR overlay) -----------------
  const effectiveCombo = React.useCallback((a: KeyAction): string | null => {
    if (a.id.startsWith('app.')) {
      const appId = a.id.split('.').slice(1, -1).join('.');
      const overlay = state.appOverlays[appId];
      if (overlay && a.id in overlay) return overlay[a.id] ?? null;
      return a.defaultCombo;
    }
    if (a.id in state.bindings) return state.bindings[a.id] ?? null;
    return a.defaultCombo;
  }, [state]);

  // ---- Conflict detection ------------------------------------------------
  // Two actions binding the same combo at the same scope is the warning
  // case. (Different scopes don't conflict — the dispatcher's precedence
  // resolves them deterministically.)
  const conflictMap = React.useMemo<Map<string, string[]>>(() => {
    const byCombo = new Map<string, string[]>();
    for (const a of actions) {
      const combo = effectiveCombo(a);
      if (!combo) continue;
      const key = `${a.scope}:${combo}`;
      const arr = byCombo.get(key) ?? [];
      arr.push(a.id);
      byCombo.set(key, arr);
    }
    const out = new Map<string, string[]>();
    for (const [k, ids] of byCombo) if (ids.length > 1) out.set(k, ids);
    return out;
  }, [actions, effectiveCombo]);

  const hasConflict = (a: KeyAction): boolean => {
    const combo = effectiveCombo(a);
    if (!combo) return false;
    return conflictMap.has(`${a.scope}:${combo}`);
  };

  // ---- Persistence -------------------------------------------------------
  async function persist(next: OsKeymapState): Promise<void> {
    setError(null);
    try {
      const res = await fetch('/api/kv/os/keymap', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ value: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      setState(next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function setBinding(a: KeyAction, combo: string | null): void {
    const next: OsKeymapState = {
      bindings:    { ...state.bindings },
      appOverlays: { ...state.appOverlays },
    };
    if (a.id.startsWith('app.')) {
      const appId = a.id.split('.').slice(1, -1).join('.');
      const overlay = { ...(next.appOverlays[appId] ?? {}) };
      if (combo === a.defaultCombo) delete overlay[a.id];
      else overlay[a.id] = combo;
      if (Object.keys(overlay).length === 0) delete next.appOverlays[appId];
      else next.appOverlays[appId] = overlay;
    } else {
      if (combo === a.defaultCombo) delete next.bindings[a.id];
      else next.bindings[a.id] = combo;
    }
    void persist(next);
  }

  function resetAction(a: KeyAction): void { setBinding(a, a.defaultCombo); }
  function resetAll():            void { void persist({ bindings: {}, appOverlays: {} }); }

  // ---- Categorisation ----------------------------------------------------
  // OS categories first, then a single "Apps" tab grouped per-app, mirroring
  // the plan. App actions surface even when the app isn't running — the
  // registry knows them from manifests.
  const categories = React.useMemo(() => {
    const cats = new Map<string, KeyAction[]>();
    for (const a of actions) {
      const bucket = a.id.startsWith('app.') ? 'Apps' : a.category;
      const list = cats.get(bucket) ?? [];
      list.push(a);
      cats.set(bucket, list);
    }
    return cats;
  }, [actions]);

  const tabOrder = ['Basic Navigation', 'Window Management', 'Workspaces', 'Launcher', 'Process Manager', 'Lock Screen', 'Custom', 'Apps']
    .filter((c) => categories.has(c));

  // ---- Import / Export ---------------------------------------------------
  function exportJson(): void {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'aura-keymap.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as OsKeymapState;
      if (!parsed.bindings || !parsed.appOverlays) {
        throw new Error('expected { bindings, appOverlays }');
      }
      await persist(parsed);
    } catch (err) {
      setError(`Import failed: ${(err as Error).message}`);
    }
  }

  return (
    <Panel className="keymap-panel">
      <PanelHeader>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <span>// KEYBOARD SHORTCUTS</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="outline" onClick={resetAll}>RESET ALL</Button>
            <Button size="sm" variant="outline" onClick={exportJson}>EXPORT</Button>
            <label className="keymap-import-btn">
              <span style={{ cursor: 'pointer' }}>IMPORT</span>
              <input
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void importJson(f); }}
              />
            </label>
          </div>
        </div>
      </PanelHeader>

      <PanelContent className="keymap-content">
        {error && (
          <p style={{ color: 'var(--aura-color-danger)', fontFamily: 'var(--aura-font-mono)', fontSize: '0.75rem' }}>
            ERROR — {error}
          </p>
        )}

        <Tabs defaultValue={tabOrder[0] ?? 'Basic Navigation'}>
          <TabsList>
            {tabOrder.map((c) => <TabsTrigger key={c} value={c}>{c}</TabsTrigger>)}
          </TabsList>
          {tabOrder.map((c) => (
            <TabsContent key={c} value={c}>
              {c === 'Apps' ? renderAppGroups(categories.get(c) ?? []) : renderRows(categories.get(c) ?? [])}
            </TabsContent>
          ))}
        </Tabs>
      </PanelContent>

      <PanelFooter>
        PRESS A BINDING TO REMAP · ↺ RESETS THAT ROW · CHANGES PERSIST IMMEDIATELY
      </PanelFooter>

      {capturingFor && (
        <ComboCaptureDialog
          action={capturingFor}
          onCancel={() => setCapturingFor(null)}
          onCommit={(combo) => {
            setBinding(capturingFor, combo);
            setCapturingFor(null);
          }}
          onClear={() => {
            setBinding(capturingFor, null);
            setCapturingFor(null);
          }}
        />
      )}
    </Panel>
  );

  function renderRows(rows: KeyAction[]) {
    return (
      <table className="keymap-table">
        <thead>
          <tr>
            <th style={{ width: '40%' }}>Action</th>
            <th>Binding</th>
            <th style={{ width: '4ch' }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const combo = effectiveCombo(a);
            const conflict = hasConflict(a);
            return (
              <tr key={a.id}>
                <td>
                  <div className="keymap-action-label">{a.label}</div>
                  {a.description && <div className="keymap-action-desc">{a.description}</div>}
                  <div className="keymap-action-id">{a.id}</div>
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCapturingFor(a)}
                    className="keymap-binding-btn"
                  >
                    {combo ?? '(unbound)'}
                  </Button>
                  {conflict && <Badge variant="destructive" style={{ marginLeft: 8 }}>!</Badge>}
                </td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => resetAction(a)}
                    title="Reset to default"
                  >↺</Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  function renderAppGroups(appActions: KeyAction[]) {
    const byApp = new Map<string, KeyAction[]>();
    for (const a of appActions) {
      const appId = a.id.split('.').slice(1, -1).join('.');
      const list = byApp.get(appId) ?? [];
      list.push(a);
      byApp.set(appId, list);
    }
    if (byApp.size === 0) return <p style={{ opacity: 0.7 }}>// NO APPS HAVE DECLARED KEYMAP ACTIONS YET</p>;
    return (
      <>
        {Array.from(byApp.entries()).map(([appId, list]) => (
          <section key={appId} className="keymap-app-group">
            <h3 className="keymap-app-title">{appId}</h3>
            {renderRows(list)}
          </section>
        ))}
      </>
    );
  }
}

/**
 * Modal combo capture. While open, every keydown is intercepted and the
 * canonical combo is shown live. Confirm commits to the parent.
 */
function ComboCaptureDialog(props: {
  action: KeyAction;
  onCancel: () => void;
  onCommit: (combo: string) => void;
  onClear:  () => void;
}) {
  const [captured, setCaptured] = React.useState<string | null>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't fire the dispatcher inside the capture — preventDefault here
      // means the OS won't act on the user's combo (Ctrl+1 etc.) while
      // they're typing it into a binding.
      e.preventDefault();
      e.stopPropagation();
      const combo = comboFromEvent(e);
      if (combo) setCaptured(combo);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, []);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>// REMAP · {props.action.label}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p style={{ marginBottom: 12 }}>Press the combo you want to bind. Use Ctrl/Alt/Shift/Super as modifiers.</p>
          <div className="keymap-capture-display">
            {captured ?? '(waiting…)'}
          </div>
          {props.action.defaultCombo && (
            <p style={{ marginTop: 12, fontSize: '0.7rem', color: 'var(--aura-color-text-dim)' }}>
              DEFAULT: <b>{props.action.defaultCombo}</b>
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClear}>UNBIND</Button>
          <Button variant="outline" onClick={props.onCancel}>CANCEL</Button>
          <Button
            disabled={!captured}
            onClick={() => captured && props.onCommit(captured)}
          >SAVE</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inline copy of @aura/core's comboFromEvent — apps don't depend on
 * @aura/core directly, and the function is tiny. Stays in lock-step via
 * the OS dispatcher's identical implementation on the shell side.
 */
function comboFromEvent(e: KeyboardEvent): string | null {
  const modifierCodes = new Set([
    'ControlLeft','ControlRight','AltLeft','AltRight',
    'ShiftLeft','ShiftRight','MetaLeft','MetaRight','OSLeft','OSRight',
  ]);
  if (modifierCodes.has(e.code)) return null;
  const p: string[] = [];
  if (e.ctrlKey)  p.push('Ctrl');
  if (e.altKey)   p.push('Alt');
  if (e.shiftKey) p.push('Shift');
  if (e.metaKey)  p.push('Super');
  p.push(e.code);
  return p.join('+');
}
