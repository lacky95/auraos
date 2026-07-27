/**
 * `aura dev clone` — copy an existing app into a new one.
 *
 * The copy itself happens SERVER-SIDE (`POST /api/admin/clone-app`). The CLI
 * normally runs inside a container sandbox with a sliced bind of the apps dir,
 * so it can't read another app's source tree at all — same constraint that
 * forced `/api/admin/scaffold` to exist. This command therefore has no
 * local-write fallback: `aura dev new` can fall back because it renders every
 * byte client-side, but a local clone would silently produce a truncated app
 * dir, which is worse than a clean failure.
 *
 * Source apps may live in ANY scope, system included. The clone may only land
 * in a mutable scope (user/global) — system is the in-repo monorepo and is
 * never a write target. The shell enforces that independently via the scope's
 * `immutable` flag; the guards here just fail faster with a better message.
 */
import type { Command } from 'commander';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, info, ok, warn } from '../lib/format.js';
import {
  promptChoice, promptConfirm, promptMultiSelect, promptText,
  BACK, PromptCancelled, type MultiSelectMode,
} from '../lib/prompts.js';
import {
  PKG_RE, SELECTABLE_SCOPES, SEMVER_RE, defaultIconFor, scopeAppsDir, scopeColor,
  stdoutDivider, type ScopeId, type SelectableScope,
} from '../lib/appid.js';

const SCOPE_ORDER: ScopeId[] = ['system', 'global', 'user'];

// ─── API shapes ────────────────────────────────────────────────────────────

interface AppDto {
  manifest: {
    id: string;
    name?: string;
    icon?: string;
    description?: string;
    version: string;
    scopeId?: ScopeId;
  };
}

interface CloneResponse {
  ok: boolean;
  dryRun?: boolean;
  sourceAppId: string;
  sourceScope: ScopeId;
  targetAppId: string;
  scope: ScopeId;
  dest: string;
  fileCount: number;
  bytes: number;
  ported: boolean;
  rewrittenFiles: string[];
  strippedFields: string[];
  shadows: ScopeId | null;
  warnings: string[];
}

/** The full set of knobs the wizard and the flag path both produce. */
interface CloneConfig {
  sourceAppId:  string;
  sourceScope:  ScopeId;
  targetAppId:  string;
  scope:        SelectableScope;
  name?:        string;
  icon?:        string;
  description?: string;
  version?:     string;
  rewriteIds:   boolean;
  excludeGit:   boolean;
  stripPublish: boolean;
  stripStore:   boolean;
  withData:     boolean;
  force:        boolean;
  dryRun:       boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Pull the server's own message out of a failed request and show it VERBATIM.
 * The clone endpoint's messages carry the whole reason (which scope, which
 * path, which manifest field) — rewording them here would throw away the only
 * actionable signal the user gets.
 */
function apiError(err: unknown): string {
  const e = err as ShellError;
  if (typeof e?.body === 'string' && e.body.length > 0) {
    try {
      const parsed = JSON.parse(e.body) as { error?: string; message?: string };
      const msg = parsed.message ?? parsed.error;
      if (msg) {
        // The endpoint speaks HTTP ("force=true"); translate that one case to
        // the flag the user actually types.
        const hint = parsed.error === 'exists' ? `\n  Re-run with ${color.bold('--force')} to overwrite it.` : '';
        return (e.status ? `${msg} ${color.dim(`(HTTP ${e.status})`)}` : msg) + hint;
      }
    } catch {
      /* not JSON — fall through and show the raw body */
    }
    return e.status ? `HTTP ${e.status}: ${e.body}` : e.body;
  }
  return e instanceof Error ? e.message : String(err);
}

function isTTY(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

async function fetchApps(): Promise<AppDto[]> {
  try {
    return await api.get<AppDto[]>('/api/apps');
  } catch (err) {
    fail(`${apiError(err)}\n  \`aura dev clone\` copies server-side (the CLI usually can't see other apps' directories), so the shell must be running.`);
  }
}

function sortedApps(apps: AppDto[]): AppDto[] {
  return apps.slice().sort((a, b) => {
    const sa = SCOPE_ORDER.indexOf(a.manifest.scopeId ?? 'user');
    const sb = SCOPE_ORDER.indexOf(b.manifest.scopeId ?? 'user');
    return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb) || a.manifest.id.localeCompare(b.manifest.id);
  });
}

/**
 * First free `<sourceId>.copy`, `.copy2`, `.copy3`, … Appending a segment
 * keeps the suggestion valid under PKG_RE — hyphens are illegal there, so the
 * obvious `-copy` would not parse.
 */
function suggestId(sourceId: string, taken: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = `${sourceId}.copy${n === 1 ? '' : n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ─── Wizard ────────────────────────────────────────────────────────────────

/**
 * Step-array state machine, same architecture as `aura dev new`'s wizard: each
 * step reads and writes the shared draft and returns advance/back/cancel, so
 * rewinding preserves every prior answer and reordering steps is a one-line
 * change.
 */
async function runWizard(apps: AppDto[], seed: Partial<CloneConfig>): Promise<CloneConfig | null> {
  stdoutDivider();
  console.log(`  ${color.bold('aura')} · clone an app   ${color.dim('— ⌃B to go back, ^C to cancel')}`);
  stdoutDivider();

  const list = sortedApps(apps);
  const taken = new Set(list.map((a) => a.manifest.id));
  const draft: Partial<CloneConfig> = { ...seed };
  /** The source app's manifest — every field default reads off it. */
  let src: AppDto['manifest'] | undefined =
    seed.sourceAppId ? list.find((a) => a.manifest.id === seed.sourceAppId)?.manifest : undefined;
  if (seed.sourceAppId && !src) fail(`App not found: ${seed.sourceAppId} (searched all scopes)`);

  type StepResult = 'advance' | 'back' | 'cancel';
  const steps: Array<{ id: string; run: () => Promise<StepResult> }> = [
    {
      id: 'source',
      run: async () => {
        // Seeded from the positional arg — skip silently, but leave the step in
        // place so `back` from step 2 still resolves to "cancel" below.
        if (seed.sourceAppId) return 'advance';
        const startIdx = Math.max(0, list.findIndex((a) => a.manifest.id === draft.sourceAppId));
        const picked = await promptChoice<string>(
          'Clone which app?',
          list.map((a) => ({
            value: a.manifest.id,
            label: a.manifest.id,
            desc:  `${a.manifest.name ?? ''} ${color.dim('·')} ${scopeColor(a.manifest.scopeId ?? '-')}`,
          })),
          startIdx,
          { allowBack: true },
        );
        if (picked === BACK) return 'cancel'; // first step → back == cancel
        draft.sourceAppId = picked;
        src = list.find((a) => a.manifest.id === picked)!.manifest;
        draft.sourceScope = src.scopeId ?? 'user';
        return 'advance';
      },
    },
    {
      id: 'targetAppId',
      run: async () => {
        const v = await promptText('New package name (reverse-domain)', {
          default: draft.targetAppId ?? suggestId(src!.id, taken),
          allowBack: true,
          validate: (s) => {
            if (!PKG_RE.test(s)) return `Invalid: ${s}. Use reverse-domain like com.example.app.`;
            // Same id in a DIFFERENT scope is the legitimate "fork an OS app"
            // flow — only the exact same id AND scope is a no-op. The scope
            // isn't chosen yet, so this check re-runs at the confirm step.
            if (s === src!.id && (draft.scope ?? src!.scopeId) === src!.scopeId) {
              return 'That IS the source. Pick another id, or a different scope to shadow it from.';
            }
            return null;
          },
        });
        if (v === BACK) return 'back';
        draft.targetAppId = v;
        return 'advance';
      },
    },
    {
      id: 'name',
      run: async () => {
        const v = await promptText('Display name', {
          default: draft.name ?? `${src!.name ?? src!.id} Copy`,
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
          default: draft.icon ?? src!.icon ?? defaultIconFor(draft.name ?? src!.id),
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
          default: draft.description ?? src!.description ?? `Cloned from ${src!.id}.`,
          allowBack: true,
        });
        if (v === BACK) return 'back';
        draft.description = v;
        return 'advance';
      },
    },
    {
      id: 'version',
      run: async () => {
        const v = await promptText('Version', {
          default: draft.version ?? src!.version,
          allowBack: true,
          validate: (s) => SEMVER_RE.test(s) ? null : 'Must be x.y.z (e.g. 0.1.0).',
        });
        if (v === BACK) return 'back';
        draft.version = v;
        return 'advance';
      },
    },
    {
      id: 'scope',
      run: async () => {
        // Only user/global are offered — `system` is the immutable in-repo
        // scope and is never a clone TARGET (it's fine as a source).
        const opts = [
          { value: 'user'   as SelectableScope, label: 'User',   desc: 'Private to you. Lives in your user data dir. The usual choice.' },
          { value: 'global' as SelectableScope, label: 'Global', desc: 'Shared across every user on this machine.' },
        ];
        const preferred = draft.scope
          ?? (src!.scopeId === 'global' ? 'global' : 'user');
        const startIdx = Math.max(0, opts.findIndex((o) => o.value === preferred));
        const v = await promptChoice<SelectableScope>('Scope', opts, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.scope = v;
        return 'advance';
      },
    },
    {
      id: 'options',
      run: async () => {
        // Nothing is stripped by default — a clone should be a faithful copy
        // unless the user says otherwise. Each row carries the reason you'd
        // want it, so the choice is self-explanatory in the picker.
        const rows = [
          { key: 'rewriteIds',   label: 'rewrite ids',    on: draft.rewriteIds ?? true,    desc: `Replace "${src!.id}" with the new id inside copied text files.` },
          { key: 'excludeGit',   label: 'exclude .git',   on: draft.excludeGit ?? false,   desc: "Skip the source's .git — it carries the original's history and remote." },
          { key: 'stripPublish', label: 'strip publish',  on: draft.stripPublish ?? false, desc: "Drop `publish` so `nexus app publish` can't push to the original's repo." },
          { key: 'stripStore',   label: 'strip store',    on: draft.stripStore ?? false,   desc: 'Drop `store` metadata (publisher, homepage, screenshots) about the original.' },
          { key: 'withData',     label: 'copy app data',  on: draft.withData ?? false,     desc: "Also copy the source's runtime /data tree into the clone." },
        ];
        const modes: MultiSelectMode<string>[] = [{
          label: 'clone options',
          options: rows.map((r) => ({ value: r.key, label: r.label, desc: r.desc, initiallyChecked: r.on })),
        }];
        const res = await promptMultiSelect<string>('Clone options', modes, 0, { allowBack: true });
        if (res === BACK) return 'back';
        const on = new Set(res.selected);
        draft.rewriteIds   = on.has('rewriteIds');
        draft.excludeGit   = on.has('excludeGit');
        draft.stripPublish = on.has('stripPublish');
        draft.stripStore   = on.has('stripStore');
        draft.withData     = on.has('withData');
        return 'advance';
      },
    },
    {
      id: 'confirm',
      run: async () => {
        const cfg = draft as CloneConfig;
        if (cfg.targetAppId === src!.id && cfg.scope === src!.scopeId) {
          warn('Target id and scope both match the source — go back and change one.');
          return 'back';
        }
        const dest = join(scopeAppsDir(cfg.scope), cfg.targetAppId);
        stdoutDivider();
        console.log(`  ${color.bold('Summary')}`);
        stdoutDivider();
        const row = (k: string, v: string) => console.log(`  ${color.dim(k.padEnd(18))} ${v}`);
        row('source',      `${src!.id} ${color.dim('·')} ${scopeColor(src!.scopeId ?? '-')}`);
        row('target',      color.green(cfg.targetAppId));
        row('name',        color.green(JSON.stringify(cfg.name)));
        row('icon',        color.green(JSON.stringify(cfg.icon)));
        row('description', color.green(JSON.stringify(cfg.description)));
        row('version',     color.green(JSON.stringify(cfg.version)));
        row('scope',       color.green(cfg.scope));
        row('dest',        color.green(dest));
        row('options',     describeOptions(cfg));
        if (src!.scopeId === 'system') {
          row('transform', color.dim(`system → ${cfg.scope}: @aura/* → auraDependencies, +.npmrc, +tools`));
        }
        stdoutDivider();
        if (taken.has(cfg.targetAppId) && cfg.targetAppId !== src!.id) {
          warn(`${cfg.targetAppId} is already installed — cloning will overwrite it (needs --force) or shadow it.`);
        }
        if (cfg.targetAppId === src!.id) {
          warn(`${cfg.targetAppId} in scope ${cfg.scope} will SHADOW the ${src!.scopeId} copy — the OS loads the highest-priority scope. Removing the clone later unmasks the original.`);
        }
        const proceed = await promptConfirm('Clone?', true, { allowBack: true });
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
        i = Math.max(0, i - 1);
        // Step 1 auto-advances when the source came from a positional arg, so
        // backing into it would spin. Treat that as cancel instead.
        if (i === 0 && seed.sourceAppId) return null;
        continue;
      }
      i++;
    }
    return draft as CloneConfig;
  } catch (err) {
    if (err instanceof PromptCancelled) return null;
    throw err;
  }
}

function describeOptions(cfg: CloneConfig): string {
  const on: string[] = [];
  if (cfg.rewriteIds)   on.push('rewrite-ids');
  if (cfg.excludeGit)   on.push('exclude-.git');
  if (cfg.stripPublish) on.push('strip-publish');
  if (cfg.stripStore)   on.push('strip-store');
  if (cfg.withData)     on.push('with-data');
  return on.length > 0 ? color.green(on.join(', ')) : color.dim('(none)');
}

// ─── Execution ─────────────────────────────────────────────────────────────

async function cloneFromConfig(cfg: CloneConfig, asJson: boolean): Promise<void> {
  let res: CloneResponse;
  try {
    res = await api.post<CloneResponse>('/api/admin/clone-app', {
      sourceAppId:  cfg.sourceAppId,
      sourceScope:  cfg.sourceScope,
      targetAppId:  cfg.targetAppId,
      scope:        cfg.scope,
      manifest: {
        ...(cfg.name        !== undefined ? { name:        cfg.name }        : {}),
        ...(cfg.icon        !== undefined ? { icon:        cfg.icon }        : {}),
        ...(cfg.description !== undefined ? { description: cfg.description } : {}),
        ...(cfg.version     !== undefined ? { version:     cfg.version }     : {}),
      },
      rewriteIds:   cfg.rewriteIds,
      excludeGit:   cfg.excludeGit,
      stripPublish: cfg.stripPublish,
      stripStore:   cfg.stripStore,
      withData:     cfg.withData,
      force:        cfg.force,
      dryRun:       cfg.dryRun,
    });
  } catch (err) {
    fail(apiError(err));
  }

  if (asJson) {
    console.log(JSON.stringify(res!, null, 2));
    return;
  }

  const r = res!;
  if (r.dryRun) {
    info(`${color.bold('dry run')} — nothing was written.`);
    info(`would clone ${r.fileCount} file(s), ${(r.bytes / 1024).toFixed(0)} KB → ${r.dest}`);
  } else {
    ok(`cloned ${color.bold(r.sourceAppId)} ${color.dim(`(${r.sourceScope})`)} → ${color.bold(r.targetAppId)} at ${r.dest}`);
    info(`${r.fileCount} file(s), ${(r.bytes / 1024).toFixed(0)} KB`);
  }
  if (r.rewrittenFiles.length > 0) {
    info(`rewrote the source id in ${r.rewrittenFiles.length} file(s): ${color.dim(r.rewrittenFiles.slice(0, 5).join(', '))}${r.rewrittenFiles.length > 5 ? color.dim(', …') : ''}`);
  }
  if (r.strippedFields.length > 0) {
    info(`stripped manifest field(s): ${color.dim(r.strippedFields.join(', '))}`);
  }
  if (r.ported) {
    info(`ported @aura/* deps to ${color.dim('auraDependencies')} — they resolve on first launch via ${color.dim('aura sdk install')}.`);
  }
  if (r.shadows) {
    warn(`${r.targetAppId} now SHADOWS the ${r.shadows}-scope app of the same id. Removing the clone unmasks the original.`);
  }
  for (const w of r.warnings) warn(w);
  if (!r.dryRun) info(`Run \`aura app start ${r.targetAppId}\` to launch it.`);
}

// ─── Registration ──────────────────────────────────────────────────────────

export function registerDevClone(dev: Command): void {
  dev
    .command('clone [sourceAppId] [targetAppId]')
    .option('--scope <id>',          'user | global — where the CLONE lands (default: user). system is reserved and cannot be targeted.', 'user')
    .option('--source-scope <id>',   'system | global | user — read the source from this scope (disambiguates a shadowed app id)')
    .option('--name <name>',         'Display name (default: "<source name> Copy")')
    .option('--icon <chars>',        'Launch glyph, 1–3 chars (default: the source\'s)')
    .option('--description <text>',  'Short description (default: the source\'s)')
    .option('--version <semver>',    'Manifest version (default: the source\'s)')
    .option('--no-rewrite-ids',      'Do NOT substitute the source app id inside copied text files')
    .option('--exclude-git',         'Do not copy the source\'s .git directory')
    .option('--strip-publish',       'Drop the manifest `publish` block (repo/registry/channels)')
    .option('--strip-store',         'Drop the manifest `store` metadata (publisher, homepage, screenshots)')
    .option('--with-data',           'Also copy the source app\'s runtime /data tree')
    .option('--force',               'Overwrite the target if it already exists (stops its instances first)')
    .option('--dry-run',             'Report what would be copied and rewritten; write nothing')
    .option('--non-interactive',     'Never prompt; require both app ids')
    .option('--json',                'Print the raw endpoint response')
    .description('Clone an existing app into a new one. Interactive wizard if no ids are given (or pass flags to script it). Any app can be cloned — including system apps — but the clone always lands in user or global scope.')
    .action(async (
      sourceAppId: string | undefined,
      targetAppId: string | undefined,
      opts: {
        scope: ScopeId; sourceScope?: ScopeId;
        name?: string; icon?: string; description?: string; version?: string;
        rewriteIds: boolean; excludeGit?: boolean; stripPublish?: boolean;
        stripStore?: boolean; withData?: boolean;
        force?: boolean; dryRun?: boolean; nonInteractive?: boolean; json?: boolean;
      },
    ) => {
      // `system` is reserved for the in-repo OS apps and must never be a clone
      // TARGET — surface a dedicated message before the generic enum guard so
      // the reason (and the fact that cloning FROM system is fine) is obvious.
      if ((opts.scope as string) === 'system') {
        fail('system scope is reserved for in-repo OS apps and cannot be a clone target. System apps CAN be cloned FROM — use --scope user (the default) or --scope global.');
      }
      if (!SELECTABLE_SCOPES.includes(opts.scope as SelectableScope)) {
        fail(`Invalid --scope: '${opts.scope}'. Expected one of: ${SELECTABLE_SCOPES.join(' | ')}.`);
      }
      if (opts.sourceScope && !(['system', 'global', 'user'] as const).includes(opts.sourceScope)) {
        fail(`Invalid --source-scope: '${opts.sourceScope}'. Expected one of: system | global | user.`);
      }
      if (opts.version && !SEMVER_RE.test(opts.version)) {
        fail(`Invalid --version: '${opts.version}'. Expected x.y.z.`);
      }
      if (opts.icon && (opts.icon.length < 1 || opts.icon.length > 3)) {
        fail(`Invalid --icon: '${opts.icon}'. Must be 1–3 characters.`);
      }

      const wantInteractive = !opts.nonInteractive && isTTY();

      // Wizard whenever the target id is missing and we have a TTY. A lone
      // source id seeds step 1 and the wizard picks up from the new-id prompt.
      if (wantInteractive && !targetAppId) {
        const apps = await fetchApps();
        const cfg = await runWizard(apps, {
          ...(sourceAppId ? { sourceAppId } : {}),
          ...(sourceAppId
            ? { sourceScope: opts.sourceScope ?? apps.find((a) => a.manifest.id === sourceAppId)?.manifest.scopeId ?? 'user' }
            : {}),
          ...(opts.name        ? { name:        opts.name }        : {}),
          ...(opts.icon        ? { icon:        opts.icon }        : {}),
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.version     ? { version:     opts.version }     : {}),
          scope:        opts.scope as SelectableScope,
          rewriteIds:   opts.rewriteIds,
          excludeGit:   opts.excludeGit   ?? false,
          stripPublish: opts.stripPublish ?? false,
          stripStore:   opts.stripStore   ?? false,
          withData:     opts.withData     ?? false,
          force:        opts.force        ?? false,
          dryRun:       opts.dryRun       ?? false,
        });
        if (!cfg) { info('cancelled'); return; }
        await cloneFromConfig(cfg, opts.json ?? false);
        return;
      }

      // Flag path (CI / scripted use).
      if (!sourceAppId || !targetAppId) {
        fail('Need both app ids. Run interactively, or pass `aura dev clone <sourceAppId> <targetAppId>`.');
      }
      for (const [label, value] of [['source', sourceAppId], ['target', targetAppId]] as const) {
        if (!PKG_RE.test(value)) {
          fail(`Invalid ${label} app ID: ${value}. Use reverse-domain notation like com.example.app.`);
        }
      }

      // Resolve the source scope so a shadowed id clones deterministically —
      // without it the server would silently read whichever scope currently
      // wins. --source-scope overrides; otherwise take the registry's winner.
      let sourceScope = opts.sourceScope;
      if (!sourceScope) {
        const apps = await fetchApps();
        const found = apps.find((a) => a.manifest.id === sourceAppId);
        if (!found) fail(`App not found: ${sourceAppId} (searched all scopes)`);
        sourceScope = found!.manifest.scopeId ?? 'user';
      }

      await cloneFromConfig({
        sourceAppId,
        sourceScope,
        targetAppId,
        scope:        opts.scope as SelectableScope,
        ...(opts.name        ? { name:        opts.name }        : {}),
        ...(opts.icon        ? { icon:        opts.icon }        : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.version     ? { version:     opts.version }     : {}),
        rewriteIds:   opts.rewriteIds,
        excludeGit:   opts.excludeGit   ?? false,
        stripPublish: opts.stripPublish ?? false,
        stripStore:   opts.stripStore   ?? false,
        withData:     opts.withData     ?? false,
        force:        opts.force        ?? false,
        dryRun:       opts.dryRun       ?? false,
      }, opts.json ?? false);
    });
}
