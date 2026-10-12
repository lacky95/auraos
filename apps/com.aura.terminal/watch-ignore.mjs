/**
 * What Vite's file watcher must NOT see: files a shell writes into this app's
 * tree. The terminal runs as a Vite dev server, and every shell it hosts can
 * `cd` into the tree and run any program — editors, package managers, agent
 * CLIs — which drop dotfiles, dot-dirs of state, logs or a tmux socket dir there. A watcher event
 * on those reloaded (or restarted) the dev server under every live session.
 *
 * Ignored, relative to the app root: any path with a dot-segment (dotfiles and
 * dot-dirs: per-program state, editor swap files, caches, histories) except
 * `.astro` (Astro's own generated types) and `.env*` (Vite config the user
 * edits on purpose); `*.log`; `tmux-<uid>` socket dirs. Paths outside the root
 * are left to Vite's defaults.
 *
 * Plain JS on purpose: astro.config.mjs imports it before any TS tooling runs,
 * and the tests import it directly.
 *
 * @param {string} root absolute app root
 * @returns {(path: string) => boolean} chokidar `ignored` predicate
 */
export function shellWriteIgnore(root) {
  const base = root.replace(/\/+$/, '');
  return (path) => {
    let rel = String(path);
    if (rel.startsWith('/')) {
      if (rel === base) return false;
      if (!rel.startsWith(`${base}/`)) return false;
      rel = rel.slice(base.length + 1);
    }
    const segs = rel.split('/').filter(Boolean);
    if (segs.length === 0) return false;
    for (const s of segs) {
      if (s.startsWith('.') && s !== '.' && s !== '..' && s !== '.astro' && !s.startsWith('.env')) return true;
      if (/^tmux-\d+$/.test(s)) return true;
    }
    return segs[segs.length - 1].endsWith('.log');
  };
}
