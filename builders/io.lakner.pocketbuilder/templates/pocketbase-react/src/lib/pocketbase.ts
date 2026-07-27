/**
 * PocketBase sibling-container control for this project.
 *
 * The manifest's `services[]` block declares the PocketBase image; the SDK's
 * SidecarHost does the actual `docker run` / teardown / naming / labelling.
 * We use only its container-management half (`ensureAll` / `teardownAll` /
 * `isRunning`) — NOT `listen()`, because Astro already owns $APP_PORT here.
 *
 * Imported from the `@aura/app-sdk/sidecars` subpath on purpose: the SDK
 * barrel deliberately does not re-export it, since sidecars.ts pulls in
 * node:child_process and would poison any browser bundle.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSidecars, type SidecarHost, type ServiceSpec } from '@aura/app-sdk/sidecars';

const APP_ID      = process.env['APP_ID'] ?? 'unknown';
const INSTANCE_ID = process.env['APP_INSTANCE_ID'] ?? APP_ID;
const APP_PORT    = Number(process.env['APP_PORT'] ?? 4001);

export const PB_SERVICE = 'pocketbase';
export const PB_PORT    = 8090;

/** Read `services[]` straight off our own manifest on disk. */
function services(): ServiceSpec[] {
  try {
    const raw = readFileSync(join(process.cwd(), 'app.manifest.json'), 'utf-8');
    return (JSON.parse(raw) as { services?: ServiceSpec[] }).services ?? [];
  } catch (err) {
    console.error(`[${APP_ID}] could not read app.manifest.json:`, err);
    return [];
  }
}

let host: SidecarHost | null = null;

export function sidecars(): SidecarHost {
  host ??= createSidecars({
    appId:      APP_ID,
    instanceId: INSTANCE_ID,
    appPort:    APP_PORT,
    services:   services(),
  });
  return host;
}

/** Hostname the PocketBase sibling is reachable at on `aura-net`. */
export function pbHost(): string {
  return sidecars().containerName(PB_SERVICE);
}

export function pbBase(): string {
  return `http://${pbHost()}:${PB_PORT}`;
}

export interface PbStatus {
  phase:   string;
  detail:  string;
  running: boolean;
  healthy: boolean;
  host:    string;
}

export async function pbStatus(): Promise<PbStatus> {
  const h = sidecars();
  const running = await h.isRunning(PB_SERVICE).catch(() => false);
  let healthy = false;
  if (running) {
    try {
      const res = await fetch(`${pbBase()}/api/health`, { signal: AbortSignal.timeout(3_000) });
      healthy = res.ok;
    } catch { healthy = false; }
  }
  return { phase: h.phase, detail: h.detail, running, healthy, host: pbHost() };
}
