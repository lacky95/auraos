/**
 * Free Window CSS, injected once on activation so the strategy stays
 * self-contained (the shell's global stylesheet knows nothing about it).
 */
// Handles sit just inside the slot border: slots are `overflow:clip`.
const CSS = `
.app-slot > .fw-resize { position:absolute; z-index:3; touch-action:none; }
.app-slot > .fw-resize[data-handle="s"]  { bottom:0; left:10px; right:10px; height:6px; cursor:ns-resize; }
.app-slot > .fw-resize[data-handle="e"]  { right:0; top:10px; bottom:10px; width:6px; cursor:ew-resize; }
.app-slot > .fw-resize[data-handle="w"]  { left:0; top:10px; bottom:10px; width:6px; cursor:ew-resize; }
.app-slot > .fw-resize[data-handle="sw"] { bottom:0; left:0; width:12px; height:12px; cursor:nesw-resize; }
.app-slot > .fw-resize[data-handle="se"] {
  bottom:0; right:0; width:14px; height:14px; cursor:nwse-resize;
  background:linear-gradient(135deg,transparent 50%,var(--aura-color-text-dim) 50%); opacity:0.6;
}
@media (pointer: coarse) {
  .app-slot > .fw-resize[data-handle="s"] { height:14px; }
  .app-slot > .fw-resize[data-handle="e"], .app-slot > .fw-resize[data-handle="w"] { width:14px; }
  .app-slot > .fw-resize[data-handle$="e"]:not([data-handle="e"]),
  .app-slot > .fw-resize[data-handle$="w"]:not([data-handle="w"]) { width:26px; height:26px; }
}
.app-slot[data-fw-zone] { box-shadow:none; }

.fw-snap-preview {
  position:absolute; pointer-events:none; box-sizing:border-box;
  border:2px solid var(--aura-color-primary);
  background:color-mix(in srgb, var(--aura-color-primary) 14%, transparent);
  box-shadow:var(--aura-glow-primary);
  opacity:0; transition:opacity 90ms ease, left 90ms ease, top 90ms ease, width 90ms ease, height 90ms ease;
}
.fw-snap-preview[data-on="1"] { opacity:1; }

.fw-splitter { position:absolute; pointer-events:auto; touch-action:none; z-index:1; }
.fw-splitter[data-axis="v"] { cursor:col-resize; }
.fw-splitter[data-axis="h"] { cursor:row-resize; }
.fw-splitter::after {
  content:''; position:absolute; background:var(--aura-color-primary); opacity:0; transition:opacity 120ms ease;
}
.fw-splitter[data-axis="v"]::after { left:calc(50% - 1px); top:0; bottom:0; width:2px; }
.fw-splitter[data-axis="h"]::after { top:calc(50% - 1px); left:0; right:0; height:2px; }
.fw-splitter:hover::after, body.aura-stack-dragging .fw-splitter::after { opacity:0.8; }

.fw-taskbar {
  display:flex; align-items:center; gap:4px; height:30px; padding:0 6px; box-sizing:border-box;
  background:var(--aura-color-surface); border-bottom:var(--aura-border);
  overflow-x:auto; overflow-y:hidden; scrollbar-width:thin;
}
.fw-taskbar-empty { color:var(--aura-color-text-dim); font-size:0.6rem; letter-spacing:0.12em; padding:0 4px; }
.fw-task {
  display:inline-flex; align-items:center; gap:6px; flex:0 1 180px; min-width:72px; height:22px; padding:0 8px;
  background:transparent; border:var(--aura-border); color:var(--aura-color-text-dim);
  font-family:var(--aura-font-mono); font-size:0.65rem; letter-spacing:0.04em; cursor:pointer;
}
.fw-task-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fw-task-dot { flex:none; width:6px; height:6px; border-radius:50%; background:var(--aura-color-text-dim); }
.fw-task:hover { color:var(--aura-color-primary); border-color:var(--aura-color-primary); }
.fw-task:focus-visible { outline:none; box-shadow:0 0 0 1px var(--aura-color-primary); }
.fw-task[data-front="1"] { color:var(--aura-color-primary); border-color:var(--aura-color-primary); background:var(--aura-color-surface-2); }
.fw-task[data-front="1"] .fw-task-dot { background:var(--aura-color-primary); }
.fw-task[data-min="1"] { opacity:0.55; border-style:dashed; }
`;

export function ensureFreeWindowStyles(): void {
  if (document.getElementById('aura-free-activity-css')) return;
  const s = document.createElement('style');
  s.id = 'aura-free-activity-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}
