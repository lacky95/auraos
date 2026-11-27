/**
 * The `tools` group of the built-in runtimes (D100 §5): today's provisioning
 * of `/aura/my-tools` as a host directory per instance (A4: only runtimes with
 * `hostFilesystem`), reported as an operation result. The provider confirms
 * what it applied; the legacy symlink mode makes the grant advisory (every
 * tool reachable by absolute path) and is reported as such, never as an
 * enforced boundary (D100 owner decision 1; removed in Phase 6 B).
 */
import type { SandboxRunner } from '../app-manager/SandboxRunner.js';
import type { ToolsMode } from '../app-manager/tool-provision.js';
import { operationResult, type RuntimeFeatureOverrides, type RuntimeTools } from './ari.js';
import type { RuntimeCapabilities } from './types.js';

export type { ToolsMode };

/** What the grant is on this host: `enforced` (hardlink mirror) or `advisory` (legacy symlink mode). */
export function toolsEnforcement(mode: ToolsMode): 'enforced' | 'advisory' {
  return mode === 'hardlink' ? 'enforced' : 'advisory';
}

/** The `tools` group over a runner's allowlist dir. `mode` reads the host's tools mode (null: not known). */
export function hostToolsGroup(runner: Pick<SandboxRunner, 'provisionToolsDir'>, mode: () => ToolsMode | null): RuntimeTools {
  return {
    apply(instanceId, set) {
      const target = { instanceId };
      try {
        runner.provisionToolsDir(instanceId, { tools: set.tools });
      } catch (err) {
        return operationResult('tools.liveGrant', target, 'failed', { error: { code: 'provisioning-failed', message: (err as Error).message } });
      }
      const m = mode();
      return operationResult('tools.liveGrant', target, 'applied', { detail: m ? { mode: m, enforcement: toolsEnforcement(m) } : {} });
    },
  };
}

/** Symlink mode: the tool features stay usable but `conditional`, with `enforcement: advisory`. Never upgrades an unsupported one. */
export function toolsFeatureOverrides(caps: RuntimeCapabilities, mode: ToolsMode | null): RuntimeFeatureOverrides {
  if (mode !== 'symlink' || !caps.hostFilesystem) return {};
  const advisory = { support: 'conditional' as const, constraints: { enforcement: 'advisory' } };
  return {
    'tools.provision': advisory, 'tools.liveGrant': advisory, 'tools.liveRevoke': advisory,
    ...(caps.sidecars ? { 'tools.inheritance': advisory } : {}),
  };
}
