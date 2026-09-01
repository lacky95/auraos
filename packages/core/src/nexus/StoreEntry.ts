/**
 * Turn an app manifest into a curated-store index entry.
 *
 * The store's entry schema and AuraOS's manifest schema were written for
 * different jobs and do not agree at the edges. A manifest may be perfectly
 * valid and still describe something the store rejects: `category: 'game'` has
 * no store slug, a 240-character description exceeds the store's 200, `tags`
 * may hold 16 free-form strings where the store wants at most 10 slugs, and
 * `z.string().url()` happily accepts `http://` where the store demands https.
 *
 * That mismatch is the whole reason this module exists as a separate, pure
 * unit: it is the only place the two schemas meet, it has no fs/network/git so
 * it is trivially testable, and a future store UI or a `nexus lint` command
 * needs exactly the same answers the CLI does.
 *
 * Design rule throughout: **collect every problem, never short-circuit.** An
 * author fixing one field at a time across four round-trips through a publish
 * is the failure mode this avoids.
 *
 * Second rule: **transform only where the transform is unambiguous.** Slugging
 * `My Tag` to `my-tag` is obvious and reversible in the reader's head, so it is
 * a warning. Truncating a description, or silently relabelling someone's
 * `game` as `utility`, changes what the author said about their own app — those
 * are errors with an explicit escape hatch instead.
 */

import { stringify } from 'yaml';
import type { AppManifest } from '../types/manifest.js';

/** The store's category taxonomy — mirrors defaultIndex.ts and the store's
 *  schema enum. Deliberately smaller than the manifest's. */
export const STORE_CATEGORIES = [
  'system', 'developer', 'productivity', 'utility', 'media',
] as const;
export type StoreCategory = typeof STORE_CATEGORIES[number];

/** Manifest categories with no store equivalent. Listed explicitly so the
 *  error message can name them, and so adding a store slug later is a
 *  one-line change here rather than a hunt. */
const UNMAPPABLE_CATEGORIES = new Set(['communication', 'game']);

/** Store schema limits. Kept as named constants because the error messages
 *  quote them and drift between message and check is its own bug class. */
const MAX_DESCRIPTION = 200;
const MAX_TAGS        = 10;
const MAX_TAG_LEN     = 24;
const MAX_SCREENSHOTS = 8;

const ID_RE      = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const ICON_RE    = /^\S{1,3}$/;
const TAG_RE     = /^[a-z0-9][a-z0-9-]*$/;
const CHANNEL_RE = /^[a-z][a-z0-9-]*$/;
/** Schemeless `host/owner/repo`, matching the store schema's sources.git.ref. */
const GIT_REF_RE = /^[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/;

export interface StoreEntrySource {
  git?: { ref: string; 'default-branch'?: string };
  oci?: { ref: string };
}

export interface StoreEntry {
  id:           string;
  name:         string;
  description?: string;
  publisher?:   string;
  homepage?:    string;
  icon?:        string;
  categories?:  string[];
  tags?:        string[];
  screenshots?: string[];
  sources:      StoreEntrySource;
  channels:     Record<string, { 'git-tag'?: string; 'oci-tag'?: string }>;
}

export interface EntryProblem {
  field:    string;
  severity: 'error' | 'warn';
  message:  string;
}

export interface StoreEntryCtx {
  source:
    | { kind: 'git'; ref: string; defaultBranch?: string }
    | { kind: 'oci'; ref: string };
  /** Channel label the publish pushed, e.g. 'stable'. */
  channel: string;
  /** The tag that was pushed. */
  tag: string;
  /** Overrides an unmappable manifest category (the `--category` escape hatch). */
  categoryOverride?: string;
}

/**
 * Slug a free-form manifest tag into the store's `^[a-z0-9][a-z0-9-]*$`.
 * Returns null when nothing usable survives, so the caller can report it.
 */
export function slugifyTag(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LEN)
    // A trailing hyphen can reappear after the length cut.
    .replace(/-+$/, '');
  return s && TAG_RE.test(s) ? s : null;
}

/**
 * Normalise a git repo URL into the store's schemeless `host/owner/repo`.
 * Accepts what `Publisher.publishGit` produces as `repoUrl`, plus the SSH form
 * in case a manifest's `publish.repo` carried one.
 */
export function normaliseGitRefForStore(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:]+):/, '$1/')   // git@github.com:o/r → github.com/o/r
    .replace(/^[a-z]+:\/\//i, '')      // strip scheme
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/** True when an OCI ref points somewhere only this machine can reach. The
 *  store lists public sources; a local zot ref would produce an entry that
 *  resolves for nobody. */
function isUnreachableOciRef(ref: string): boolean {
  const host = ref.split('/')[0] ?? '';
  return (
    host.startsWith('localhost')
    || host.startsWith('127.')
    || host.startsWith('aura-com.aura.registry')
    || /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)
  );
}

/**
 * Build a store entry from a manifest plus the facts of the publish that just
 * happened. Never throws: everything wrong is reported in `problems`, and the
 * caller decides (any `severity: 'error'` means do not submit).
 */
export function buildStoreEntry(
  m: AppManifest,
  ctx: StoreEntryCtx,
): { entry: StoreEntry; problems: EntryProblem[] } {
  const problems: EntryProblem[] = [];
  const err  = (field: string, message: string) => problems.push({ field, severity: 'error', message });
  const warn = (field: string, message: string) => problems.push({ field, severity: 'warn',  message });

  // ── id ────────────────────────────────────────────────────────────────
  if (!ID_RE.test(m.id)) {
    err('id', `'${m.id}' is not reverse-domain notation (e.g. com.example.app)`);
  }

  // ── description: too long is an error, not a truncation ───────────────
  let description = m.description?.trim() || undefined;
  if (description && description.length > MAX_DESCRIPTION) {
    err('description',
      `is ${description.length} characters, store maximum is ${MAX_DESCRIPTION} — `
      + 'shorten `description` in app.manifest.json '
      + '(the long form belongs in store.longDescription, which the index does not carry)');
    description = undefined;
  }

  // ── icon: a glyph, never a URL ────────────────────────────────────────
  // The manifest allows min(1).max(3) with no non-whitespace assertion, so
  // "  " is a valid manifest the store rejects. Fall back the same way the
  // shell does when icon is omitted.
  // Test the RAW presence, not the trimmed truthiness: '  ' trims to '' which
  // is falsy, so a truthiness guard here would skip the warning and fall back
  // in silence — the precise case this is meant to catch.
  let icon: string | undefined;
  if (m.icon !== undefined) {
    const trimmed = m.icon.trim();
    if (ICON_RE.test(trimmed)) icon = trimmed;
    else {
      // An unusable icon is not worth failing a publish over — fall back the
      // way the shell does. But say so: silently swapping someone's glyph is
      // the kind of change they only notice on the storefront.
      warn('icon', `'${m.icon}' is not 1-3 non-whitespace characters — using the first letter of the name instead`);
    }
  }
  if (!icon) icon = (m.name?.trim().charAt(0) ?? '').toUpperCase();
  if (!ICON_RE.test(icon)) {
    err('icon', 'could not be derived from `name` — set an explicit 1-3 character `icon` in app.manifest.json');
  }

  // ── categories: singular → array, with two holes in the mapping ───────
  const rawCategory = ctx.categoryOverride ?? m.category;
  let categories: string[] | undefined;
  if (rawCategory) {
    if ((STORE_CATEGORIES as readonly string[]).includes(rawCategory)) {
      categories = [rawCategory];
    } else if (UNMAPPABLE_CATEGORIES.has(rawCategory)) {
      err('category',
        `'${rawCategory}' has no store equivalent — set \`category\` in app.manifest.json to one of `
        + `${STORE_CATEGORIES.join(', ')}, or pass --category to choose one for the listing`);
    } else {
      err('category', `'${rawCategory}' is not a store category (${STORE_CATEGORIES.join(', ')})`);
    }
  }

  // ── tags: slug, dedupe, cap ───────────────────────────────────────────
  const rawTags = m.store?.tags ?? [];
  const seen = new Set<string>();
  const changed: string[] = [];
  const dropped: string[] = [];
  for (const t of rawTags) {
    const s = slugifyTag(t);
    if (!s) { dropped.push(t); continue; }
    if (s !== t) changed.push(`'${t}' → '${s}'`);
    seen.add(s);
  }
  let tags = [...seen];
  if (tags.length > MAX_TAGS) {
    warn('tags', `${tags.length} tags, store maximum is ${MAX_TAGS} — keeping the first ${MAX_TAGS}`);
    tags = tags.slice(0, MAX_TAGS);
  }
  if (changed.length) warn('tags', `rewritten to store slug form: ${changed.join(', ')}`);
  if (dropped.length) warn('tags', `dropped (nothing usable after slugging): ${dropped.join(', ')}`);

  // ── homepage / screenshots: https only ────────────────────────────────
  // The manifest uses z.string().url(), which accepts http:// and ftp://.
  let homepage = m.store?.homepage?.trim() || undefined;
  if (homepage && !homepage.startsWith('https://')) {
    err('store.homepage', `'${homepage}' must be an absolute https:// URL`);
    homepage = undefined;
  }

  const screenshots: string[] = [];
  for (const url of m.store?.screenshots ?? []) {
    if (!url.startsWith('https://')) {
      err('store.screenshots', `'${url}' must be an absolute https:// URL (AuraOS hosts no images)`);
      continue;
    }
    screenshots.push(url);
  }
  if (screenshots.length > MAX_SCREENSHOTS) {
    err('store.screenshots', `${screenshots.length} screenshots, store maximum is ${MAX_SCREENSHOTS}`);
  }

  // Fields the manifest carries that the index has no room for. The entry
  // schema is additionalProperties:false, so these cannot simply ride along —
  // say so, or an author will assume their licence reached the storefront.
  if (m.store?.license) {
    warn('store.license', 'the store index has no licence field — it will not appear in the listing');
  }
  if (m.store?.longDescription) {
    warn('store.longDescription', 'the store index has no long-description field — only `description` is listed');
  }

  // ── sources + channels ────────────────────────────────────────────────
  const sources: StoreEntrySource = {};
  const channelKey = ctx.source.kind === 'git' ? 'git-tag' : 'oci-tag';

  if (ctx.source.kind === 'git') {
    const ref = normaliseGitRefForStore(ctx.source.ref);
    if (!GIT_REF_RE.test(ref)) {
      err('sources.git.ref', `'${ref}' must look like host/owner/repo (no scheme, no .git)`);
    }
    sources.git = { ref };
    if (ctx.source.defaultBranch) sources.git['default-branch'] = ctx.source.defaultBranch;
  } else {
    // Strip any tag: the entry names the repository, the channel names the tag.
    const ref = ctx.source.ref.replace(/:[^/:]+$/, '');
    if (isUnreachableOciRef(ref)) {
      err('sources.oci.ref',
        `'${ref}' is not publicly reachable — the store can only list sources anyone can pull. `
        + 'Publish to a public registry before submitting.');
    }
    sources.oci = { ref };
  }

  if (!CHANNEL_RE.test(ctx.channel)) {
    err('channels', `channel name '${ctx.channel}' must match ${CHANNEL_RE.source}`);
  }
  if (ctx.channel !== 'stable') {
    warn('channels',
      `publishing channel '${ctx.channel}', but a bare \`aura nexus app install <id>\` resolves `
      + "'stable' — the app will not be installable by id until a stable channel exists");
  }

  const entry: StoreEntry = {
    id:   m.id,
    name: m.name,
    ...(description ? { description } : {}),
    ...(m.store?.publisher ? { publisher: m.store.publisher } : {}),
    ...(homepage ? { homepage } : {}),
    ...(icon && ICON_RE.test(icon) ? { icon } : {}),
    ...(categories ? { categories } : {}),
    ...(tags.length ? { tags } : {}),
    ...(screenshots.length ? { screenshots } : {}),
    sources,
    channels: { [ctx.channel]: { [channelKey]: ctx.tag } },
  };

  return { entry, problems };
}

/** Key order matching the store's build-index.mjs KEY_ORDER, so a hand-written
 *  entry and the generated index read the same way. */
const KEY_ORDER: Array<keyof StoreEntry> = [
  'id', 'name', 'description', 'publisher', 'homepage', 'icon',
  'categories', 'tags', 'screenshots', 'sources', 'channels',
];

/** Render an entry as the YAML that goes into `apps/<id>.yaml`. */
export function renderEntryYaml(entry: StoreEntry): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (entry[k] !== undefined) ordered[k] = entry[k];
  // Preserve anything a hand-edit added that we do not model.
  const loose = entry as unknown as Record<string, unknown>;
  for (const k of Object.keys(loose)) if (!(k in ordered)) ordered[k] = loose[k];
  return stringify(ordered, { lineWidth: 0 });
}

/**
 * Merge a freshly built entry into one that already exists in the store.
 *
 * Default ('channel') patches ONLY the channel and the source — because a
 * maintainer may have curated the description or tags while reviewing the
 * original submission, and a version bump that silently reverted their edits
 * would be a hostile diff. 'full' opts into replacing the descriptive fields
 * too, and still preserves unknown keys.
 */
export function mergeEntry(
  existing: StoreEntry,
  next: StoreEntry,
  mode: 'channel' | 'full' = 'channel',
): StoreEntry {
  if (mode === 'full') {
    return { ...existing, ...next, channels: { ...existing.channels, ...next.channels } };
  }
  return {
    ...existing,
    sources:  { ...existing.sources, ...next.sources },
    channels: { ...existing.channels, ...next.channels },
  };
}
