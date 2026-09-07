/**
 * Path guard for the saved-notes tree. Everything user- or agent-supplied
 * goes through here before it touches the filesystem, so a `..` or an
 * absolute path outside the root can never escape `FILES_DIR`.
 */
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { FILES_DIR } from './state.js';

/** True when `abs` is the notes root or somewhere inside it. */
function insideRoot(abs: string): boolean {
  return abs === FILES_DIR || abs.startsWith(FILES_DIR + '/');
}

/**
 * Resolve a path RELATIVE to the notes root, or null when it is empty,
 * contains `..`, or would resolve outside the root.
 */
export function safePath(rel: string): string | null {
  if (!rel || rel.split('/').includes('..')) return null;
  const abs = join(FILES_DIR, normalize(rel));
  return insideRoot(abs) ? abs : null;
}

/**
 * Same as `safePath`, but also accepts an absolute path as long as it is
 * inside the root — the filesystem MCP tools return absolute paths, and an
 * agent will naturally hand those straight back.
 */
export function notePath(input: string): string | null {
  if (!input) return null;
  if (isAbsolute(input)) {
    const abs = resolve(input);
    return insideRoot(abs) ? abs : null;
  }
  return safePath(input);
}

/** `/data/files/a/b.txt` → `a/b.txt`. Paths outside the root come back unchanged. */
export function relPath(abs: string): string {
  return abs.startsWith(FILES_DIR + '/') ? abs.slice(FILES_DIR.length + 1) : abs;
}
