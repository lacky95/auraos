/**
 * Manifest validator. Runs the existing Zod schema on the staged manifest
 * before anything touches `apps/`. Single throwing entry point so callers
 * (Installer, Resolver's preview path) get one shape of error.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppManifestSchema, type AppManifest } from '../types/manifest.js';

export class NexusValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`manifest validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'NexusValidationError';
  }
}

/** Parse + validate a manifest from a directory containing app.manifest.json. */
export function validateStagedDir(stagingDir: string): AppManifest {
  const manifestPath = join(stagingDir, 'app.manifest.json');
  if (!existsSync(manifestPath)) {
    throw new NexusValidationError([
      `no app.manifest.json found at ${manifestPath}`,
    ]);
  }
  const text = readFileSync(manifestPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new NexusValidationError([
      `app.manifest.json is not valid JSON: ${(err as Error).message}`,
    ]);
  }
  const result = AppManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.') || '<root>'}: ${i.message}`,
    );
    throw new NexusValidationError(issues);
  }
  return result.data;
}
