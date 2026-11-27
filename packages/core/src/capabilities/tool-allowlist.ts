/**
 * Capability grants (System Management, owned by `capabilities`): a leaf
 * module, pure functions with no imports, so Execution (runners, sidecars,
 * provisioning) and System Management (the app contract) share one rule
 * without a module cycle (D97).
 *
 * Resolve a manifest `tools[]` allowlist into the concrete set of toolchain
 * binary names to provision into an instance's `/aura/my-tools` dir.
 *
 * `tools[]` may mix plain tool names with two special MARKER tokens that change
 * how the list is interpreted (they are NOT tools themselves):
 *
 *   • `'*'` — WILDCARD: grant every binary in the toolchain. Highest precedence.
 *   • `'#'` — DENY-LIST ("all except"): grant every toolchain binary EXCEPT the
 *             explicitly named ones. Useful to hand an app almost everything
 *             while withholding a few (e.g. debugging with `['docker', '#']` =
 *             everything but docker).
 *   • otherwise — ALLOW-LIST: grant exactly the named tools.
 *
 * Precedence when both markers are present: `'*'` always wins (grant all). The
 * named tools are ALWAYS preserved in `tools[]` for persistence — flipping a
 * marker on/off never loses the user's explicit selection; this function only
 * computes the EFFECTIVE binary set for the current marker state.
 *
 * ALIASES. A registry entry may name other names for its binary (`aliases:`,
 * data on the capability, never a name in this code). An `AliasMap`
 * (binary → aliases, built at install time like the sidecar map, see
 * tool-provision) normalises a `tools[]` entry to the real binary name, so
 * comparisons and links use one name.
 *
 * SIDECARS. A capability is not always one file. `codex` spawns
 * `codex-code-mode-host` as a sibling of its own executable, so an allowlist
 * holding only the main binary leaves the feature permanently broken ("host
 * executable was not found") even though the capability installed cleanly.
 * A `SidecarMap` (built at install time, see tool-provision) records which
 * helper files belong to which tool, and every function here treats an owner
 * and its helpers as ONE grant: granting the owner brings the helpers, denying
 * it takes them away, and a helper is never provisioned on its own. That last
 * rule matters — a tool whose helper is present but whose owner is not is
 * worse than a missing command, because the tool reports a broken feature
 * instead of being absent.
 */
export const TOOL_MARKERS = new Set(['*', '#']);

/** Binary name → the other names `tools[]` may use for it (the registry's `aliases:`). Persisted next to the toolchain binaries; see `ALIAS_MANIFEST`. */
export type AliasMap = Record<string, string[]>;

export function toolBinaryName(tool: string, aliases: AliasMap = {}): string {
  for (const [binary, names] of Object.entries(aliases)) if (names.includes(tool)) return binary;
  return tool;
}

/** Plain (non-marker) tool names from a `tools[]`, normalised to binary names. */
export function namedTools(tools: string[], aliases: AliasMap = {}): string[] {
  return tools.filter((t) => !TOOL_MARKERS.has(t)).map((t) => toolBinaryName(t, aliases));
}

/**
 * Owner binary name → the helper binaries that must travel with it.
 * Persisted next to the toolchain binaries; see `SIDECAR_MANIFEST`.
 */
export type SidecarMap = Record<string, string[]>;

/**
 * Every name that belongs to some owner — i.e. every name that is NOT
 * independently grantable. UIs use this to keep helpers out of tool pickers:
 * `codex-code-mode-host` is an implementation detail of `codex`, not a
 * capability a user should reason about.
 */
export function sidecarNames(sidecars: SidecarMap): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(sidecars)) for (const n of list) out.add(n);
  return out;
}

/** helper → owner, for the "is this grantable on its own?" checks below. */
function sidecarOwners(sidecars: SidecarMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [owner, list] of Object.entries(sidecars)) {
    for (const n of list) out.set(n, owner);
  }
  return out;
}

/** `names` plus the helpers of every owner in it. */
function withSidecars(names: Iterable<string>, sidecars: SidecarMap): Set<string> {
  const out = new Set<string>(names);
  for (const n of [...out]) for (const s of sidecars[n] ?? []) out.add(s);
  return out;
}

/**
 * @param tools        the manifest `tools[]` array (may include `'*'` / `'#'`).
 * @param allBinaries  every binary name available in the toolchain bin dir.
 * @param sidecars     owner → helper names, so a tool is granted as a unit.
 * @param aliases      binary → other names for it (the registry's `aliases:`).
 * @returns            binary names to materialise into the instance allowlist.
 *
 * Names with no binary behind them are deliberately kept: the caller reports
 * them as `missing` ("granted but not installed"), which is the signal that
 * sends someone to `aura cap install`.
 */
export function resolveToolBinaries(
  tools: string[],
  allBinaries: string[],
  sidecars: SidecarMap = {},
  aliases: AliasMap = {},
): string[] {
  // Wildcard wins, and already covers helpers — they are in `allBinaries`.
  if (tools.includes('*')) return [...allBinaries];
  const named = namedTools(tools, aliases);
  if (tools.includes('#')) {                              // all-except
    // Denying an owner denies its helpers too, so a partial tool never
    // reaches the sandbox.
    const deny = withSidecars(named, sidecars);
    return allBinaries.filter((b) => !deny.has(b));
  }
  const grant = withSidecars(named, sidecars);             // plain allow-list
  const owners = sidecarOwners(sidecars);
  // Drop orphan helpers: naming one directly, or a stale map entry, must not
  // hand a tool's private helper to an app that wasn't granted the tool.
  return [...grant].filter((b) => {
    const owner = owners.get(b);
    return owner === undefined || grant.has(owner);
  });
}

/**
 * True when a manifest's tool set should be re-provisioned after a NEW cap is
 * installed — i.e. its effective binary set depends on what's installed. Both
 * wildcard (`'*'`) and deny-list (`'#'`) apps grow when a cap appears; plain
 * allow-lists don't.
 */
export function toolsTrackInstalledCaps(tools: string[]): boolean {
  return tools.includes('*') || tools.includes('#');
}

/**
 * Whether a `tools[]` grants access to a specific tool by name, honoring the
 * `'*'` (all) and `'#'` (all-except) markers. `docker` is never granted by a
 * marker (stream J.7, D54/D55): only an explicit entry names it, and even
 * that gives no Docker socket any more (spawn/socketArgs.ts).
 */
export function toolsGrant(tools: string[], name: string, sidecars: SidecarMap = {}, aliases: AliasMap = {}): boolean {
  const bin = toolBinaryName(name, aliases);
  if (bin === 'docker') return namedTools(tools, aliases).includes('docker');
  if (tools.includes('*')) return true;
  const named = namedTools(tools, aliases);
  // A helper follows its owner's grant, never its own name.
  const probe = sidecarOwners(sidecars).get(bin) ?? bin;
  if (tools.includes('#')) return !named.includes(probe); // all-except: granted unless explicitly excepted
  return named.includes(probe);
}
