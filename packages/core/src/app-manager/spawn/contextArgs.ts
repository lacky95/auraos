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

/**
 * PRoot binds of the Context Volumes (proot binds are RW regardless of mode).
 * No `/run/context` (Phase 5 R2, Q18b): no PRoot app reads it (F23), and the
 * context env a PRoot app gets is only its declared keys (`declaredContextEnv`).
 */
export function prootContextBinds(o: { volumesDir: string; volumes: VolumeEntry[] }): string[] {
  // OS-managed shared Context Volumes: each volume's subpath dir at the
  // user-chosen mount path.
  return o.volumes.map((v) => `--bind=${join(o.volumesDir, v.name)}:${v.mountPath}`);
}

/**
 * The context env narrowed to the keys the manifest declares (`context[]`,
 * D48): what the app reads anyway. Stream C narrows it further to granted keys.
 */
export function declaredContextEnv(contextEnv: Record<string, string>, declared: readonly string[] | undefined): Record<string, string> {
  const keys = new Set(declared ?? []);
  return Object.fromEntries(Object.entries(contextEnv).filter(([k]) => keys.has(k)));
}
