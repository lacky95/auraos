export type AccessMode = 'off' | 'report' | 'enforce';
export const ACCESS_MODES: readonly AccessMode[];
export const DEFAULT_ACCESS_MODE: 'report';
export const ACCESS_MODE_ENV: 'AURA_ACCESS_ENFORCE';
export function parseAccessMode(raw: unknown): AccessMode | null;
export function accessMode(): AccessMode;
export function wouldEnforce(mode: AccessMode, decision: string, enforcedAlready?: boolean): boolean;
