import { CustomInterfaceSchema, type AppManager, type CustomInterface } from '@aura/core';
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
      const p = CustomInterfaceSchema.safeParse(e);
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
  const p = CustomInterfaceSchema.safeParse(body);
  if (p.success) return { ok: true, value: p.data };
  const first = p.error.issues[0];
  return { ok: false, error: `invalid interface: ${first?.path.join('.') || 'body'} — ${first?.message ?? 'invalid'}` };
}

/** Writes need the same permission a direct KV write to `os/interfaces` would. */
export const CUSTOM_INTERFACES_WRITE_PERMISSION = 'system.kv.os.interfaces.write';

/**
 * Who is writing: an app (identified by the `/api/proxy/<id>/` Referer, as in
 * the KV proxy) or `'system'` (SSR, curl). Returns an error message when the
 * calling app lacks the permission, else null.
 */
export function checkCustomWrite(request: Request, mgr: AppManager): string | null {
  const referer = request.headers.get('referer');
  const match = referer ? safePath(referer).match(/^\/api\/proxy\/([^/]+)\//) : null;
  if (!match) return null;
  const inst = mgr.getInstance(match[1]!) ?? mgr.getInstancesByApp(match[1]!)[0];
  const appId = inst?.appId ?? match[1]!;
  return mgr.permissions.hasPermission(appId, CUSTOM_INTERFACES_WRITE_PERMISSION)
    ? null
    : `Permission denied: ${CUSTOM_INTERFACES_WRITE_PERMISSION}`;
}

function safePath(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}
