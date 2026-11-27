/**
 * The one D94 implementation is the dependency-free `os/infra/*.mjs` (schema, store, render,
 * adapters, secrets: install.sh, os/boot.sh and the release builder run it before any core
 * exists). The kernel loads that same code instead of keeping a twin (D36): the source tree's
 * `os/infra/`, found next to this package (src and dist alike) or under the workspace.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any -- plain JS modules; the typed shapes are ./types.ts */
export interface OsInfra {
  config: any;
  store: any;
  render: any;
  secrets: any;
  adapters: any;
}

/** Where `os/infra` is: the tree this core was built from, else the workspace (`/workspace`). */
export function osInfraDir(): string | null {
  let here: string | null = null;
  try { here = fileURLToPath(new URL('../../../../os/infra', import.meta.url)); } catch { /* bundled without import.meta (the CLI) */ }
  const candidates = [
    here,
    join(process.env['AURA_WORKSPACE'] ?? '/workspace', 'os', 'infra'),
  ].filter((x): x is string => !!x);
  return candidates.find((d) => existsSync(join(d, 'config.mjs'))) ?? null;
}

let loaded: Promise<OsInfra> | null = null;

/** The os/infra modules (loaded once per module copy). Throws `infra-unavailable` when the tree has none. */
export function loadOsInfra(): Promise<OsInfra> {
  loaded ??= (async () => {
    const dir = osInfraDir();
    if (!dir) throw Object.assign(new Error('os/infra is not in this installation'), { code: 'infra-unavailable' });
    const imp = (f: string) => import(pathToFileURL(join(dir, f)).href);
    const [config, store, render, secrets, adapters] = await Promise.all(
      ['config.mjs', 'store.mjs', 'render.mjs', 'secrets.mjs', 'adapters/index.mjs'].map(imp),
    );
    return { config, store, render, secrets, adapters };
  })();
  loaded.catch(() => { loaded = null; });
  return loaded;
}
