import type { Command } from 'commander';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AppManifestSchema, AURA_NPMRC, needsNpmrc, portPackageJsonForScope, portToolsForScope } from '@aura/core';
import { color, fail, info, ok, warn } from '../lib/format.js';
import { promptText, promptChoice, promptConfirm, promptMultiSelect, PromptCancelled, BACK, type MultiSelectMode } from '../lib/prompts.js';
import { ensureRegistry, loadRegistry, loadState, type CapabilityEntry } from '../lib/registry.js';
import { api } from '../lib/client.js';
import {
  ALL_SCOPES, PKG_RE, SELECTABLE_SCOPES, defaultIconFor, scopeAppsDir, stdoutDivider,
  type ScopeId, type SelectableScope,
} from '../lib/appid.js';
import { registerDevClone } from './dev-clone.js';

const TEMPLATE_DIR = (() => {
  if (process.env['AURA_TEMPLATE_DIR']) return process.env['AURA_TEMPLATE_DIR'];
  const candidates = [
    '/workspace/packages/aura-cli/src/templates/app',
    resolve(__dirname, '../templates/app'),
    resolve(__dirname, '../src/templates/app'),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
})();

const APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';

/**
 * Every `app.manifest.json` across ALL scopes, for `--all` sweeps. Higher-
 * priority scopes shadow lower ones by appId (user > global > system), so an
 * app overridden in the user scope is validated/cleaned once, at its winning
 * location — matching what the running OS actually loads.
 */
function allManifestPaths(): string[] {
  const byId = new Map<string, string>();
  for (const dir of ALL_SCOPES.map(scopeAppsDir)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const m = join(dir, entry, 'app.manifest.json');
      if (existsSync(m)) byId.set(entry, m); // later (higher-priority) dirs win
    }
  }
  return [...byId.values()];
}

/** Resolve an app's source dir across all scopes (highest priority wins). */
function resolveAppDir(appId: string): string | null {
  let found: string | null = null;
  for (const dir of ALL_SCOPES.map(scopeAppsDir)) {
    const d = join(dir, appId);
    if (existsSync(join(d, 'app.manifest.json')) || existsSync(join(d, 'package.json'))) found = d;
  }
  return found;
}

function renderTemplate(
  srcDir: string,
  destDir: string,
  vars: Record<string, string>,
  skip: Set<string> = new Set(),
): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (skip.has(entry)) continue;
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      renderTemplate(src, dest, vars, skip);
    } else {
      let body = readFileSync(src, 'utf-8');
      for (const [k, v] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, v);
      writeFileSync(dest, body);
      if (entry.endsWith('.sh')) chmodSync(dest, 0o755);
    }
  }
}

/** Three "shape" presets the wizard offers. Maps to manifest field combos. */
type ComponentShape = 'activity' | 'activity-bg' | 'service';

interface ScaffoldConfig {
  appId:        string;
  name:         string;
  icon?:        string;
  description?: string;
  shape:        ComponentShape;
  instanceMode: 'single' | 'multi';
  sandbox:      'proot' | 'container';
  tools:        string[];
  /** Where the app lives on disk. Default `user`. Determines:
   *    • destination directory (scope.appsDir/<id>)
   *    • whether the template package.json uses workspace:* (system) or
   *      versioned `@aura/*` deps (user/global)
   *    • whether a `.npmrc` pointing at the local registry is emitted
   *    • whether pnpm install runs after scaffold (skipped for non-system) */
  scope:        ScopeId;
}

/**
 * Generate a clean app manifest from a config: emits only fields that DIFFER
 * from the schema defaults, so the resulting manifest matches the
 * `aura dev clean-manifest` output (no churn diff for the user). Shape preset
 * decides componentType + backgroundService + autoStart in one place.
 */
function manifestFromConfig(cfg: ScaffoldConfig): Record<string, unknown> {
  const m: Record<string, unknown> = {
    id:          cfg.appId,
    name:        cfg.name,
    version:     '0.1.0',
    description: cfg.description ?? 'Scaffolded by `aura dev new`.',
  };
  if (cfg.icon) m['icon'] = cfg.icon;

  // Shape preset → component-type knobs. Each preset is the smallest set of
  // fields that captures intent; everything else inherits from the schema.
  if (cfg.shape === 'service') {
    m['componentType']   = 'service';
    // Services are headless by contract; autoStart is the typical companion
    // (Console is the in-repo example). Always single-instance.
    m['autoStart']       = true;
    // Zod refuses service + activityMode!='none', so we MUST NOT emit
    // activityMode here (the schema default 'none' already enforces it).
  } else {
    // Both 'activity' and 'activity-bg' are activity-component apps. We omit
    // componentType (schema default 'activity') to keep manifests minimal.
    m['instanceMode'] = cfg.instanceMode;
    m['activityMode'] = 'multi';
    if (cfg.instanceMode === 'multi') m['defaultLaunch'] = 'new-activity';
    if (cfg.shape === 'activity-bg') m['backgroundService'] = true;
  }

  // Container sandbox is opt-in (heavier spawn but real kernel-namespace
  // isolation + survives shell restarts). PRoot is the schema default; omit it.
  if (cfg.sandbox === 'container') m['sandbox'] = 'container';

  // User/global-scope apps NEED `aura` + `oras` available at runtime so the
  // synth entrypoint's `aura sdk install` call can resolve @aura/* from the
  // local OCI registry. System-scope apps don't (their @aura/* is already
  // in /workspace/node_modules via pnpm workspace symlinks). `dev clone`
  // applies the same union server-side, hence the shared helper.
  const merged = portToolsForScope(cfg.tools, cfg.scope);
  if (merged.length > 0) m['tools'] = merged;

  return m;
}

/**
 * Run the interactive wizard. Step-array architecture: each step reads &
 * writes the partial-config draft, and either returns a value (advance) or
 * BACK (rewind). Esc / left-arrow at any prompt → previous step; Esc at the
 * first step → cancel the wizard. Re-running a previous step pre-fills the
 * default from the draft so the user only edits what they want to change.
 */
async function runWizard(seed: { appId?: string; force?: boolean }): Promise<ScaffoldConfig | null> {
  stdoutDivider();
  console.log(`  ${color.bold('aura')} · scaffold a new app   ${color.dim('— esc/← to go back, ^C to cancel')}`);
  stdoutDivider();

  // Draft holds whatever the user has filled in so far. We never look up by
  // step index — each step pulls only the keys it cares about, and writes
  // its result back. That way reordering steps is a one-line change.
  const draft: Partial<ScaffoldConfig> = {};
  if (seed.appId) draft.appId = seed.appId;

  type StepResult = 'advance' | 'back' | 'cancel';
  const steps: Array<{ id: string; run: () => Promise<StepResult> }> = [
    {
      id: 'appId',
      run: async () => {
        const v = await promptText('Package name (reverse-domain)', {
          default: draft.appId,
          allowBack: true,
          validate: (s) => {
            if (!PKG_RE.test(s)) return `Invalid: ${s}. Use reverse-domain like com.example.app.`;
            // Existence is checked at the confirm step, once the target scope
            // (and therefore the destination directory) has been chosen.
            return null;
          },
        });
        if (v === BACK) return 'cancel'; // first step → back == cancel
        draft.appId = v;
        return 'advance';
      },
    },
    {
      id: 'name',
      run: async () => {
        const shortName   = draft.appId!.split('.').pop() ?? draft.appId!;
        const titled      = shortName.replace(/(^|-)([a-z])/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());
        const v = await promptText('Display name', {
          default: draft.name ?? titled,
          allowBack: true,
          validate: (s) => s.length >= 1 ? null : 'Required.',
        });
        if (v === BACK) return 'back';
        draft.name = v;
        return 'advance';
      },
    },
    {
      id: 'icon',
      run: async () => {
        const v = await promptText('Launch icon (1–3 chars)', {
          default: draft.icon ?? defaultIconFor(draft.name!),
          allowBack: true,
          validate: (s) => s.length >= 1 && s.length <= 3 ? null : 'Must be 1–3 characters.',
        });
        if (v === BACK) return 'back';
        draft.icon = v;
        return 'advance';
      },
    },
    {
      id: 'description',
      run: async () => {
        const v = await promptText('Short description', {
          default: draft.description ?? 'Scaffolded by `aura dev new`.',
          allowBack: true,
        });
        if (v === BACK) return 'back';
        draft.description = v;
        return 'advance';
      },
    },
    {
      id: 'shape',
      run: async () => {
        const opts = [
          { value: 'activity'    as ComponentShape, label: 'Activity',              desc: 'Has a UI. Backend dies when the last window closes.' },
          { value: 'activity-bg' as ComponentShape, label: 'Activity (background)', desc: 'Has a UI. Backend survives last-window close (like Terminal).' },
          { value: 'service'     as ComponentShape, label: 'Service',               desc: 'Headless. No UI, autoStarts at OS init (like Console).' },
        ];
        const startIdx = Math.max(0, opts.findIndex((o) => o.value === draft.shape));
        const v = await promptChoice<ComponentShape>('Component shape', opts, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.shape = v;
        return 'advance';
      },
    },
    {
      id: 'instanceMode',
      run: async () => {
        // Services are always single-instance — skip this step entirely when
        // shape=service (advance silently so back/forward still works).
        if (draft.shape === 'service') { draft.instanceMode = 'single'; return 'advance'; }
        const opts = [
          { value: 'single' as const, label: 'Single', desc: 'One backend process; activities are tabs on it.' },
          { value: 'multi'  as const, label: 'Multi',  desc: 'Each launch can spawn its own backend (defaultLaunch: new-activity).' },
        ];
        const startIdx = Math.max(0, opts.findIndex((o) => o.value === draft.instanceMode));
        const v = await promptChoice<'single' | 'multi'>('Instance mode', opts, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.instanceMode = v;
        return 'advance';
      },
    },
    {
      id: 'sandbox',
      run: async () => {
        // Container first = preselected default. The user wants the stronger
        // isolation by default; PRoot stays available as a lighter alternative.
        const opts = [
          { value: 'container' as const, label: 'Container', desc: 'Real Docker namespace. Survives shell restart. Recommended.' },
          { value: 'proot'     as const, label: 'PRoot',     desc: 'Lightweight ptrace sandbox. Fast cold start, weaker isolation.' },
        ];
        const startIdx = Math.max(0, opts.findIndex((o) => o.value === draft.sandbox));
        const v = await promptChoice<'proot' | 'container'>('Sandbox', opts, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.sandbox = v;
        return 'advance';
      },
    },
    {
      id: 'scope',
      run: async () => {
        // Only user/global are offered — `system` is reserved for the in-repo
        // OS apps and is never a scaffold target (see SELECTABLE_SCOPES).
        const opts = [
          { value: 'user'   as SelectableScope, label: 'User',   desc: 'Private to you. Lives in your user data dir. The usual choice.' },
          { value: 'global' as SelectableScope, label: 'Global', desc: 'Shared across every user on this machine.' },
        ];
        const startIdx = Math.max(0, opts.findIndex((o) => o.value === draft.scope));
        const v = await promptChoice<SelectableScope>('Scope', opts, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.scope = v;
        return 'advance';
      },
    },
    {
      id: 'tools',
      run: async () => {
        const v = await pickTools(draft.tools);
        if (v === BACK) return 'back';
        draft.tools = v;
        return 'advance';
      },
    },
    {
      id: 'confirm',
      run: async () => {
        const cfg = draft as ScaffoldConfig;
        const dest = join(scopeAppsDir(cfg.scope), cfg.appId);
        stdoutDivider();
        console.log(`  ${color.bold('Summary')}`);
        stdoutDivider();
        const summary = manifestFromConfig(cfg);
        for (const [k, val] of Object.entries(summary)) {
          console.log(`  ${color.dim(k.padEnd(18))} ${color.green(JSON.stringify(val))}`);
        }
        console.log(`  ${color.dim('scope'.padEnd(18))} ${color.green(cfg.scope)}`);
        console.log(`  ${color.dim('dest'.padEnd(18))} ${color.green(dest)}`);
        stdoutDivider();
        if (existsSync(dest) && !seed.force) {
          warn(`${dest} already exists — creating will overwrite it.`);
        }
        const proceed = await promptConfirm('Create?', true, { allowBack: true });
        if (proceed === BACK) return 'back';
        return proceed ? 'advance' : 'cancel';
      },
    },
  ];

  try {
    let i = 0;
    while (i < steps.length) {
      const r = await steps[i]!.run();
      if (r === 'cancel') return null;
      if (r === 'back') {
        // Walk past skipped-by-shape steps. instanceMode auto-advances when
        // shape=service; back from sandbox must hop OVER it to land on shape.
        do { i = Math.max(0, i - 1); }
        while (i > 0 && draft.shape === 'service' && steps[i]!.id === 'instanceMode');
        continue;
      }
      i++;
    }
    // The scope step already set this; `??=` is just a safety net for an
    // unexpected empty draft. `user` is the default — `system` is never an
    // option (it's reserved for the in-repo OS apps; see SELECTABLE_SCOPES).
    draft.scope ??= 'user';
    return draft as ScaffoldConfig;
  } catch (err) {
    if (err instanceof PromptCancelled) return null;
    throw err;
  }
}

/**
 * Interactive tool picker for the wizard. Two modes the user can flip with
 * `m` or Tab:
 *   • "enable only"      — installed caps + always-on builtins. Quickest path.
 *   • "install + enable" — every registry entry. Failed installs are warned,
 *                          not fatal — the manifest still gets the tool name
 *                          and the user can re-run `aura cap install <name>`
 *                          later. The shell is the install executor; if it's
 *                          unreachable we skip install entirely and just write
 *                          the names into tools[] (later launch will install).
 *
 * Returns the final list of cap names that should land in the manifest's
 * `tools[]`. Empty list is allowed — the schema default is [].
 */
async function pickTools(prior?: string[]): Promise<string[] | typeof BACK> {
  ensureRegistry();
  const reg = loadRegistry();

  // Prefer the shell's view of installed state; fall back to local file. Also
  // pull /os/toolchain/bin via inspect-tools so we can surface system binaries
  // (bash, git, docker, …) that aren't formally in the cap registry. The user
  // wants those checkable too — manifest tools[] is an allowlist, not a
  // registry-only set.
  let installedNames: Set<string>;
  let storeEntries: string[] = [];
  try {
    const [capRes, toolsRes] = await Promise.all([
      api.get<{ state: { capabilities: Record<string, { installed: boolean }> } }>('/api/admin/cap'),
      api.get<{ storeEntries: string[] }>('/api/admin/inspect-tools'),
    ]);
    installedNames = new Set(
      Object.entries(capRes.state.capabilities).filter(([, s]) => s.installed).map(([n]) => n),
    );
    storeEntries = toolsRes.storeEntries ?? [];
  } catch {
    const state = loadState();
    installedNames = new Set(
      Object.entries(state.capabilities).filter(([, s]) => s.installed).map(([n]) => n),
    );
  }
  // Anything physically present in /os/toolchain/bin counts as installed —
  // the wildcard provisioner will bind it regardless of registry membership.
  for (const name of storeEntries) installedNames.add(name);
  for (const [name, entry] of Object.entries(reg.capabilities)) {
    if (entry.source === 'builtin') installedNames.add(name);
  }

  // Mode A "enable only": union of registry-known caps AND system binaries.
  // Mode B "install + enable": every registry entry (installed + not).
  const enableOnly = new Map<string, { label: string; desc: string; tag: string }>();
  for (const name of storeEntries) {
    const entry = reg.capabilities[name];
    enableOnly.set(name, {
      label: name,
      desc:  entry?.description ?? 'system binary in /os/toolchain/bin',
      tag:   color.green('installed'),
    });
  }
  for (const [name, entry] of Object.entries(reg.capabilities)) {
    if (!installedNames.has(name)) continue;
    if (enableOnly.has(name)) continue;
    enableOnly.set(name, {
      label: name,
      desc:  entry.description ?? '',
      tag:   color.green('installed'),
    });
  }

  const sortedNames = (names: Iterable<string>) =>
    Array.from(names).sort((a, b) => a.localeCompare(b));

  // If the user already picked tools and is re-entering this step (via
  // back/forward), honour those picks. Otherwise seed with bash + git as a
  // sensible default starter set — every container/proot scaffold tends to
  // want shell + version control on day one.
  const priorSet = prior && prior.length > 0
    ? new Set(prior)
    : new Set<string>(['bash', 'git']);

  const toOption = (name: string, label: string, desc: string, tag: string) => ({
    value: name,
    label,
    desc,
    tag,
    initiallyChecked: priorSet.has(name),
  });

  const enableOnlyOptions = sortedNames(enableOnly.keys()).map((n) => {
    const o = enableOnly.get(n)!;
    return toOption(n, o.label, o.desc, o.tag);
  });
  const installEnableOptions = sortedNames(Object.keys(reg.capabilities)).map((n) => {
    const e = reg.capabilities[n]!;
    return toOption(
      n,
      n,
      e.description ?? '',
      installedNames.has(n) ? color.green('installed') : color.yellow(e.source),
    );
  });

  const modes: MultiSelectMode<string>[] = [
    { label: 'enable only',      options: enableOnlyOptions     },
    { label: 'install + enable', options: installEnableOptions },
  ];

  const raw = await promptMultiSelect('Tools', modes, /* initialMode */ 0, { allowBack: true });
  if (raw === BACK) return BACK;
  const result = raw;

  // Mode A = enable only → nothing to install, just return names.
  if (result.modeIdx === 0) return result.selected;

  // Mode B = install + enable → trigger an install for everything selected
  // that ISN'T already installed. Failures are warned but not fatal: the
  // tool still goes into tools[] (so a later `aura cap install` can retry).
  const toInstall = result.selected.filter((n) => !installedNames.has(n));
  if (toInstall.length === 0) return result.selected;

  info(`installing ${toInstall.length} cap${toInstall.length === 1 ? '' : 's'}…`);
  for (const name of toInstall) {
    const entry = reg.capabilities[name] as CapabilityEntry | undefined;
    if (!entry) { warn(`${name}: not in registry, skipping install`); continue; }
    try {
      const res = await api.post<{ ok: boolean; symlink?: string; version?: string | null; error?: string }>(
        '/api/admin/cap',
        { action: 'install', name, entry },
      );
      if (!res?.ok) {
        warn(`${name}: install failed (${res?.error ?? 'unknown'}). Will land in manifest anyway — retry later with \`aura cap install ${name}\`.`);
        continue;
      }
      ok(`installed ${name}${res.version ? ` (${res.version})` : ''}`);
    } catch (err) {
      warn(`${name}: install error (${(err as Error).message}). Will land in manifest anyway — retry later with \`aura cap install ${name}\`.`);
    }
  }
  return result.selected;
}

interface PayloadFile {
  relPath: string;
  content: string;
  mode?: number;
}

/**
 * Render the template + manifest into a flat list of files. Used by both the
 * shell-side scaffold POST and the local-write fallback so the two paths
 * stay byte-identical.
 */
function buildScaffoldFiles(cfg: ScaffoldConfig): PayloadFile[] {
  if (!existsSync(TEMPLATE_DIR)) fail(`Scaffold template missing: ${TEMPLATE_DIR}`);
  // Pull the live @aura/app-sdk version from the monorepo so user/global
  // scopes pin to whatever's published in the local OCI registry. Used
  // when post-processing package.json below.
  const sdkVersion = readSdkVersion();
  const vars: Record<string, string> = {
    APP_ID:        cfg.appId,
    APP_NAME:      cfg.name,
    APP_SHORT:     cfg.appId.split('.').pop() ?? cfg.appId,
    // Legacy placeholders the template manifest used to consume — kept for
    // any non-manifest files that might still reference them in the future.
    INSTANCE_MODE: cfg.instanceMode,
    ACTIVITY_MODE: cfg.shape === 'service' ? 'none' : 'multi',
    TOOLS_JSON:    JSON.stringify(cfg.tools),
  };
  const files: PayloadFile[] = [];
  // `service`-shape apps don't have activities, so omit the activity
  // lifecycle handlers — they'd be dead files in the scaffold. Other
  // shapes (default + activity-bg) keep activityMode='multi' and need
  // both handlers so `aura app start` doesn't 404 on the OS-side
  // `onActivityCreate` POST.
  const includeActivityFiles = cfg.shape !== 'service';
  const walk = (srcDir: string, relPrefix: string): void => {
    for (const entry of readdirSync(srcDir)) {
      // Skip the template's placeholder manifest — we render the manifest
      // programmatically below to honor the shape preset cleanly.
      if (entry === 'app.manifest.json' && relPrefix === '') continue;
      const src = join(srcDir, entry);
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      // Conditionally skip activity-lifecycle files for service shapes.
      if (!includeActivityFiles && (
        rel === 'src/pages/api/lifecycle/onActivityCreate.ts' ||
        rel.startsWith('src/pages/api/lifecycle/onActivityDestroy/')
      )) continue;
      const st = statSync(src);
      if (st.isDirectory()) { walk(src, rel); continue; }
      let body = readFileSync(src, 'utf-8');
      for (const [k, v] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, v);
      files.push({
        relPath: rel,
        content: body,
        ...(entry.endsWith('.sh') ? { mode: 0o755 } : {}),
      });
    }
  };
  walk(TEMPLATE_DIR, '');
  files.push({
    relPath: 'app.manifest.json',
    content: JSON.stringify(manifestFromConfig(cfg), null, 2) + '\n',
  });
  // Post-process package.json: insert the @aura/app-sdk dep in the right
  // shape per scope. The template ships ONLY astro + @astrojs/node so the
  // shape difference lives in code (not three template variants).
  //   • system → "@aura/app-sdk": "workspace:*" in `dependencies`, picked
  //     up by the workspace pnpm install. npm/pnpm both understand
  //     workspace:* in the monorepo.
  //   • user/global → moved to a custom `auraDependencies` field that
  //     npm/pnpm silently ignore. `aura sdk install` reads it (run from
  //     the synth entrypoint on first boot) and pulls from the local OCI
  //     registry. This split lets `npm install` succeed for astro/normal
  //     deps without choking on the @aura/* spec that doesn't resolve to
  //     a real npm registry.
  const pkgIdx = files.findIndex((f) => f.relPath === 'package.json');
  if (pkgIdx >= 0) {
    const pkg = JSON.parse(files[pkgIdx]!.content) as Record<string, unknown>;
    // Always declare the dep in workspace form first, then let the shared
    // portability helper decide whether it stays there (system) or moves to
    // `auraDependencies` (user/global). Same helper `dev clone` runs
    // server-side, so both commands can never drift apart.
    pkg['dependencies'] = { '@aura/app-sdk': 'workspace:*', ...(pkg['dependencies'] as object) };
    portPackageJsonForScope(pkg, cfg.scope, sdkVersion);
    files[pkgIdx] = { ...files[pkgIdx]!, content: JSON.stringify(pkg, null, 2) + '\n' };
  }
  // User/global-scope apps live outside the pnpm workspace. Drop a `.npmrc`
  // documenting where the local OCI registry lives — primarily for IDE/
  // Tooling hints and the future day Zot grows native npm-protocol support.
  // Actual install for these scopes happens via `aura sdk install` invoked
  // from the sandbox's synth entrypoint (reads auraDependencies above).
  if (needsNpmrc(cfg.scope)) {
    files.push({ relPath: '.npmrc', content: AURA_NPMRC });
  }
  return files;
}

/** Read the published @aura/app-sdk version from the monorepo. Used to
 *  pin user/global-scope apps' deps to whatever the local registry has. */
function readSdkVersion(): string {
  try {
    // APPS_DIR points at AURA_APPS_DIR (= /workspace/apps inside the shell,
    // or .../apps on the host). packages/ is its sibling.
    const root = resolve(APPS_DIR, '..');
    const pkg = JSON.parse(readFileSync(join(root, 'packages/app-sdk/package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.1';
  } catch {
    return '0.0.1';
  }
}

/** Local-write fallback used when the shell isn't reachable. */
function writeFilesLocal(cfg: ScaffoldConfig, files: PayloadFile[]): string {
  const dest = join(scopeAppsDir(cfg.scope), cfg.appId);
  mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const target = join(dest, f.relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    if (f.mode) chmodSync(target, f.mode);
  }
  return dest;
}

/**
 * Common scaffold path. Tries the shell endpoint first — required for
 * container-sandbox callers (Terminal app), whose sliced `/workspace/apps`
 * bind means a local write would land in the container's overlay rather
 * than on the host where AppManager can see it. Falls back to a local
 * write only when the shell is unreachable (e.g. host-shell usage with
 * AuraOS not running).
 */
async function scaffoldFromConfig(cfg: ScaffoldConfig): Promise<void> {
  const files = buildScaffoldFiles(cfg);

  let dest: string;
  let viaShell = false;
  let installed = false;
  let installError: string | undefined;
  try {
    const res = await api.post<{ ok: boolean; dest?: string; error?: string; message?: string; installed?: boolean; installError?: string }>(
      '/api/admin/scaffold',
      { appId: cfg.appId, force: true, files, scope: cfg.scope },
    );
    if (!res?.ok) fail(`scaffold failed via shell: ${res?.error ?? 'unknown'} ${res?.message ?? ''}`.trim());
    dest    = res.dest!;
    viaShell = true;
    installed = res.installed === true;
    installError = res.installError;
  } catch (err) {
    // Shell isn't running (or we hit a network error). Fall back to a local
    // write — useful for `aura dev new` on the host with no aura-os up.
    // If we're inside a sliced-bind sandbox, the write will succeed in our
    // overlay but the host AppManager won't see it; warn the caller.
    const msg = (err as Error).message;
    warn(`shell scaffold unreachable (${msg.split('\n')[0]}); writing locally instead.`);
    const localDest = join(scopeAppsDir(cfg.scope), cfg.appId);
    if (existsSync(localDest)) {
      fail(`${localDest} already exists.`);
    }
    dest = writeFilesLocal(cfg, files);
    // Only system-scope apps live in the pnpm workspace and need a workspace
    // install to get their @aura/* + astro symlinks. user/global apps live
    // outside the workspace globs; their deps resolve at app-start time via
    // `aura sdk install` (the synth entrypoint hooks it in), so there's
    // nothing to install here. NB: system isn't reachable from the CLI, so in
    // practice this branch always skips — kept for completeness.
    if (cfg.scope === 'system') {
      const result = runPnpmInstallAt(dirname(dest));
      installed = result.ok;
      installError = result.error;
    } else {
      installed = true;
    }
  }

  ok(`scaffolded ${color.bold(cfg.appId)} at ${dest}${viaShell ? color.dim(' (via shell)') : ''}`);
  if (cfg.scope === 'system') {
    if (installed) {
      info(`pnpm install: ${color.dim('ok')}`);
    } else {
      warn(`pnpm install did not complete (${installError ? installError.split('\n')[0] : 'unknown'}). Run \`pnpm install\` in the workspace root before launching.`);
    }
  } else {
    info(`@aura/* deps resolve on first launch via ${color.dim('aura sdk install')}.`);
  }
  info(`Run \`aura app start ${cfg.appId}\` to launch it.`);
}

/**
 * Wrapper around `pnpm install` for the local-write fallback. `appsDir`
 * is the path to the apps/ directory; the workspace root is its parent.
 * Returns ok=true on success, ok=false + error on failure (we never
 * throw — a failed install shouldn't roll the whole scaffold back).
 */
function runPnpmInstallAt(appsDir: string): { ok: boolean; error?: string } {
  const workspaceRoot = join(appsDir, '..');
  const r = spawnSync('pnpm', ['install', '--prefer-offline'], {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 120_000,
  });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr ?? r.error?.message ?? 'pnpm install failed').slice(0, 400) };
}

export function registerDev(program: Command): void {
  const dev = program.command('dev').description('Developer tools: scaffold apps, validate manifests, run an app standalone.');

  dev
    .command('new [appId]')
    .option('--name <name>',           'Display name')
    .option('--icon <chars>',          'Launch glyph (1–3 chars)')
    .option('--description <text>',    'Short description')
    .option('--shape <preset>',        'activity | activity-bg | service')
    .option('--instance-mode <mode>',  'single | multi', 'single')
    .option('--sandbox <kind>',        'proot | container', 'proot')
    .option('--tools <list>',          'Comma-separated capabilities to declare', '')
    .option('--scope <id>',            'user | global — where to install (default: user). system is reserved and cannot be targeted.', 'user')
    .option('--force',                 'Overwrite if target directory exists')
    .option('--non-interactive',       'Never prompt; require flags + appId')
    .description('Scaffold a new AuraOS app. Interactive wizard if no appId is given (or pass flags to script it).')
    .action(async (
      appId: string | undefined,
      opts: {
        name?: string; icon?: string; description?: string;
        shape?: ComponentShape; instanceMode: 'single' | 'multi';
        sandbox: 'proot' | 'container'; tools: string; scope: ScopeId;
        force?: boolean;
        nonInteractive?: boolean;
      },
    ) => {
      // Interactive wizard: no positional appId AND a TTY is present (and the
      // user didn't explicitly opt out via --non-interactive). Otherwise fall
      // through to the flag-based path so CI/scripts keep working unchanged.
      const wantInteractive = !opts.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
      if (wantInteractive && !appId) {
        const cfg = await runWizard({ ...(opts.force ? { force: true } : {}) });
        if (!cfg) { info('cancelled'); return; }
        await scaffoldFromConfig(cfg);
        return;
      }

      // Flag-based path (CI / scripted use).
      if (!appId) fail('No appId given. Run interactively or pass `aura dev new <appId>`.');
      if (!PKG_RE.test(appId)) fail(`Invalid app ID: ${appId}. Use reverse-domain notation like com.example.app.`);

      // Validate the enum flags up front so a typo fails fast with a clear
      // message instead of producing a manifest that only blows up later at
      // `aura dev validate` / schema load. The interactive wizard constrains
      // these to valid choices; the flag path has to enforce it itself. `shape`
      // is optional (defaults to 'activity'); `instance-mode`/`sandbox` always
      // carry an option default but are still validated in case of an explicit
      // bad value.
      const enumGuard = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): void => {
        if (value !== undefined && !allowed.includes(value as T)) {
          fail(`Invalid ${flag}: '${value}'. Expected one of: ${allowed.join(' | ')}.`);
        }
      };
      enumGuard('--shape',          opts.shape,        ['activity', 'activity-bg', 'service'] as const);
      enumGuard('--instance-mode',  opts.instanceMode, ['single', 'multi'] as const);
      enumGuard('--sandbox',        opts.sandbox,      ['proot', 'container'] as const);
      // `system` is reserved for the immutable in-repo OS scope and must never
      // be a scaffold target — surface a dedicated message before the generic
      // enum guard so the reason is obvious.
      if ((opts.scope as string) === 'system') {
        fail('system scope is reserved for in-repo OS apps and cannot be created with `aura dev new`. Use --scope user (the default) or --scope global.');
      }
      enumGuard('--scope',          opts.scope,        SELECTABLE_SCOPES);

      const dest = join(scopeAppsDir(opts.scope), appId);
      if (existsSync(dest) && !opts.force) fail(`${dest} already exists. Pass --force to overwrite.`);

      const cfg: ScaffoldConfig = {
        appId,
        name:         opts.name ?? (appId.split('.').pop() ?? appId),
        ...(opts.icon        ? { icon:        opts.icon }        : {}),
        ...(opts.description ? { description: opts.description } : {}),
        shape:        opts.shape ?? 'activity',
        instanceMode: opts.instanceMode,
        sandbox:      opts.sandbox,
        tools:        opts.tools.split(',').map((t) => t.trim()).filter(Boolean),
        scope:        opts.scope,
      };
      await scaffoldFromConfig(cfg);
    });

  // `dev clone` lives in its own module — same command group, but a full
  // command + wizard of its own (see commands/dev-clone.ts).
  registerDevClone(dev);

  dev
    .command('validate [path]')
    .option('--all', 'Validate every app across all scopes (system/global/user)')
    .description('Validate one or all app manifests against the AuraOS schema.')
    .action((path: string | undefined, opts: { all?: boolean }) => {
      const targets: string[] = [];
      if (opts.all) {
        targets.push(...allManifestPaths());
      } else if (path) {
        const abs = resolve(path);
        const m = abs.endsWith('.json') ? abs : join(abs, 'app.manifest.json');
        if (!existsSync(m)) fail(`Manifest not found: ${m}`);
        targets.push(m);
      } else {
        fail('Pass a path or --all.');
      }
      let failed = 0;
      for (const m of targets) {
        try {
          const data = JSON.parse(readFileSync(m, 'utf-8')) as unknown;
          const result = AppManifestSchema.safeParse(data);
          if (result.success) ok(`${m}`);
          else { warn(`${m}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`); failed++; }
        } catch (err) { warn(`${m}: ${String(err)}`); failed++; }
      }
      if (failed > 0) process.exit(1);
    });

  dev
    .command('standalone <appId>')
    .description('Run an app directly with astro dev (no PRoot, no shell wrapper) for fast UI iteration.')
    .action((appId: string) => {
      // Resolve across all scopes — a hardcoded /workspace/apps only finds
      // system-scope apps and fails on user/global installs.
      const dir = resolveAppDir(appId);
      if (!dir || !existsSync(join(dir, 'package.json'))) fail(`App not found: ${appId} (searched all scopes)`);
      const child = spawn('pnpm', ['exec', 'astro', 'dev'], {
        cwd: dir,
        stdio: 'inherit',
        env: { ...process.env, APP_ID: appId },
      });
      child.on('exit', (code) => process.exit(code ?? 0));
    });

  dev
    .command('clean-manifest [path]')
    .option('--all',     'Clean every manifest across all scopes (system/global/user)')
    .option('--dry-run', 'Print the cleaned manifest without writing back')
    .description('Strip manifest fields whose values equal the schema default (entrypoint, rootfsMode, viewConfig, theme, etc.).')
    .action((path: string | undefined, opts: { all?: boolean; dryRun?: boolean }) => {
      const targets: string[] = [];
      if (opts.all) {
        targets.push(...allManifestPaths());
      } else if (path) {
        const abs = resolve(path);
        const m = abs.endsWith('.json') ? abs : join(abs, 'app.manifest.json');
        if (!existsSync(m)) fail(`Manifest not found: ${m}`);
        targets.push(m);
      } else {
        fail('Pass a path or --all.');
      }
      let changedCount = 0;
      for (const m of targets) {
        try {
          const before = readFileSync(m, 'utf-8');
          const data   = JSON.parse(before) as Record<string, unknown>;
          const after  = stripDefaultedFields(data);
          const afterStr = JSON.stringify(after, null, 2) + '\n';
          if (afterStr === before) {
            info(`${m}: already minimal`);
            continue;
          }
          changedCount++;
          if (opts.dryRun) {
            console.log(color.bold(m));
            console.log(afterStr);
          } else {
            writeFileSync(m, afterStr);
            ok(`${m}: stripped ${countStrippedFields(data, after)} default field(s)`);
          }
        } catch (err) {
          warn(`${m}: ${String(err)}`);
        }
      }
      info(`done; ${changedCount} of ${targets.length} manifest(s) ${opts.dryRun ? 'would be' : 'were'} cleaned`);
    });
}

/**
 * Manifest fields whose presence in JSON is redundant because the Zod schema
 * fills the same value during parse. Listed here rather than introspected
 * out of Zod because Zod's runtime API for "what's this field's default" is
 * verbose and version-fragile; one explicit table is easier to audit.
 *
 * Kept in sync manually with `packages/core/src/types/manifest.ts` — if a
 * default changes there, mirror it here.
 */
const SCHEMA_DEFAULTS: Record<string, unknown> = {
  entrypoint:              'entrypoint.sh',
  permissions:             [],
  tools:                   [],
  rootfsMode:              'shared',
  category:                'utility',
  instanceMode:            'single',
  maxInstances:            0,
  warmPool:                0,
  activityMode:            'none',
  maxActivitiesPerInstance: 0,
  defaultLaunch:           'new-instance',
  backgroundService:       false,
  viewConfig:              { defaultWidth: 800, defaultHeight: 600, resizable: true },
  lifecycleBasePath:       '/api/lifecycle',
  preferredLayout:         'any',
  keymapActions:           [],
  theme:                   { mode: 'os-components' },
  themeStrategy:           'inherit',
};

function stripDefaultedFields(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...manifest };
  for (const [key, defaultValue] of Object.entries(SCHEMA_DEFAULTS)) {
    if (!(key in out)) continue;
    if (deepEqual(out[key], defaultValue)) delete out[key];
  }
  return out;
}

function countStrippedFields(before: Record<string, unknown>, after: Record<string, unknown>): number {
  return Object.keys(before).filter((k) => !(k in after)).length;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k, i) => k === bKeys[i] && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
