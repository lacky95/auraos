import * as core from '@aura/core';
import { CustomInterfaceSchema, type AppManager, type CustomInterface } from '@aura/core';

/**
 * User-registered (custom) interfaces: the kernel owns `os/interfaces`
 * (core interfaces/custom.ts); a write refreshes the registry's custom layer.
 */
export const loadCustomInterfaces = core.loadCustomInterfaces;

export async function saveCustomInterfaces(mgr: AppManager, entries: CustomInterface[]): Promise<void> {
  await core.saveCustomInterfaces(entries);
  mgr.interfaces.setCustom(entries);
}

/** Validate a request body; returns the entry or a user-facing error. */
export function parseCustomInterface(body: unknown): { ok: true; value: CustomInterface } | { ok: false; error: string } {
  const p = CustomInterfaceSchema.safeParse(body);
  if (p.success) return { ok: true, value: p.data };
  const first = p.error.issues[0];
  return { ok: false, error: `invalid interface: ${first?.path.join('.') || 'body'} — ${first?.message ?? 'invalid'}` };
}

/**
 * Writes need the same permission a direct KV write to `os/interfaces` would
 * (routeManifest.ts, `/api/interfaces/custom`, applied by the middleware).
 */
export const CUSTOM_INTERFACES_WRITE_PERMISSION = 'system.kv.os.interfaces.write';

