/**
 * The built-in runtimes (ARI §4.1), listed once like `SECURITY_OPTIONS`.
 * AppManager registers exactly these; `opts.runtimes` adds test-only ones.
 * Installable runtimes are designed, not built (D64 `runtime-install`,
 * reserved; ARI-2).
 */
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import type { RuntimeModule } from '../ari.js';
import { containerRuntime } from './container.js';
import { prootRuntime } from './proot.js';

/** What the built-ins are made from: today's runners (5b CR/PR move them into `runtimes/<id>/`). */
export interface BuiltinRuntimeDeps {
  container: SandboxRunner;
  proot: SandboxRunner;
  baseRootfs: string;
  env?: Record<string, string | undefined>;
}

export const BUILTIN_RUNTIMES: ReadonlyArray<{ id: string; create(deps: BuiltinRuntimeDeps): RuntimeModule }> = Object.freeze([
  { id: 'container', create: (d: BuiltinRuntimeDeps) => containerRuntime(d.container) },
  { id: 'proot', create: (d: BuiltinRuntimeDeps) => prootRuntime(d.proot, { baseRootfs: d.baseRootfs, ...(d.env ? { env: d.env } : {}) }) },
]);
