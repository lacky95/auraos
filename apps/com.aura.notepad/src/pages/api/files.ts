/**
 * File API for the save/open dialog.
 * All paths are relative to /data/files/ and must not contain '..'.
 *
 * GET  ?dir=<relpath>   → { entries: [{ name, isDir }] }
 * GET  ?file=<relpath>  → { content: string }
 * POST { path, content } → 201 or 400
 */
import type { APIRoute } from 'astro';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { FILES_DIR } from '../../state.js';

function safePath(rel: string): string | null {
  if (!rel || rel.split('/').includes('..')) return null;
  const abs = join(FILES_DIR, normalize(rel));
  // Ensure the resolved path is still inside FILES_DIR
  if (!abs.startsWith(FILES_DIR)) return null;
  return abs;
}

export const GET: APIRoute = ({ url }) => {
  const dir  = url.searchParams.get('dir');
  const file = url.searchParams.get('file');

  if (dir !== null) {
    const abs = safePath(dir) ?? FILES_DIR;
    mkdirSync(abs, { recursive: true });
    try {
      const entries = readdirSync(abs).map((name) => {
        const isDir = statSync(join(abs, name)).isDirectory();
        return { name, isDir };
      }).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return new Response(JSON.stringify({ entries }), { headers: { 'Content-Type': 'application/json' } });
    } catch {
      return new Response(JSON.stringify({ entries: [] }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (file !== null) {
    const abs = safePath(file);
    if (!abs) return new Response('invalid path', { status: 400 });
    if (!existsSync(abs)) return new Response('not found', { status: 404 });
    try {
      const content = readFileSync(abs, 'utf-8');
      return new Response(JSON.stringify({ content }), { headers: { 'Content-Type': 'application/json' } });
    } catch {
      return new Response('read error', { status: 500 });
    }
  }

  return new Response('missing ?dir or ?file param', { status: 400 });
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as { path?: string; content?: string } | null;
  if (!body?.path || typeof body.content !== 'string') {
    return new Response('missing path or content', { status: 400 });
  }
  const abs = safePath(body.path);
  if (!abs) return new Response('invalid path', { status: 400 });
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body.content, 'utf-8');
    return new Response(null, { status: 201 });
  } catch {
    return new Response('write error', { status: 500 });
  }
};
