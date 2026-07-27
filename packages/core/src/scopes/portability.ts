/**
 * Scope portability — the rules that make an app dir runnable in the scope it
 * lands in.
 *
 * System-scope apps live INSIDE the pnpm workspace: their `@aura/*` deps are
 * `workspace:*` specs resolved by the workspace install into
 * `apps/<id>/node_modules`. User/global-scope apps live outside the workspace
 * globs — nothing ever runs `pnpm install` for them, so a `workspace:*` spec
 * would simply fail to resolve. Instead those apps carry their `@aura/*` deps
 * in a non-standard `auraDependencies` field that npm/pnpm silently ignore and
 * `aura sdk install` reads (invoked from the sandbox's synth entrypoint on
 * first boot), pulling the packages from the local OCI registry.
 *
 * Two callers must agree on this, in two different packages AND two different
 * processes:
 *   • `aura dev new`  — renders a template client-side (aura-cli/commands/dev.ts)
 *   • `aura dev clone` — copies a real app dir host-side (shell's
 *                        /api/admin/clone-app, which the CLI cannot do itself
 *                        from inside a sliced container sandbox)
 * Divergence between them produces an app that looks fine on disk and then
 * dies at first launch when `@aura/*` can't resolve — far from the code that
 * caused it. Hence one implementation here, next to ScopeRegistry.
 */
import type { ScopeId } from './types.js';

/**
 * Tools every non-system app needs in its manifest allowlist. The synth
 * entrypoint shells out to `aura sdk install`, which needs `aura` itself plus
 * `oras` to pull `@aura/*` from the local OCI registry; `bash` + `node` run
 * the entrypoint and the app. System-scope apps don't need any of it — their
 * `@aura/*` is already symlinked in by the workspace install.
 */
export const AURA_RUNTIME_TOOLS = ['bash', 'node', 'aura', 'oras'] as const;

/**
 * `.npmrc` dropped into non-system app dirs. Primarily documentation (and an
 * IDE hint) — actual `@aura/*` resolution happens over OCI via
 * `aura sdk install`, not the npm protocol.
 */
export const AURA_NPMRC =
  '# AuraOS user-scope apps: @aura/* packages live in `auraDependencies`,\n' +
  '# not `dependencies` (npm/pnpm ignore it; `aura sdk install` reads it).\n' +
  '# The registry below is documentation; resolution happens via OCI.\n' +
  '@aura:registry=http://aura-com.aura.registry:4090/\n';

/** True when this scope's apps need the `.npmrc` above. */
export function needsNpmrc(scope: ScopeId): boolean {
  return scope !== 'system';
}

/**
 * Union {@link AURA_RUNTIME_TOOLS} into a manifest's `tools[]` for non-system
 * scopes. Order-stable (existing entries keep their positions) and idempotent.
 */
export function portToolsForScope(tools: readonly string[], scope: ScopeId): string[] {
  if (scope === 'system') return [...tools];
  return [...new Set([...tools, ...AURA_RUNTIME_TOOLS])];
}

/**
 * Move every `@aura/*` dependency carrying a `workspace:` spec out of
 * `dependencies`/`devDependencies` and into `auraDependencies`, pinned to
 * `^<sdkVersion>`.
 *
 * Notes:
 *   • Sweeps ALL `@aura/*` packages, not just `@aura/app-sdk` — a real
 *     system-scope app may also depend on `@aura/ui`, `@aura/kv-store`, …
 *     and `aura sdk install`'s dep discovery reads the whole scope.
 *   • Only `workspace:` specs move. A dep already pinned to a real version is
 *     resolvable by npm and is left alone.
 *   • Idempotent and a no-op for `system`, so callers may run it
 *     unconditionally (which also repairs a hand-edited `workspace:*` that
 *     someone left in a user-scope app).
 *
 * Mutates and returns `pkg` plus whether anything actually changed.
 */
export function portPackageJsonForScope(
  pkg: Record<string, unknown>,
  scope: ScopeId,
  sdkVersion: string,
): { pkg: Record<string, unknown>; changed: boolean } {
  if (scope === 'system') return { pkg, changed: false };

  const auraDeps = { ...(pkg['auraDependencies'] as Record<string, string> | undefined) };
  let changed = false;

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith('@aura/')) continue;
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
      delete deps[name];
      auraDeps[name] = `^${sdkVersion}`;
      changed = true;
    }
    // Drop the field entirely when the sweep emptied it, so the resulting
    // package.json stays as clean as a freshly scaffolded one.
    if (Object.keys(deps).length === 0) { delete pkg[field]; changed = true; }
  }

  if (Object.keys(auraDeps).length > 0) {
    pkg['auraDependencies'] = auraDeps;
  }
  return { pkg, changed };
}
