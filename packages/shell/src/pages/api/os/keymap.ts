import type { APIRoute } from 'astro';
import { keymapRegistry } from '@aura/core';

/**
 * Read-only OS keymap-catalogue endpoint. Mirrors `/api/os/themes` +
 * `/api/os/layouts` — the registry knows every action the OS + every app
 * has declared, so consumers don't have to enumerate manifests themselves.
 *
 * The user's overrides live separately at KV `/api/kv/os/keymap`; the
 * dispatcher combines the two on init and on every `kv:changed` event.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ actions: keymapRegistry.list() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
