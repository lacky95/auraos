/**
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
 * `claude-code` is an alias for the `claude` binary (kept for manifest
 * readability); it's normalised here so comparisons/symlinks use the real name.
 */
export const TOOL_MARKERS = new Set(['*', '#']);

export function toolBinaryName(tool: string): string {
  return tool === 'claude-code' ? 'claude' : tool;
}

/** Plain (non-marker) tool names from a `tools[]`, normalised to binary names. */
export function namedTools(tools: string[]): string[] {
  return tools.filter((t) => !TOOL_MARKERS.has(t)).map(toolBinaryName);
}

/**
 * @param tools        the manifest `tools[]` array (may include `'*'` / `'#'`).
 * @param allBinaries  every binary name available in the toolchain bin dir.
 * @returns            binary names to symlink into the instance allowlist.
 */
export function resolveToolBinaries(tools: string[], allBinaries: string[]): string[] {
  if (tools.includes('*')) return [...allBinaries];       // wildcard wins
  const named = namedTools(tools);
  if (tools.includes('#')) {                              // all-except
    const deny = new Set(named);
    return allBinaries.filter((b) => !deny.has(b));
  }
  return named;                                            // plain allow-list
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
 * `'*'` (all) and `'#'` (all-except) markers. Used to gate side effects tied to
 * a particular tool — e.g. binding the docker socket when `docker` is granted.
 */
export function toolsGrant(tools: string[], name: string): boolean {
  if (tools.includes('*')) return true;
  const bin = toolBinaryName(name);
  const named = namedTools(tools);
  if (tools.includes('#')) return !named.includes(bin); // all-except: granted unless explicitly excepted
  return named.includes(bin);
}
