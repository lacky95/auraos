/**
 * User-registered (custom) interfaces: external endpoints the OS lists next
 * to app interfaces. The KV key `os/interfaces` is the only copy and this
 * module owns it; the registry's custom layer is a projection of it, hydrated
 * by `bootSystem()` (D98 R2, Phase 6 K) and refreshed after every write.
 */
import { defaultKv } from '@aura/kv-store';
import { CustomInterfaceSchema, type CustomInterface } from '../types/manifest.js';

export const CUSTOM_INTERFACES_KEY = { ns: 'os', key: 'interfaces' } as const;

export async function loadCustomInterfaces(): Promise<CustomInterface[]> {
  const kv = defaultKv();
  try {
    const raw = await kv.getValue<unknown[]>(CUSTOM_INTERFACES_KEY.ns, CUSTOM_INTERFACES_KEY.key);
    // Re-validate on read: a hand-edited or stale entry is skipped, never fatal.
    return (raw ?? []).flatMap((e) => {
      const p = CustomInterfaceSchema.safeParse(e);
      return p.success ? [p.data] : [];
    });
  } finally {
    await kv.close().catch(() => undefined);
  }
}

export async function saveCustomInterfaces(entries: CustomInterface[]): Promise<void> {
  const kv = defaultKv();
  try {
    await kv.set(CUSTOM_INTERFACES_KEY.ns, CUSTOM_INTERFACES_KEY.key, entries);
  } finally {
    await kv.close().catch(() => undefined);
  }
}
