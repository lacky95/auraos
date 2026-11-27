/**
 * The container module's `diagnostics` group (5b-2 D-R, D-C): what the
 * dataDir report and `aura cap doctor` ask of a running workload or of a
 * fresh sandbox, moved here from `contract/dataDirReport.ts` and the
 * `cap-doctor` route unchanged. Instance ids in, plain data out: the
 * container name, `docker diff`, `docker inspect` and the probe container
 * stay in this module.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { RuntimeDiagnostics } from '../ari.js';
import { containerName } from './names.js';

const execFileAsync = promisify(execFile);

export interface ContainerDiagnosticsOpts {
  /** The image every app container runs (BaseImage `BASE_IMAGE`). */
  baseImage: string;
  /** The named volume holding `/data` (the toolchain store is under `aura/toolchain/` in it). */
  appDataVolume: () => string;
}

function imageExists(image: string): boolean {
  try { execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { stdio: 'ignore', timeout: 15_000 }); return true; }
  catch { return false; }
}

export function containerDiagnostics(opts: ContainerDiagnosticsOpts): RuntimeDiagnostics {
  const docker = async (args: string[]): Promise<string | null> => {
    try { return (await execFileAsync('docker', args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return null; }
  };
  return {
    async inspectWrites(instanceId) {
      const s = await docker(['diff', containerName(instanceId)]);
      return s === null ? null : s.split('\n').filter(Boolean);
    },
    async workloadMounts(instanceId) {
      const s = await docker(['inspect', '-f', '{{json .Mounts}}', containerName(instanceId)]);
      if (s === null) return null;
      try {
        const mounts = JSON.parse(s) as Array<{ Destination?: string; RW?: boolean }>;
        return mounts.map((m) => ({ destination: String(m.Destination ?? ''), rw: m.RW === true }));
      } catch { return null; }
    },
    // The store by volume subpath (the shell's bin/lib dirs are the same files): docker refuses a subpath that
    // doesn't exist yet, so the caller creates the lib dir first. Without the base image the probe can't run.
    probeTools({ script }) {
      if (!imageExists(opts.baseImage)) {
        return { skipped: `the ${opts.baseImage} image is missing — see GET /api/admin/first-boot, or run \`docker compose build aura-base\` on the host`, missing: opts.baseImage };
      }
      const volume = opts.appDataVolume();
      return {
        stdout: execFileSync('docker', [
          'run', '--rm',
          '--mount', `type=volume,source=${volume},target=/probe/bin,volume-subpath=aura/toolchain/bin,readonly`,
          '--mount', `type=volume,source=${volume},target=/probe/lib,volume-subpath=aura/toolchain/lib,readonly`,
          '-e', 'LD_LIBRARY_PATH=/probe/lib',
          opts.baseImage, 'sh', '-c', script,
        ], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(),
      };
    },
  };
}
