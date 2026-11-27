export type Composition = 'server' | 'desktop';
export function compositionOf(env?: Record<string, string | undefined>): Composition;
export const DESKTOP_PAGES: readonly { readonly pattern: string; readonly file: string }[];
export const COMPOSITION_MARKER: string;
export function compositionMarker(composition: Composition): { name: string; hooks: Record<string, (...args: never[]) => void> };
