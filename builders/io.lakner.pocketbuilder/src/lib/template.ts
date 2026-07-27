/**
 * Project-template rendering.
 *
 * Walks a template directory, substitutes `{{PLACEHOLDER}}` tokens, and
 * returns the `files[]` payload that `POST /api/admin/scaffold` expects.
 *
 * The approach (and the user/global-scope package.json handling below) mirrors
 * `buildScaffoldPayload` in packages/aura-cli/src/commands/dev.ts. The CLI
 * ships as a bundled binary rather than a library, so the ~40 lines are
 * copied instead of imported.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PayloadFile {
  relPath: string;
  content: string;
  mode?:   number;
}

export interface TemplateInfo {
  id:          string;
  label:       string;
  description: string;
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id:          'pocketbase-react',
    label:       'PocketBase + React',
    description: 'PocketBase runs as a sibling container; the app serves the UI and proxies /pb/* to it.',
  },
];

/**
 * Locate the templates dir. `process.cwd()` is the app root inside the
 * sandbox (ContainerRunner sets `--workdir /workspace/apps/<id>`), which is
 * the normal case; the import.meta.url walk is the fallback for running the
 * app standalone outside the OS.
 */
function templatesRoot(): string {
  const candidates = [
    join(process.cwd(), 'templates'),
    join(dirname(fileURLToPath(import.meta.url)), '../../templates'),
  ];
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error(`Template directory not found. Looked in: ${candidates.join(', ')}`);
  return hit;
}

/** Version of @aura/app-sdk to pin generated projects to. */
function sdkVersion(): string {
  for (const p of ['/workspace/node_modules/@aura/app-sdk/package.json', join(process.cwd(), 'node_modules/@aura/app-sdk/package.json')]) {
    try { return (JSON.parse(readFileSync(p, 'utf-8')) as { version?: string }).version ?? '0.0.1'; }
    catch { /* try next */ }
  }
  return '0.0.1';
}

export interface RenderVars {
  APP_ID:   string;
  APP_NAME: string;
  [key: string]: string;
}

/**
 * Render `templates/<templateId>/**` into a scaffold payload.
 *
 * The generated project is USER-scope, so — exactly as `aura dev new` does for
 * non-system scopes — `@aura/app-sdk` goes into `auraDependencies` (which
 * npm/pnpm ignore and `aura sdk install` reads from the sandbox's synthesised
 * entrypoint) rather than `dependencies`, and an `.npmrc` documents the local
 * OCI registry.
 */
export function renderTemplate(templateId: string, vars: RenderVars): PayloadFile[] {
  if (!TEMPLATES.some((t) => t.id === templateId)) {
    throw new Error(`Unknown template '${templateId}'.`);
  }
  const root = join(templatesRoot(), templateId);
  if (!existsSync(root)) throw new Error(`Template '${templateId}' is missing from disk (${root}).`);

  const files: PayloadFile[] = [];
  const walk = (dir: string, relPrefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const src = join(dir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      if (statSync(src).isDirectory()) { walk(src, rel); continue; }
      let body = readFileSync(src, 'utf-8');
      for (const [k, v] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, v);
      files.push({ relPath: rel, content: body, ...(entry.endsWith('.sh') ? { mode: 0o755 } : {}) });
    }
  };
  walk(root, '');

  const pkgIdx = files.findIndex((f) => f.relPath === 'package.json');
  if (pkgIdx < 0) throw new Error(`Template '${templateId}' has no package.json.`);
  const pkg = JSON.parse(files[pkgIdx]!.content) as Record<string, unknown>;
  pkg['auraDependencies'] = { '@aura/app-sdk': `^${sdkVersion()}` };
  files[pkgIdx] = { ...files[pkgIdx]!, content: JSON.stringify(pkg, null, 2) + '\n' };

  files.push({
    relPath: '.npmrc',
    content:
      '# AuraOS user-scope apps: @aura/* packages live in `auraDependencies`,\n' +
      '# not `dependencies` (npm/pnpm ignore it; `aura sdk install` reads it).\n' +
      '# The registry below is documentation; resolution happens via OCI.\n' +
      '@aura:registry=http://aura-com.aura.registry:4090/\n',
  });

  return files;
}

/** Reverse-domain app id validator — the same regex scaffold.ts enforces
 *  server-side (packages/shell/src/pages/api/admin/scaffold.ts). */
export const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

/**
 * Namespace every project under the builder's own id:
 * `io.lakner.pocketbuilder.<slug>`.
 *
 * Two reasons. It makes a project's origin readable straight off the app id —
 * useful once several builders coexist, each minting apps into the same scope.
 * And it means the id itself is a discovery key: `GET /api/apps` filtered by
 * this prefix reconstructs the project list even if the KV record is lost.
 *
 * The OS is fine with the extra segment — the manifest id regex allows any
 * number of dot-separated parts, and the derived container name
 * (`aura-io.lakner.pocketbuilder.demo1`) stays well inside docker's limits.
 */
export const PROJECT_ID_PREFIX = 'io.lakner.pocketbuilder';

/** Derive `io.lakner.pocketbuilder.<slug>` from a display name. */
export function deriveProjectId(displayName: string, prefix = PROJECT_ID_PREFIX): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^[^a-z]+/, '');
  return `${prefix}.${slug}`;
}
