/**
 * OS Context reaching an app process: the shared Context Volumes and the
 * context env (Phase 5 Stage 1 extraction; stream C owns this file).
 *
 * No `/run/context` mount (stream C, Q7): an app's Context keys are exactly
 * what the kernel resolved for this start (`ctx.contextEnv`, declared AND
 * granted, context/grantedContext.ts). The runners only turn them into argv.
 */
import { join } from 'node:path';
import type { VolumeEntry } from '../../context/VolumeStore.js';

/** Every Context Volume, as app-data volume subpaths. */
export function containerContextMounts(o: { appDataVolume: string; volumes: VolumeEntry[] }): string[] {
  // OS-managed shared Context Volumes. Each is a subpath of the app-data
  // volume mounted at the user-chosen path, so every app sees the same shared
  // storage. `ensureAll()` (spawn) has created each subpath dir. RO volumes
  // add ,readonly.
  return o.volumes.flatMap((v) => [
    '--mount',
    `type=volume,source=${o.appDataVolume},target=${v.mountPath},volume-subpath=context/volumes/${v.name}${v.mode === 'ro' ? ',readonly' : ''}`,
  ]);
}

/**
 * The granted context env as `-e` pairs. Pushed BEFORE the fixed OS vars, so
 * docker's last-wins semantics keep a context key named e.g. APP_ID / PATH /
 * HOME from clobbering an OS-critical variable.
 */
export function containerContextEnv(contextEnv: Record<string, string> | undefined): string[] {
  return Object.entries(contextEnv ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/**
 * PRoot binds of the Context Volumes (proot binds are RW regardless of mode).
 * No `/run/context` (Phase 5 R2 Q18b, stream C): the context env an app gets
 * is what the kernel granted for the start (`ctx.contextEnv`).
 */
export function prootContextBinds(o: { volumesDir: string; volumes: VolumeEntry[] }): string[] {
  // OS-managed shared Context Volumes: each volume's subpath dir at the
  // user-chosen mount path.
  return o.volumes.map((v) => `--bind=${join(o.volumesDir, v.name)}:${v.mountPath}`);
}
