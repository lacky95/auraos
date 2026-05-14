import type { Command } from 'commander';
import { api, subscribeEvents } from '../lib/client.js';
import { color, fail } from '../lib/format.js';

function splitAuthority(ref: string): { authority: string; path: string } {
  const idx = ref.indexOf('/');
  if (idx === -1) fail(`Invalid reference: ${ref}. Use <authority>/<path>, e.g. com.aura.settings/api/data/theme`);
  return { authority: ref.slice(0, idx), path: ref.slice(idx) };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

export function registerData(program: Command): void {
  const data = program.command('data').description('Query / write / watch app content providers via the OS data router.');

  data
    .command('query <ref>')
    .description('GET <authority>/<path> and print the JSON response.')
    .action(async (ref: string) => {
      const { authority, path } = splitAuthority(ref);
      const result = await api.get(`/api/data/${encodeURIComponent(authority)}${path}`);
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    });

  data
    .command('write <ref> [body]')
    .option('-m, --method <method>', 'HTTP method: PUT (default), POST, PATCH, DELETE', 'PUT')
    .description('Write to a content provider. Body from arg, or stdin if "-" is passed.')
    .action(async (ref: string, body: string | undefined, opts: { method: string }) => {
      const { authority, path } = splitAuthority(ref);
      const payload = body === '-' ? await readStdin() : body ?? '';
      const parsed = payload.length ? (() => { try { return JSON.parse(payload) as unknown; } catch { return payload; } })() : undefined;
      const url = `/api/data/${encodeURIComponent(authority)}${path}`;
      let result: unknown;
      switch (opts.method.toUpperCase()) {
        case 'PUT':    result = await api.put(url, parsed); break;
        case 'POST':   result = await api.post(url, parsed); break;
        case 'DELETE': result = await api.del(url); break;
        default: fail(`Unsupported method: ${opts.method}`);
      }
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    });

  data
    .command('watch <ref>')
    .description('Follow an SSE-capable provider endpoint. Adds ?watch=1 if missing.')
    .action(async (ref: string) => {
      const { authority, path } = splitAuthority(ref);
      const sep = path.includes('?') ? '&' : '?';
      const url = `/api/data/${encodeURIComponent(authority)}${path}${sep}watch=1`;
      console.log(color.dim(`subscribing to ${url} (Ctrl+C to stop)`));
      const stop = subscribeEvents(url, (ev) => console.log(JSON.stringify(ev)));
      process.on('SIGINT', () => { stop(); process.exit(0); });
      await new Promise(() => undefined);
    });
}
