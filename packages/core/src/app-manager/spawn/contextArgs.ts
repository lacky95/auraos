/**
 * OS Context reaching an app process: `/run/context`, the shared Context
 * Volumes and the context env (Phase 5 Stage 1 extraction; stream C owns this
 * file and narrows it to declared and granted keys, Q7).
 */
import { join } from 'node:path';
import type { VolumeEntry } from '../../context/VolumeStore.js';

/** `/run/context` (read-only) and every Context Volume, as app-data volume subpaths. */
export function containerContextMounts(o: { appDataVolume: string; volumes: VolumeEntry[] }): string[] {
  return [
    // OS Context (env vars / secrets). The master writes decrypted values to
    // /data/context/system/<KEY> (its view of the app-data volume); mounting
    // the same volume subpath here at /run/context read-only mirrors those
    // files live — a `set` reaches a RUNNING app on its next read, no respawn.
    '--mount', `type=volume,source=${o.appDataVolume},target=/run/context,volume-subpath=context/system,readonly`,
    // OS-managed shared Context Volumes. Each is a subpath of the app-data
    // volume mounted at the user-chosen path — same mechanism as /run/context,
    // so every app sees the same shared storage. `ensureAll()` (spawn) has
    // created each subpath dir. RO volumes add ,readonly.
    ...o.volumes.flatMap((v) => [
      '--mount',
      `type=volume,source=${o.appDataVolume},target=${v.mountPath},volume-subpath=context/volumes/${v.name}${v.mode === 'ro' ? ',readonly' : ''}`,
    ]),
  ];
}

/**
 * The context env as `-e` pairs. Pushed BEFORE the fixed OS vars, so docker's
 * last-wins semantics keep a context key named e.g. APP_ID / PATH / HOME from
 * clobbering an OS-critical variable.
 */
export function containerContextEnv(contextEnv: Record<string, string>): string[] {
  return Object.entries(contextEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

/** PRoot binds: `/run/context` and each Context Volume (proot binds are RW regardless of mode). */
export function prootContextBinds(o: { systemDir: string; volumesDir: string; volumes: VolumeEntry[] }): string[] {
  return [
    // OS Context files. The master writes decrypted values here; binding the
    // dir at /run/context mirrors changes live (no respawn to pick up a file
    // edit — mirrors the ContainerRunner volume-subpath mount).
    `--bind=${o.systemDir}:/run/context`,
    // OS-managed shared Context Volumes — bind each volume's subpath dir at
    // the user-chosen mount path (proot binds are RW regardless of mode).
    ...o.volumes.map((v) => `--bind=${join(o.volumesDir, v.name)}:${v.mountPath}`),
  ];
}
