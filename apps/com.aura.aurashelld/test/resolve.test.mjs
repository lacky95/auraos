// Name resolution — the rules that let a person say "Terminal", "workspace 2"
// or "Free Window" and get exactly one thing, or the candidates, never a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolveApp, resolveWorkspace, resolveLayout, resolveWindow, resolveProcess, nextLayout } = await import('../src/resolve.ts');

const apps = [
  { id: 'com.aura.terminal', name: 'Terminal', service: false, enabled: true },
  { id: 'com.aura.notepad',  name: 'Notepad',  service: false, enabled: true },
  { id: 'io.x.notes',        name: 'Notes',    service: false, enabled: true },
  { id: 'io.y.notes',        name: 'Notes',    service: false, enabled: true },
  { id: 'com.aura.registry', name: 'Registry', service: true,  enabled: true },
];

test('apps: exact id beats name, names are case-insensitive, unique substring works', () => {
  assert.equal(resolveApp(apps, 'com.aura.terminal').value.id, 'com.aura.terminal');
  assert.equal(resolveApp(apps, 'terminal').value.id, 'com.aura.terminal');
  assert.equal(resolveApp(apps, '  TERM ').value.id, 'com.aura.terminal');
  assert.equal(resolveApp(apps, 'regis').value.name, 'Registry');
});

test('apps: a shared name yields candidates; the id disambiguates; nothing yields none', () => {
  const m = resolveApp(apps, 'Notes');
  assert.equal(m.kind, 'many');
  assert.deepEqual(m.candidates.map((a) => a.id), ['io.x.notes', 'io.y.notes']);
  assert.equal(resolveApp(apps, 'io.y.notes').value.id, 'io.y.notes');
  assert.equal(resolveApp(apps, 'browser').kind, 'none');
  // "note" is a substring of Notepad AND both Notes apps → many, not the first
  assert.equal(resolveApp(apps, 'note').kind, 'many');
});

const wss = [
  { number: 1, id: 'ws-1', name: 'Main',  layoutId: 'tiling' },
  { number: 2, id: 'ws-3', name: 'Work',  layoutId: 'stack' },
  { number: 3, id: 'ws-4', name: 'work 2', layoutId: 'rows' },
];

test('workspaces: by number (1-based, out of range is explained), by id, by name, partial', () => {
  assert.equal(resolveWorkspace(wss, 2).value.id, 'ws-3');
  assert.equal(resolveWorkspace(wss, '3').value.id, 'ws-4');
  assert.match(resolveWorkspace(wss, 9).message, /no workspace 9 — there are 3/);
  assert.equal(resolveWorkspace(wss, 'ws-4').value.number, 3);
  assert.equal(resolveWorkspace(wss, 'WORK').value.id, 'ws-3');      // exact name wins over "work 2"
  assert.equal(resolveWorkspace(wss, 'wor').kind, 'many');            // substring hits both
  assert.equal(resolveWorkspace(wss, 'ma').value.name, 'Main');
});

const layouts = [
  { id: 'tiling', name: 'Tiling' }, { id: 'fullscreen', name: 'Fullscreen' },
  { id: 'stack', name: 'Free Window' }, { id: 'rows', name: 'Rows' },
];

test('layouts: id or name, case-insensitive; next wraps around', () => {
  assert.equal(resolveLayout(layouts, 'free window').value.id, 'stack');
  assert.equal(resolveLayout(layouts, 'STACK').value.id, 'stack');
  assert.equal(resolveLayout(layouts, 'til').value.id, 'tiling');
  assert.match(resolveLayout(layouts, 'grid').message, /available: Tiling, Fullscreen/);
  assert.equal(nextLayout(layouts, 'rows').id, 'tiling');
  assert.equal(nextLayout(layouts, 'nope').id, 'tiling');
});

const windows = [
  { viewId: 'com.aura.terminal-2#a1', app: 'Terminal', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', activityId: 'com.aura.terminal-2#a1', name: 'build', title: 'Terminal', workspace: { number: 1, name: 'Main' } },
  { viewId: 'com.aura.terminal-2#a2', app: 'Terminal', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', activityId: 'com.aura.terminal-2#a2', name: null,    title: 'Terminal', workspace: { number: 2, name: 'Work' } },
  { viewId: 'com.aura.notepad-1',     app: 'Notepad',  appId: 'com.aura.notepad',  instanceId: 'com.aura.notepad-1',  activityId: null, name: null, title: 'todo.txt', workspace: { number: 1, name: 'Main' } },
];

test('windows: user name first, then app name, then title; two of one app are candidates', () => {
  assert.equal(resolveWindow(windows, 'build').value.viewId, 'com.aura.terminal-2#a1');
  assert.equal(resolveWindow(windows, 'Terminal').kind, 'many');
  assert.equal(resolveWindow(windows, 'com.aura.terminal-2#a2').value.workspace.number, 2);
  assert.equal(resolveWindow(windows, 'todo').value.app, 'Notepad');
  assert.equal(resolveWindow(windows, 'zzz').kind, 'none');
});

test('processes: instance id, app name, app id', () => {
  const procs = [
    { instanceId: 'com.aura.terminal-2', app: 'Terminal', appId: 'com.aura.terminal', kind: 'app', state: 'resumed', label: 'RUN', pid: 1, port: 4001, activities: [] },
    { instanceId: 'com.aura.registry',   app: 'Registry', appId: 'com.aura.registry', kind: 'service', state: 'resumed', label: 'RUN', pid: 2, port: 4090, activities: [] },
  ];
  assert.equal(resolveProcess(procs, 'Terminal').value.instanceId, 'com.aura.terminal-2');
  assert.equal(resolveProcess(procs, 'com.aura.registry').value.kind, 'service');
  assert.equal(resolveProcess(procs, 'terminal-2').value.appId, 'com.aura.terminal');
});
