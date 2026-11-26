/**
 * The `container` runtime (ARI §4.1): one Docker container per instance
 * (ContainerRunner). Always installed and never disabled, so it is the
 * default (Q18) and what an app falls to only when the owner decides.
 */
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import type { RuntimeModule } from '../registry.js';

export function containerRuntime(runner: SandboxRunner): RuntimeModule {
  return {
    descriptor: {
      id: 'container',
      title: 'Container',
      description: 'Each instance in its own Docker container: kernel namespaces, enforced read-only binds, sidecars, '
        + 'cross-app mounts and port expose. Instances survive a shell restart. The default.',
      builtIn: true,
      alwaysEnabled: true,
      settingsSchema: { type: 'object', properties: {} },
    },
    runner,
    capabilities: () => runner.capabilities({}),
    unavailable: () => null,
  };
}
