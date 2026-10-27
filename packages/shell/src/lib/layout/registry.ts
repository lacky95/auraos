/**
 * Browser-side layout strategy registry: layout id → behaviour
 * (ShellLayoutStrategy). Ids + display metadata come from the core
 * `layoutRegistry` (/api/os/layouts); an id without behaviour here falls back
 * to tiling, exactly like the old hard-coded renderLayout switch did.
 *
 * `registerShellLayout` is the extension hook: a new layout is a module that
 * implements ShellLayoutStrategy and registers itself here.
 */
import type { ShellLayoutStrategy } from './types.ts';
import { columns, fullscreen, rows, tiling } from './strategies/grid.ts';
import { createFreeWindow } from './strategies/freeWindow/index.ts';

const strategies = new Map<string, ShellLayoutStrategy>();

export function registerShellLayout(s: ShellLayoutStrategy): void {
  strategies.set(s.id, s);
}

export function shellLayoutFor(id: string | undefined): ShellLayoutStrategy {
  return (id && strategies.get(id)) || strategies.get('tiling')!;
}

registerShellLayout(tiling);
registerShellLayout(rows);
registerShellLayout(columns);
registerShellLayout(fullscreen);
registerShellLayout(createFreeWindow());
