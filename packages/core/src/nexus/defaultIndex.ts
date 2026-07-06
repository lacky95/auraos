/**
 * Bundled fallback for the curated Nexus index.
 *
 * The live index lives in a separate repo (`aura-os/nexus-index`, see
 * IndexClient.DEFAULT_INDEX_URL) that doesn't exist yet, so every remote
 * refresh currently fails. Rather than degrade to a schema-only *empty*
 * document — which leaves the Nexus GUI's discover/search with a blank,
 * category-less shell — IndexClient falls back to this seed. It carries the
 * store's category taxonomy so the UI renders a valid, populated scaffold
 * offline; `apps`/`featured` stay empty until the remote index (or apps
 * published to the local zot) provide real, installable entries.
 *
 * TypeScript constant rather than a bundled YAML/JSON asset on purpose:
 * `@aura/core` builds with plain `tsc`, which does NOT copy non-.ts files
 * into `dist/`, so an asset would vanish at runtime.
 *
 * Categories mirror the top-level `category` values used across the app
 * manifests (`system`, `developer`, `productivity`, `utility`) plus a couple
 * of conventional store buckets for future entries.
 */
import type { IndexDocument } from './types.js';

export const DEFAULT_INDEX: IndexDocument = {
  schema: 1,
  apps: [],
  featured: [],
  categories: [
    { slug: 'system',       label: 'System',       description: 'Core OS services and infrastructure.' },
    { slug: 'developer',    label: 'Developer',    description: 'Tools for building and debugging.' },
    { slug: 'productivity', label: 'Productivity', description: 'Get things done.' },
    { slug: 'utility',      label: 'Utilities',    description: 'Small, single-purpose helpers.' },
    { slug: 'media',        label: 'Media',        description: 'Audio, video, and images.' },
  ],
};

/** Deep clone of the seed — callers get a fresh, mutation-safe copy. */
export function seedIndex(): IndexDocument {
  return JSON.parse(JSON.stringify(DEFAULT_INDEX)) as IndexDocument;
}
