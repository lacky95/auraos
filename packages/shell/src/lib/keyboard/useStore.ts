/** Minimal nanostores → React binding (avoids adding @nanostores/react). */
import { useSyncExternalStore } from 'react';
import type { ReadableAtom } from 'nanostores';

export function useStore<T>(store: ReadableAtom<T>): T {
  return useSyncExternalStore(
    (cb) => store.listen(() => cb()),
    () => store.get(),
    () => store.get(),
  );
}
