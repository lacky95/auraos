/**
 * Multi-tab notepad state.
 *
 * Persistence layout (all under /data):
 *   files/                  ← user-visible file tree (save/load dialog root)
 *   cache/
 *     tabs.json             ← tab metadata + active tab + next untitled number
 *     tabs/<id>.txt         ← content of untitled (path-less) tabs
 *
 * Named tabs (path !== null) auto-save directly to their path.
 * Untitled tabs auto-save to cache/tabs/<id>.txt.
 * On first run, migrates old /data/note.txt if present.
 */
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type Tab = {
  id:       string;
  name:     string;
  path:     string | null;   // null = untitled; absolute path under /data/files/
  text:     string;
  revision: number;
};

type NotepadState = {
  tabs:            Tab[];
  activeTabId:     string;
  nextUntitledNum: number;
  activities:      Set<string>;
  listeners:       Set<() => void>;
};

const DATA_DIR   = process.env['AURA_DATA_DIR'] ?? '/data';
export const FILES_DIR  = join(DATA_DIR, 'files');
const CACHE_DIR  = join(DATA_DIR, 'cache');
const TABS_META  = join(CACHE_DIR, 'tabs.json');
const CACHE_TABS = join(CACHE_DIR, 'tabs');
const OLD_NOTE   = join(DATA_DIR, 'note.txt');

interface TabMeta {
  id: string; name: string; path: string | null; revision: number;
}
interface StateMeta {
  tabs: TabMeta[]; activeTabId: string; nextUntitledNum: number;
}

function ensureDirs() {
  mkdirSync(FILES_DIR,  { recursive: true });
  mkdirSync(CACHE_TABS, { recursive: true });
}

function loadTabText(tab: TabMeta): string {
  try {
    if (tab.path && existsSync(tab.path)) return readFileSync(tab.path, 'utf-8');
    const f = join(CACHE_TABS, `${tab.id}.txt`);
    if (existsSync(f)) return readFileSync(f, 'utf-8');
  } catch {}
  return '';
}

function loadState(): NotepadState {
  ensureDirs();
  if (existsSync(TABS_META)) {
    try {
      const meta = JSON.parse(readFileSync(TABS_META, 'utf-8')) as StateMeta;
      const tabs = meta.tabs.map((t): Tab => ({ ...t, text: loadTabText(t) }));
      if (tabs.length > 0) {
        return {
          tabs,
          activeTabId:     meta.activeTabId ?? tabs[0]!.id,
          nextUntitledNum: meta.nextUntitledNum ?? tabs.length + 1,
          activities: new Set(),
          listeners:  new Set(),
        };
      }
    } catch {}
  }
  // Migrate old single-file notepad
  let initialText = '';
  try { if (existsSync(OLD_NOTE)) initialText = readFileSync(OLD_NOTE, 'utf-8'); } catch {}
  const first: Tab = { id: 'tab-1', name: 'new 1', path: null, text: initialText, revision: 0 };
  return { tabs: [first], activeTabId: 'tab-1', nextUntitledNum: 2, activities: new Set(), listeners: new Set() };
}

function saveMeta(s: NotepadState): void {
  try {
    ensureDirs();
    const meta: StateMeta = {
      tabs: s.tabs.map(t => ({ id: t.id, name: t.name, path: t.path, revision: t.revision })),
      activeTabId:     s.activeTabId,
      nextUntitledNum: s.nextUntitledNum,
    };
    writeFileSync(TABS_META, JSON.stringify(meta, null, 2), 'utf-8');
  } catch {}
}

function saveTabContent(tab: Tab): void {
  try {
    if (tab.path) {
      mkdirSync(dirname(tab.path), { recursive: true });
      writeFileSync(tab.path, tab.text, 'utf-8');
    } else {
      ensureDirs();
      writeFileSync(join(CACHE_TABS, `${tab.id}.txt`), tab.text, 'utf-8');
    }
  } catch {}
}

function broadcast(s: NotepadState): void {
  for (const cb of s.listeners) { try { cb(); } catch {} }
}

// ── Singleton ────────────────────────────────────────────────────────────────

const KEY = '__aura_notepad_state__';
const g = globalThis as typeof globalThis & { [KEY]?: NotepadState };

if (!g[KEY]) {
  g[KEY] = loadState();
  saveMeta(g[KEY]);
  for (const tab of g[KEY].tabs) if (tab.text) saveTabContent(tab);
}

export const state = g[KEY]!;

// ── Snapshots ────────────────────────────────────────────────────────────────

/**
 * SSE snapshot. Includes EVERY tab's text so each window can display whichever
 * tab it has locally selected — the active tab is a per-window concept, not a
 * shared one. `defaultActiveId` is only a hint for what a freshly-opened window
 * should show before the user picks a tab.
 */
export function sseSnapshot() {
  return {
    tabs: state.tabs.map(t => ({
      id: t.id, name: t.name, path: t.path, revision: t.revision, text: t.text,
    })),
    defaultActiveId: state.activeTabId,
    activityCount:   state.activities.size,
  };
}

/** Full metadata for GET /api/tabs. */
export function tabsSnapshot() {
  return {
    tabs: state.tabs.map(t => ({ id: t.id, name: t.name, path: t.path, revision: t.revision })),
    activeTabId: state.activeTabId,
  };
}

/** Full tab including text for GET /api/tabs/[id]. */
export function tabDetail(id: string) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return null;
  return { id: tab.id, name: tab.name, path: tab.path, text: tab.text, revision: tab.revision };
}

// ── Mutations ────────────────────────────────────────────────────────────────

export function createTab(): Tab {
  const id   = `tab-${Date.now()}`;
  const name = `new ${state.nextUntitledNum}`;
  state.nextUntitledNum += 1;
  const tab: Tab = { id, name, path: null, text: '', revision: 0 };
  state.tabs.push(tab);
  state.activeTabId = id;
  saveMeta(state);
  broadcast(state);
  return tab;
}

export function closeTab(id: string): void {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx]!;
  if (!tab.path) {
    try { rmSync(join(CACHE_TABS, `${tab.id}.txt`), { force: true }); } catch {}
  }
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    const t: Tab = { id: `tab-${Date.now()}`, name: `new ${state.nextUntitledNum}`, path: null, text: '', revision: 0 };
    state.nextUntitledNum += 1;
    state.tabs.push(t);
    state.activeTabId = t.id;
  } else if (state.activeTabId === id) {
    state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)]!.id;
  }
  saveMeta(state);
  broadcast(state);
}

export function setActiveTab(id: string): void {
  if (!state.tabs.find(t => t.id === id)) return;
  state.activeTabId = id;
  saveMeta(state);
  broadcast(state);
}

export function setTabText(id: string, text: string): void {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  tab.text = text;
  tab.revision += 1;
  saveTabContent(tab);
  saveMeta(state);
  broadcast(state);
}

export function saveTabToPath(id: string, path: string, name: string): void {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  const wasUntitled = !tab.path;
  tab.path = path;
  tab.name = name;
  tab.revision += 1;
  saveTabContent(tab);
  if (wasUntitled) {
    try { rmSync(join(CACHE_TABS, `${tab.id}.txt`), { force: true }); } catch {}
  }
  saveMeta(state);
  broadcast(state);
}

export function loadFile(path: string, name: string, text: string): string {
  const existing = state.tabs.find(t => t.path === path);
  if (existing) {
    state.activeTabId = existing.id;
    saveMeta(state);
    broadcast(state);
    return existing.id;
  }
  const id  = `tab-${Date.now()}`;
  const tab: Tab = { id, name, path, text, revision: 0 };
  state.tabs.push(tab);
  state.activeTabId = id;
  saveMeta(state);
  broadcast(state);
  return id;
}

export function clearAll(): void {
  state.activities.clear();
  broadcast(state);
}
