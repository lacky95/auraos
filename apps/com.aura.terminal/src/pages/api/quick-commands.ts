import type { APIRoute } from 'astro';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Quick commands, stored on the terminal app's BACKEND.
 *
 * The panel keeps two lists side by side: these, and a browser-local list in
 * localStorage. Local entries belong to one browser profile and vanish with
 * its site data; these are written to the user's home, which the OS backs
 * with the app-data volume — so they follow the user across every terminal
 * instance, every browser, and every rebuild of the OS.
 *
 * `$HOME` is the shared user home (`/home/aura`, see packages/core/src/
 * scopes/home.ts), NOT the per-instance `/data`: two terminal windows are two
 * instances with two data dirs, and a command saved in one has to show up in
 * the other. AURA_DATA_DIR is only a fallback for a stray environment with no
 * home mounted, where per-instance storage still beats losing the list.
 *
 * Writes replace the whole list (the client owns ordering) and are atomic —
 * tmp file + rename — so a crash mid-write can't leave a truncated JSON that
 * would read back as "no commands" on the next boot. Last writer wins if two
 * windows save at the same moment; the alternative (merge/CRDT) is far more
 * machinery than a handful of shortcuts warrants.
 */

interface QuickCommand { command: string; name?: string }

const MAX_ENTRIES     = 200;
const MAX_COMMAND_LEN = 2000;
const MAX_NAME_LEN    = 80;

function storeFile(): string {
  const home = process.env['HOME'];
  if (home && home.trim()) return join(home, '.config', 'aura-terminal', 'quick-commands.json');
  return join(process.env['AURA_DATA_DIR'] ?? '/data', 'quick-commands.json');
}

function load(): QuickCommand[] {
  const file = storeFile();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { commands?: unknown };
    return sanitize(raw?.commands);
  } catch (err) {
    // A corrupt file must not take the panel down — surface it and start empty.
    console.warn(`[quick-commands] unreadable ${file}: ${(err as Error).message}`);
    return [];
  }
}

function save(commands: QuickCommand[]): void {
  const file = storeFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ commands }, null, 2), 'utf-8');
  renameSync(tmp, file);
}

/** Keep only well-formed entries — the file is user-editable by design. */
function sanitize(value: unknown): QuickCommand[] {
  if (!Array.isArray(value)) return [];
  const out: QuickCommand[] = [];
  for (const item of value.slice(0, MAX_ENTRIES)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const command = typeof rec['command'] === 'string' ? rec['command'].slice(0, MAX_COMMAND_LEN) : '';
    if (!command.trim()) continue;
    const name = typeof rec['name'] === 'string' ? rec['name'].trim().slice(0, MAX_NAME_LEN) : '';
    out.push(name ? { command, name } : { command });
  }
  return out;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = () => json({ commands: load(), file: storeFile() });

export const PUT: APIRoute = async ({ request }) => {
  let body: { commands?: unknown };
  try { body = await request.json() as { commands?: unknown }; }
  catch { return json({ error: 'invalid-json' }, 400); }
  if (!Array.isArray(body?.commands)) {
    return json({ error: 'invalid-commands', message: 'Body must be { commands: [...] }.' }, 400);
  }
  const commands = sanitize(body.commands);
  try { save(commands); }
  catch (err) { return json({ error: 'write-failed', message: (err as Error).message }, 500); }
  return json({ ok: true, commands });
};
