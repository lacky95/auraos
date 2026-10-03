/** Opt-in integration check against the installed console2 fixture. Source is
 * copied off the watched app scopes; no app lifecycle hooks run. */
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { AppManifestSchema } from '../dist/types/manifest.js';

const source = process.env.AURA_PREPARATION_SMOKE_SOURCE;
if (!source) throw new Error('Set AURA_PREPARATION_SMOKE_SOURCE to a managed app directory');
const mode = process.env.AURA_PREPARATION_SMOKE_RUNTIME ?? 'docker';
const fixture = '/data/aura-development/preparation-smoke-' + mode;
const appDir = join(fixture, 'app');
rmSync(fixture, { recursive: true, force: true });
mkdirSync(fixture, { recursive: true });
cpSync(source, appDir, { recursive: true, verbatimSymlinks: true, filter: p => !p.includes('/.git/') && !p.endsWith('/.git') });
const manifest = AppManifestSchema.parse(JSON.parse(readFileSync(join(appDir, 'app.manifest.json'), 'utf8')));
rmSync(join(fixture, 'state'), { recursive: true, force: true });
const Runner = mode === 'docker' ? ContainerRunner : ProotRunner;
const runner = new Runner({ baseRootfs: '/os/base-rootfs', toolchainDir: '/os/toolchain', appsDir: '/workspace/apps', dataDir: '/data', osApiBase: 'http://aura-shell:3000' });
// Exercise real Docker mounts/runtime, with an empty test context instead of
// starting another KV server or reading live application secrets.
runner.volumeStore = { ensureAll: async () => {}, resolveMounts: async () => [], volumesDir: '/data/context/volumes' };
runner.contextStore = { ensureDir: () => {}, resolveEnv: async () => ({}), systemDir: '/data/context/system' };
try {
  const request = { stateDir: join(fixture, 'state'), mutable: true, allowChanges: true, onLine: line => console.log(line) };
  const first = await runner.prepare(manifest.id, manifest, appDir, request);
  console.log('FIRST_RESULT', JSON.stringify(first));
  const second = await runner.prepare(manifest.id, manifest, appDir, request);
  if (!second.cached) throw new Error('Second preparation did not reuse verification');
  console.log('SECOND_RESULT', JSON.stringify(second));
  if (process.env.AURA_PREPARATION_SMOKE_START === '1') {
    const id = 'preparation-smoke-' + mode;
    const instanceDataDir = join(fixture, 'runtime');
    mkdirSync(instanceDataDir, { recursive: true });
    try {
      await runner.spawn(id, manifest.id, 4997, manifest, { appDir, instanceDataDir });
      const host = runner.getHost(id);
      const response = await fetch(`http://${host}:4997/`, { signal: AbortSignal.timeout(15000) });
      const html = await response.text();
      if (!response.ok || !html.includes('<html')) throw new Error(`Page smoke failed: ${response.status} ${html.slice(0, 500)}`);
      console.log('PAGE_RESULT', response.status, html.length);
    } finally { await runner.kill(id); runner.clearToolsDir(id); runner.clearMountRoot?.(id); }
  }
} finally {
  // Keep the copied source and diagnostic log on failure for investigation.
  runner.clearToolsDir('prepare-state');
}
