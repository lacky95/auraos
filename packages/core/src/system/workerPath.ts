import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * The path of one of core's own worker scripts (run as `node <path>`, e.g. as
 * another uid). Next to the calling module when core runs from its `dist`.
 * When another build bundled core (the shell under Astro/Vite: pre-bundled in
 * dev, chunked in the production build), `import.meta.url` points into that
 * bundle and the script is not there; it is then found through core's
 * declared export (`@aura/core/workers/<name>`, package.json). A leaf: Node
 * built-ins only.
 */
export function coreWorkerPath(callerUrl: string, file: string, exportName: string): string {
  const local = fileURLToPath(new URL(file, callerUrl));
  if (existsSync(local)) return local;
  return createRequire(callerUrl).resolve(`@aura/core/workers/${exportName}`);
}
