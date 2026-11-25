/**
 * The Nexus keys of the OS KV (`os/nexus/*`: sources, legacy registries,
 * source seeds), read and written in process. These used to go through the
 * shell's public `/api/kv` proxy over loopback, which made the shell an
 * anonymous caller of itself: `enforce` refuses that. A write emits
 * `kv:changed` as the proxy does, so its subscribers see no difference.
 */
import { defaultKv } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';

/** The stored value, or undefined when the key is absent. Throws when the KV is down. */
export async function readOsKey(key: string): Promise<unknown> {
  const kv = defaultKv();
  try {
    return (await kv.get('os', key))?.value;
  } finally {
    await kv.close().catch(() => undefined);
  }
}

/** Replace the value. Throws when the KV is down. */
export async function writeOsKey(key: string, value: unknown): Promise<void> {
  const kv = defaultKv();
  try {
    const stored = await kv.set('os', key, value);
    OsEventBus.emit('kv:changed', { namespace: 'os', key, value: stored.value });
  } finally {
    await kv.close().catch(() => undefined);
  }
}
