/**
 * The capability registry overlay (Phase 6 stream O): `/data/aura/overlay/capabilities.yaml`
 * (release/paths.ts `overlayCapabilities`).
 *
 * The release's `.aura/capabilities.yaml` is read-only (part of the release, same trust as the
 * code). The capabilities the owner adds keep their authority where SF-2 put them: the sealed,
 * digest-bound record (CapabilityRegistryStore; written only by `/api/admin/cap-registry`, at
 * `fresh`). This file is the EFFECTIVE view the shell generates from both (release entries win,
 * an owner entry never shadows one; the release's `services:` as they are), so that nothing
 * writes the release tree and a sandbox's `aura cap …` sees what the master sees. Containers get
 * it read-only at `/workspace/.aura/capabilities.yaml` (`capabilityRegistryMount`, mounted by
 * stream L's system-tree mount helper).
 *
 * JSON is YAML: the file is written as JSON so it needs no YAML writer, and every reader of the
 * release file (`yaml` parse) reads it unchanged. It is rewritten IN PLACE (same inode), so a
 * single-file bind into a running container sees the new content.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { layout, subpathOf } from '../release/paths.js';
import type { CapabilityDefinition } from './definition.js';

/** Where the effective registry appears inside an app container (the path the CLI reads by default). */
export const CAPABILITY_REGISTRY_TARGET = '/workspace/.aura/capabilities.yaml';

export interface CapabilityRegistryMount {
  /** Absolute path in the master (`/data/aura/overlay/capabilities.yaml`). */
  path: string;
  /** The same as a subpath of the data volume, for `--mount …,volume-subpath=…,readonly`. */
  subpath: string;
  /** Where containers see it (read-only). */
  target: string;
}

/**
 * The effective capability registry as a read-only container mount (for stream L: it replaces
 * the `${workspaceRoot}/.aura` bind in ContainerRunner). Present once the shell has booted
 * (bootHooks `capability-overlay`, before any app starts).
 */
export function capabilityRegistryMount(dataRoot: string): CapabilityRegistryMount {
  const path = layout(dataRoot).overlayCapabilities;
  return { path, subpath: subpathOf(dataRoot, path), target: CAPABILITY_REGISTRY_TARGET };
}

/** The effective registry document: the release file's sections, plus the owner's capabilities it does not define. */
export function effectiveCapabilityRegistry(
  releaseDoc: unknown, owner: Record<string, CapabilityDefinition>,
): { capabilities: Record<string, unknown>; services: Record<string, unknown> } {
  const doc = (releaseDoc && typeof releaseDoc === 'object' ? releaseDoc : {}) as Record<string, unknown>;
  const section = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {});
  const capabilities = section(doc['capabilities']);
  for (const [name, def] of Object.entries(owner).sort(([a], [b]) => a.localeCompare(b))) {
    if (!(name in capabilities)) capabilities[name] = def;
  }
  return { capabilities, services: section(doc['services']) };
}

/** Write the effective registry (in place; unchanged content is not rewritten). Returns whether it changed. */
export function writeCapabilityRegistryOverlay(
  dataRoot: string, releaseDoc: unknown, owner: Record<string, CapabilityDefinition>,
): boolean {
  const { path } = capabilityRegistryMount(dataRoot);
  const text = `${JSON.stringify(effectiveCapabilityRegistry(releaseDoc, owner), null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf-8') === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  // Complete beside it first, then copied over the target: the target keeps its inode (a running
  // container's bind follows), and a failed write never leaves it half-written.
  const tmp = `${path}.aura-new-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  try { copyFileSync(tmp, path); } finally { rmSync(tmp, { force: true }); }
  return true;
}
