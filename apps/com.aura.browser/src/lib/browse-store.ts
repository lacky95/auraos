// Browser history and bookmarks as JSON files under the instance's /data
// dir — the only persisted directory. Server-side so every window and every
// device sees the same bookmarks. Writes go through one in-process queue and
// land atomically (tmp + rename).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAppContext } from '@aura/app-sdk';

export interface HistoryEntry { url: string; title: string; visitCount: number; lastVisit: number }
export interface Bookmark { id: string; title: string; url: string }

const HISTORY_CAP = 2000;

function dir() { return path.join(getAppContext().dataDir, 'browse'); }

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(path.join(dir(), name), 'utf8')) as T; }
  catch { return fallback; }
}

async function writeJson(name: string, data: unknown) {
  await fs.mkdir(dir(), { recursive: true });
  const file = path.join(dir(), name);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

// ---- history -------------------------------------------------------------

export const getHistory = () => readJson<HistoryEntry[]>('history.json', []);

// A visit to the URL already on top (reload, title update) refreshes its
// title without counting another visit.
export function recordVisit(url: string, title: string) {
  return serial(async () => {
    const list = await getHistory();
    const now = Date.now();
    if (list[0]?.url === url) {
      if (title && title !== list[0].title) list[0].title = title;
      else return;
    } else {
      const i = list.findIndex((e) => e.url === url);
      if (i >= 0) {
        const [e] = list.splice(i, 1);
        list.unshift({ ...e, title: title || e.title, visitCount: e.visitCount + 1, lastVisit: now });
      } else {
        list.unshift({ url, title, visitCount: 1, lastVisit: now });
      }
    }
    await writeJson('history.json', list.slice(0, HISTORY_CAP));
  });
}

export function deleteHistory(url?: string) {
  return serial(async () => {
    const list = url ? (await getHistory()).filter((e) => e.url !== url) : [];
    await writeJson('history.json', list);
  });
}

// ---- bookmarks -----------------------------------------------------------

export const getBookmarks = () => readJson<Bookmark[]>('bookmarks.json', []);

export function addBookmark(url: string, title: string) {
  return serial(async () => {
    const list = await getBookmarks();
    const existing = list.find((b) => b.url === url);
    if (existing) return existing;
    const b = { id: randomUUID(), url, title: title || url };
    list.push(b);
    await writeJson('bookmarks.json', list);
    return b;
  });
}

export function renameBookmark(id: string, title: string) {
  return serial(async () => {
    const list = await getBookmarks();
    const b = list.find((x) => x.id === id);
    if (b) {
      b.title = title;
      await writeJson('bookmarks.json', list);
    }
    return list;
  });
}

export function deleteBookmark(id: string) {
  return serial(async () => {
    const list = (await getBookmarks()).filter((b) => b.id !== id);
    await writeJson('bookmarks.json', list);
  });
}
