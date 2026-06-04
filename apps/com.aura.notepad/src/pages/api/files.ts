/**
 * File API for the save/open dialog.
 * All paths are relative to /data/files/ and must not contain '..'.
 *
 * GET  ?dir=<relpath>   → { entries: [{ name, isDir }] }
 * GET  ?file=<relpath>  → { content: string }
 * POST { op, path, ... }:
 *   op 'write'  (default) { path, content } → write/create file
 *   op 'mkdir'            { path }           → create folder
 *   op 'delete'           { path }           → delete file or folder (recursive)
 *   op 'rename'           { path, newPath }  → rename / move
 */
import type { APIRoute } from 'astro';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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
  const body = await request.json().catch(() => null) as {
    op?: string; path?: string; content?: string; newPath?: string;
  } | null;
  if (!body?.path) return new Response('missing path', { status: 400 });

  const abs = safePath(body.path);
  if (!abs) return new Response('invalid path', { status: 400 });

  const op = body.op ?? 'write';
  try {
    switch (op) {
      case 'write': {
        if (typeof body.content !== 'string') return new Response('missing content', { status: 400 });
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body.content, 'utf-8');
        return new Response(null, { status: 201 });
      }
      case 'mkdir': {
        if (existsSync(abs)) return new Response('already exists', { status: 409 });
        mkdirSync(abs, { recursive: true });
        return new Response(null, { status: 201 });
      }
      case 'delete': {
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        return new Response(null, { status: 200 });
      }
      case 'rename': {
        const dst = safePath(body.newPath ?? '');
        if (!dst) return new Response('invalid newPath', { status: 400 });
        if (!existsSync(abs)) return new Response('not found', { status: 404 });
        if (existsSync(dst)) return new Response('target exists', { status: 409 });
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(abs, dst);
        return new Response(null, { status: 200 });
      }
      default:
        return new Response('unknown op', { status: 400 });
    }
  } catch (err) {
    return new Response(`${op} error: ${(err as Error).message}`, { status: 500 });
  }
};
