/**
 * The built-in runtimes (ARI §4.1), listed once like `SECURITY_OPTIONS`.
 * AppManager registers exactly these; `opts.runtimes` adds test-only ones.
 * Installable runtimes are designed, not built (D64 `runtime-install`,
 * reserved; ARI-2). Each module lives in `runtimes/<id>/` (5b CR, PR).
 */
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import type { RuntimeModule } from '../ari.js';
import { containerRuntime, type ContainerRunnerSurface } from '../container/index.js';
import type { ToolsMode } from '../hostTools.js';
import { prootRuntime } from '../proot/index.js';

/** What the built-ins are made from, handed in by the composition point (today's runners). */
export interface BuiltinRuntimeDeps {
  container: ContainerRunnerSurface;
  proot: SandboxRunner;
  baseRootfs: string;
  env?: Record<string, string | undefined>;
  /** The host's tools mode (tool-provision `currentToolsMode`). */
  toolsMode?: () => ToolsMode;
}

export const BUILTIN_RUNTIMES: ReadonlyArray<{ id: string; create(deps: BuiltinRuntimeDeps): RuntimeModule }> = Object.freeze([
  { id: 'container', create: (d: BuiltinRuntimeDeps) => containerRuntime(d.container, d.toolsMode ? { toolsMode: d.toolsMode } : {}) },
  { id: 'proot', create: (d: BuiltinRuntimeDeps) => prootRuntime(d.proot, {
    baseRootfs: d.baseRootfs, ...(d.env ? { env: d.env } : {}), ...(d.toolsMode ? { toolsMode: d.toolsMode } : {}),
  }) },
]);
