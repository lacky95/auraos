/**
 * OS KV keys the `nexus` module owns (D97 A3, `kv-owner`): `os` namespace
 * keys under `nexus/` (sources, legacy registries, source seeds), read and
 * written in process through `osKv.ts`. A contract leaf.
 */
export const NEXUS_KV_PREFIXES = ['nexus/'] as const;

export const NEXUS_SOURCES_KEY = 'nexus/sources';
export const NEXUS_LEGACY_REGISTRIES_KEY = 'nexus/registries';
/** The shell's seed apply state (lib/nexusSeedsApply.ts), owned here. */
export const NEXUS_SOURCE_SEEDS_KEY = 'nexus/source-seeds';
