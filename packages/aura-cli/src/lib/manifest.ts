import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';

export interface ManifestLite {
  id: string;
  name?: string;
  tools?: string[];
  [key: string]: unknown;
}

function manifestPath(appId: string): string {
  return join(APPS_DIR, appId, 'app.manifest.json');
}

export function readManifest(appId: string): ManifestLite | null {
  const p = manifestPath(appId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')) as ManifestLite; }
  catch { return null; }
}

export function writeManifest(appId: string, manifest: ManifestLite): void {
  writeFileSync(manifestPath(appId), JSON.stringify(manifest, null, 2) + '\n');
}

export function addToolToManifest(appId: string, tool: string): boolean {
  const m = readManifest(appId);
  if (!m) throw new Error(`Manifest not found for ${appId} (expected ${manifestPath(appId)})`);
  const tools = Array.isArray(m.tools) ? m.tools : [];
  if (tools.includes(tool)) return false;
  m.tools = [...tools, tool];
  writeManifest(appId, m);
  return true;
}

export function removeToolFromManifest(appId: string, tool: string): boolean {
  const m = readManifest(appId);
  if (!m) return false;
  const tools = Array.isArray(m.tools) ? m.tools : [];
  if (!tools.includes(tool)) return false;
  m.tools = tools.filter((t) => t !== tool);
  writeManifest(appId, m);
  return true;
}

export function listAllManifests(): ManifestLite[] {
  if (!existsSync(APPS_DIR)) return [];
  const result: ManifestLite[] = [];
  for (const entry of readdirSync(APPS_DIR)) {
    const m = readManifest(entry);
    if (m) result.push(m);
  }
  return result;
}
