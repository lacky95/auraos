import { CustomInterfaceSchema, safeParse3, type AppManager, type CustomInterface } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

/**
 * User-registered (custom) interfaces — external endpoints the OS lists next
 * to app interfaces. The KV key `os/interfaces` is the only copy; the
 * registry's custom layer is a projection of it, refreshed on boot and after
 * every write.
 */
const NS = 'os';
const KEY = 'interfaces';

export async function loadCustomInterfaces(): Promise<CustomInterface[]> {
  const kv = defaultKv();
  try {
    const raw = await kv.getValue<unknown[]>(NS, KEY);
    // Re-validate on read: a hand-edited or stale entry is skipped, never fatal.
    return (raw ?? []).flatMap((e) => {
      const p = safeParse3(CustomInterfaceSchema, e);
      return p.success ? [p.data] : [];
    });
  } finally {
    await kv.close().catch(() => undefined);
  }
}

export async function saveCustomInterfaces(mgr: AppManager, entries: CustomInterface[]): Promise<void> {
  const kv = defaultKv();
  try {
    await kv.set(NS, KEY, entries);
  } finally {
    await kv.close().catch(() => undefined);
  }
  mgr.interfaces.setCustom(entries);
}

/** Validate a request body; returns the entry or a user-facing error. */
export function parseCustomInterface(body: unknown): { ok: true; value: CustomInterface } | { ok: false; error: string } {
  const p = safeParse3(CustomInterfaceSchema, body);
  if (p.success) return { ok: true, value: p.data };
  const first = p.issues[0];
  return { ok: false, error: `invalid interface: ${first?.path.join('.') || 'body'} — ${first?.message ?? 'invalid'}` };
}

/**
 * Writes need the same permission a direct KV write to `os/interfaces` would
 * (routeManifest.ts, `/api/interfaces/custom`, applied by the middleware).
 */
export const CUSTOM_INTERFACES_WRITE_PERMISSION = 'system.kv.os.interfaces.write';

