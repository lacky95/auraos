/**
 * `aura mount` — attach another app's files into THIS app's container.
 *
 * Everything here goes through the shell's HTTP API, never the filesystem.
 * The CLI is normally invoked from inside a sliced container sandbox where
 * only the calling app's own directory is bound, so `/workspace/apps` cannot
 * be walked to discover other apps (same constraint `cap.ts` documents).
 * `GET /api/apps` is the canonical source of truth for what exists.
 *
 * Mounting itself is container-only — a PRoot instance has no `/data` volume
 * mount to receive propagation and the backend answers 409.
 */
import type { Command } from 'commander';
import { stdin, stdout } from 'node:process';
import type { AuraMount } from '@aura/core';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, info, ok, table, warn } from '../lib/format.js';
import {
  promptChoice,
  promptConfirm,
  promptMultiSelect,
  BACK,
  PromptCancelled,
  type MultiSelectMode,
} from '../lib/prompts.js';

// ─── API shapes ────────────────────────────────────────────────────────────

interface MountsResponse {
  capable: boolean;
  reason?: string;
  mounts: AuraMount[];
}
interface AddResponse { ok: true; mount: AuraMount }
interface RemoveResponse { ok: true; removed: string }

interface InstanceLite {
  instanceId: string;
  appId: string;
  state: string;
  inPool?: boolean;
  sandbox?: 'proot' | 'container';
}
interface AppDto {
  manifest: { id: string; name?: string; scopeId?: string; componentType?: string };
  instances: InstanceLite[];
}

const SCOPE_ORDER = ['system', 'global', 'user'];

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Pull the server's own message out of a failed request and return it VERBATIM.
 * The shell wraps every mount error as `{ error: <message> }`, and for an `add`
 * that message is where the privileged helper container's stderr ends up — it
 * is the only debugging signal the user gets, so it must not be reworded or
 * truncated.
 */
function apiError(err: unknown): string {
  const e = err as ShellError;
  if (typeof e?.body === 'string' && e.body.length > 0) {
    try {
      const parsed = JSON.parse(e.body) as { error?: string; message?: string };
      const msg = parsed.error ?? parsed.message;
      if (msg) return e.status ? `${msg} ${color.dim(`(HTTP ${e.status})`)}` : msg;
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
  return api.get<AppDto[]>('/api/apps');
}

async function fetchMounts(instanceId: string): Promise<MountsResponse> {
  return api.get<MountsResponse>(`/api/instances/${encodeURIComponent(instanceId)}/mounts`);
}

/** Loud, non-fatal banner when the host cannot propagate mounts at all. */
function reportCapability(res: MountsResponse): void {
  if (res.capable) return;
  warn(`${color.bold('mounting unavailable on this host')} — ${res.reason ?? 'no reason given'}`);
}

/**
 * Live instances that can be mounted INTO. Mirrors `jump.ts:collectTargets`:
 * warm-pool members are spawn-warmed but not user-attached, and a
 * creating/destroyed instance isn't serving anything.
 */
function collectInstances(apps: AppDto[]): Array<InstanceLite & { appName: string }> {
  const out: Array<InstanceLite & { appName: string }> = [];
  for (const a of apps) {
    for (const inst of a.instances) {
      if (inst.inPool) continue;
      if (inst.state !== 'resumed' && inst.state !== 'paused' && inst.state !== 'started') continue;
      out.push({ ...inst, appName: a.manifest.name ?? a.manifest.id });
    }
  }
  out.sort((x, y) => x.appName.localeCompare(y.appName) || x.instanceId.localeCompare(y.instanceId));
  return out;
}

/**
 * Which instance are we mounting into?
 *   --instance  >  $APP_INSTANCE_ID (set by both runners)  >  interactive pick.
 * The picker path only happens when the CLI runs somewhere that isn't an app
 * sandbox at all — e.g. straight from `aura-shell`.
 */
async function resolveInstance(flag: string | undefined, apps?: AppDto[]): Promise<string> {
  if (flag) return flag;
  const fromEnv = process.env['APP_INSTANCE_ID'];
  if (fromEnv) return fromEnv;

  if (!isTTY()) {
    fail('No target instance: $APP_INSTANCE_ID is unset and this is not a TTY. Pass --instance <id>.');
  }
  const live = collectInstances(apps ?? (await fetchApps()));
  if (live.length === 0) {
    fail('No target instance: $APP_INSTANCE_ID is unset and no live instances were found. Pass --instance <id>.');
  }
  const picked = await promptChoice<string>(
    'Mount into which instance?',
    live.map((i) => ({
      value: i.instanceId,
      label: i.instanceId,
      desc: `${i.appName} · ${i.state}${i.sandbox === 'container' ? '' : color.yellow(` · ${i.sandbox ?? 'proot'} (not mountable)`)}`,
    })),
    0,
    { allowBack: true },
  );
  if (picked === BACK) { info('cancelled'); process.exit(0); }
  return picked;
}

function scopeOf(apps: AppDto[], appId: string): string {
  return apps.find((a) => a.manifest.id === appId)?.manifest.scopeId ?? '-';
}

function scopeColor(scope: string): string {
  if (scope === 'system') return color.magenta(scope);
  if (scope === 'global') return color.cyan(scope);
  if (scope === 'user')   return color.green(scope);
  return color.dim(scope);
}

function printMounts(instanceId: string, mounts: AuraMount[], apps: AppDto[]): void {
  info(`mounts in ${color.bold(instanceId)}`);
  if (mounts.length === 0) {
    console.log(color.dim('  (none)'));
    return;
  }
  const rows = mounts
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => ({
      TARGET: m.targetAppId,
      SCOPE:  scopeColor(scopeOf(apps, m.targetAppId)),
      KIND:   m.kind === 'data' ? color.yellow(m.kind) : m.kind,
      MODE:   m.mode === 'rw' ? color.red(m.mode) : color.green(m.mode),
      PATH:   m.containerPath,
    }));
  console.log(table(rows, ['TARGET', 'SCOPE', 'KIND', 'MODE', 'PATH']));
}

// ─── ls ────────────────────────────────────────────────────────────────────

async function listMounts(opts: { instance?: string }): Promise<void> {
  const apps = await fetchApps();
  const instanceId = await resolveInstance(opts.instance, apps);
  let res: MountsResponse;
  try {
    res = await fetchMounts(instanceId);
  } catch (err) {
    fail(apiError(err));
  }
  reportCapability(res!);
  printMounts(instanceId, res!.mounts ?? [], apps);
}

// ─── add ───────────────────────────────────────────────────────────────────

/**
 * Multi-select over EVERY installed app, all three scopes. Grouping is done
 * with the picker's mode switch ('m'/Tab): mode 0 lists everything with a
 * scope tag, and one further mode per populated scope narrows it down. Check
 * state is shared across modes, so a selection survives switching.
 */
async function pickTargets(apps: AppDto[], mounted: Set<string>, kind: 'source' | 'data'): Promise<string[]> {
  if (!isTTY()) {
    fail('No appId given and this is not a TTY. Pass one or more app ids: `aura mount add <appId>`.');
  }
  const sorted = apps.slice().sort((a, b) => {
    const sa = SCOPE_ORDER.indexOf(a.manifest.scopeId ?? '');
    const sb = SCOPE_ORDER.indexOf(b.manifest.scopeId ?? '');
    return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb) || a.manifest.id.localeCompare(b.manifest.id);
  });
  const toOption = (a: AppDto) => {
    const scope = a.manifest.scopeId ?? '-';
    const already = mounted.has(kind === 'data' ? `${a.manifest.id}:data` : a.manifest.id);
    return {
      value: a.manifest.id,
      label: a.manifest.id,
      tag: already ? color.yellow('mounted') : scopeColor(scope),
      desc: a.manifest.name ?? '',
    };
  };
  const modes: MultiSelectMode<string>[] = [
    { label: 'all scopes', options: sorted.map(toOption) },
  ];
  for (const scope of SCOPE_ORDER) {
    const inScope = sorted.filter((a) => a.manifest.scopeId === scope);
    if (inScope.length > 0) modes.push({ label: scope, options: inScope.map(toOption) });
  }

  const res = await promptMultiSelect<string>(
    `Mount which app's ${kind === 'data' ? 'DATA' : 'source'} into this instance?`,
    modes,
    0,
    { allowBack: true },
  );
  if (res === BACK) { info('cancelled'); return []; }
  return res.selected;
}

async function addMounts(
  appIds: string[],
  opts: { instance?: string; rw?: boolean; data?: boolean },
): Promise<void> {
  const apps = await fetchApps();
  const instanceId = await resolveInstance(opts.instance, apps);

  let existing: MountsResponse;
  try {
    existing = await fetchMounts(instanceId);
  } catch (err) {
    fail(apiError(err));
  }
  // Surface an incapable host BEFORE the user picks anything — every add would
  // fail and the reason is the only actionable information.
  if (!existing!.capable) {
    fail(`mounting unavailable on this host — ${existing!.reason ?? 'no reason given'}`);
  }

  const kind = opts.data ? 'data' : 'source';
  let targets = appIds;
  if (targets.length === 0) {
    targets = await pickTargets(apps, new Set(existing!.mounts.map((m) => m.id)), kind);
    if (targets.length === 0) { info('nothing selected'); return; }
  }

  const mode = opts.rw ? 'rw' : 'ro';
  let failed = 0;
  for (const targetAppId of targets) {
    try {
      const res = await api.post<AddResponse>(
        `/api/instances/${encodeURIComponent(instanceId)}/mounts`,
        { targetAppId, mode, data: opts.data === true },
      );
      const m = res.mount;
      ok(
        `mounted ${color.bold(m.targetAppId)} ` +
        `(${m.kind}, ${m.mode === 'rw' ? color.red(m.mode) : color.green(m.mode)}) → ${color.bold(m.containerPath)}`,
      );
    } catch (err) {
      failed++;
      console.error(`${color.red('✗')} ${targetAppId}: ${apiError(err)}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

// ─── rm ────────────────────────────────────────────────────────────────────

/**
 * Map a user-supplied token to mount ids. A bare appId detaches every mount
 * for that app (source AND data); an explicit `<appId>:data` detaches just
 * that one.
 */
function resolveMountIds(token: string, mounts: AuraMount[]): string[] {
  const exact = mounts.find((m) => m.id === token);
  if (exact) return [exact.id];
  return mounts.filter((m) => m.targetAppId === token).map((m) => m.id);
}

async function removeMounts(
  tokens: string[],
  opts: { instance?: string; all?: boolean },
): Promise<void> {
  const apps = await fetchApps();
  const instanceId = await resolveInstance(opts.instance, apps);

  let res: MountsResponse;
  try {
    res = await fetchMounts(instanceId);
  } catch (err) {
    fail(apiError(err));
  }
  reportCapability(res!);
  const mounts = res!.mounts ?? [];
  if (mounts.length === 0) { info(`no mounts in ${instanceId}`); return; }

  let ids: string[];
  if (opts.all) {
    ids = mounts.map((m) => m.id);
  } else if (tokens.length > 0) {
    ids = [];
    for (const token of tokens) {
      const matched = resolveMountIds(token, mounts);
      if (matched.length === 0) {
        console.error(`${color.red('✗')} ${token} is not mounted into ${instanceId}`);
        process.exitCode = 1;
        continue;
      }
      ids.push(...matched);
    }
    if (ids.length === 0) return;
  } else {
    if (!isTTY()) {
      fail('No appId given and this is not a TTY. Pass one or more app ids, or --all.');
    }
    const picked = await promptMultiSelect<string>(
      `Detach which mounts from ${color.bold(instanceId)}?`,
      [{
        label: 'mounted',
        options: mounts.map((m) => ({
          value: m.id,
          label: m.id,
          tag: m.mode === 'rw' ? color.red(m.mode) : color.green(m.mode),
          desc: m.containerPath,
        })),
      }],
      0,
      { allowBack: true },
    );
    if (picked === BACK) { info('cancelled'); return; }
    ids = picked.selected;
    if (ids.length === 0) { info('nothing selected'); return; }
  }

  for (const id of ids) {
    try {
      // The colon in `<appId>:data` MUST be percent-encoded — it is a legal
      // path character, so an unencoded id would route as a literal segment.
      await api.del<RemoveResponse>(
        `/api/instances/${encodeURIComponent(instanceId)}/mounts/${encodeURIComponent(id)}`,
      );
      ok(`detached ${color.bold(id)} from ${instanceId}`);
    } catch (err) {
      console.error(`${color.red('✗')} ${id}: ${apiError(err)}`);
      process.exitCode = 1;
    }
  }
}

// ─── Registration ──────────────────────────────────────────────────────────

// ─── Interactive wizard ────────────────────────────────────────────────────

/**
 * `aura mount` with no subcommand: a stepped wizard mirroring `aura dev new`
 * (`commands/dev.ts:189-388`). Step array over a shared draft, each step
 * returning advance/back/cancel, one try/catch turning Ctrl-C into a clean
 * exit.
 *
 * Unlike `add`, this MANAGES THE WHOLE SET: rows already mounted come
 * pre-checked, and unchecking one detaches it. That's why it diffs rather than
 * only adding.
 */
interface WizardDraft {
  targetAppId?: string;
  instanceId?: string;
  /** appId → { rw, data } for every checked row. */
  picked?: Map<string, { rw: boolean; data: boolean }>;
}

function divider(): void {
  stdout.write(color.dim('  ────────────────────────────────────────────────────\n'));
}

/** Live, mountable (container) instances of one app. */
function instancesOf(apps: AppDto[], appId: string): Array<InstanceLite & { appName: string }> {
  return collectInstances(apps).filter((i) => i.appId === appId);
}

async function runWizard(): Promise<void> {
  if (!isTTY()) {
    fail('`aura mount` (interactive) needs a TTY. Use `aura mount ls|add|rm` non-interactively.');
  }
  const apps = await fetchApps();
  const draft: WizardDraft = {};
  const currentAppId = process.env['APP_ID'];

  divider();
  console.log(`  ${color.bold('aura')} · mount apps into a container   ${color.dim('— ⌃B back, ^C cancel')}`);
  divider();

  type StepResult = 'advance' | 'back' | 'cancel';
  const steps: Array<{ id: string; run: () => Promise<StepResult> }> = [
    // 1 ─ which app are we mounting INTO. Current app first when we're inside one.
    {
      id: 'target',
      run: async () => {
        const withInstances = apps.filter((a) => instancesOf(apps, a.manifest.id).length > 0);
        if (withInstances.length === 0) fail('No live instances to mount into.');
        withInstances.sort((a, b) => {
          if (a.manifest.id === currentAppId) return -1;
          if (b.manifest.id === currentAppId) return 1;
          return a.manifest.id.localeCompare(b.manifest.id);
        });
        const choices = withInstances.map((a) => {
          const n = instancesOf(apps, a.manifest.id).length;
          const isCurrent = a.manifest.id === currentAppId;
          return {
            value: a.manifest.id,
            label: isCurrent ? `${a.manifest.id} ${color.green('[current]')}` : a.manifest.id,
            desc: `${a.manifest.name ?? ''} · ${n} instance${n === 1 ? '' : 's'}`,
          };
        });
        const startIdx = Math.max(0, choices.findIndex((c) => c.value === draft.targetAppId));
        const v = await promptChoice<string>('Mount into which app?', choices, startIdx, { allowBack: true });
        if (v === BACK) return 'cancel'; // first step → back == cancel
        // Changing target invalidates a previously chosen instance.
        if (v !== draft.targetAppId) delete draft.instanceId;
        draft.targetAppId = v;
        return 'advance';
      },
    },
    // 2 ─ which instance. Skipped silently when unambiguous.
    {
      id: 'instance',
      run: async () => {
        const live = instancesOf(apps, draft.targetAppId!);
        if (live.length === 1) { draft.instanceId = live[0]!.instanceId; return 'advance'; }
        const choices = live.map((i) => ({
          value: i.instanceId,
          label: i.instanceId,
          desc: `${i.state}${i.sandbox === 'container' ? '' : color.yellow(` · ${i.sandbox ?? 'proot'} (not mountable)`)}`,
        }));
        const startIdx = Math.max(0, choices.findIndex((c) => c.value === draft.instanceId));
        const v = await promptChoice<string>('Which instance?', choices, startIdx, { allowBack: true });
        if (v === BACK) return 'back';
        draft.instanceId = v;
        return 'advance';
      },
    },
    // 3 ─ the set of apps to have mounted, with per-row mode.
    {
      id: 'targets',
      run: async () => {
        const existing = await fetchMounts(draft.instanceId!);
        if (!existing.capable) {
          fail(`mounting unavailable on this host — ${existing.reason ?? 'no reason given'}`);
        }
        // Current state, collapsed per app: an app may have BOTH a source and a
        // data mount, which is one row with `data` set.
        const current = new Map<string, { rw: boolean; data: boolean }>();
        for (const m of existing.mounts) {
          const cur = current.get(m.targetAppId) ?? { rw: false, data: false };
          if (m.kind === 'data') cur.data = true;
          if (m.mode === 'rw')   cur.rw   = true;
          current.set(m.targetAppId, cur);
        }
        // Prior pass through this step wins over server state, so going back
        // and forward doesn't discard edits.
        const seed = draft.picked ?? current;

        const sorted = apps
          .filter((a) => a.manifest.id !== draft.targetAppId) // can't mount into itself
          .sort((a, b) => {
            const sa = SCOPE_ORDER.indexOf(a.manifest.scopeId ?? '');
            const sb = SCOPE_ORDER.indexOf(b.manifest.scopeId ?? '');
            return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb) || a.manifest.id.localeCompare(b.manifest.id);
          });
        const toOption = (a: AppDto) => {
          const id = a.manifest.id;
          const st = seed.get(id);
          return {
            value: id,
            label: id,
            tag: current.has(id) ? color.yellow('mounted') : scopeColor(a.manifest.scopeId ?? '-'),
            desc: a.manifest.name ?? '',
            initiallyChecked: seed.has(id),
            flags: {
              r: { label: 'rw',   initial: st?.rw   ?? false },
              d: { label: '+data', initial: st?.data ?? false },
            },
          };
        };
        const modes: MultiSelectMode<string>[] = [
          { label: 'all scopes', options: sorted.map(toOption) },
        ];
        for (const scope of SCOPE_ORDER) {
          const inScope = sorted.filter((a) => a.manifest.scopeId === scope);
          if (inScope.length > 0) modes.push({ label: scope, options: inScope.map(toOption) });
        }

        const res = await promptMultiSelect<string>(
          `Apps mounted into ${color.bold(draft.instanceId!)}   ${color.dim('(unchecking detaches)')}`,
          modes, 0, { allowBack: true },
        );
        if (res === BACK) return 'back';
        const picked = new Map<string, { rw: boolean; data: boolean }>();
        for (const id of res.selected) {
          const f = res.flags.get(id) ?? {};
          picked.set(id, { rw: f['r'] === true, data: f['d'] === true });
        }
        draft.picked = picked;
        return 'advance';
      },
    },
    // 4 ─ show the diff and apply.
    {
      id: 'confirm',
      run: async () => {
        const existing = await fetchMounts(draft.instanceId!);
        const plan = planChanges(existing.mounts, draft.picked!);
        if (plan.adds.length === 0 && plan.removes.length === 0) {
          info('no changes');
          return 'cancel';
        }
        divider();
        console.log(`  ${color.bold('Changes')} for ${color.bold(draft.instanceId!)}`);
        divider();
        for (const a of plan.adds) {
          console.log(`  ${color.green('+')} ${a.appId}${a.data ? color.dim(':data') : ''}  ${a.rw ? color.yellow('rw') : color.dim('ro')}`);
        }
        for (const r of plan.removes) console.log(`  ${color.red('-')} ${r}`);
        divider();
        const proceed = await promptConfirm('Apply?', true, { allowBack: true });
        if (proceed === BACK) return 'back';
        if (!proceed) return 'cancel';
        await applyChanges(draft.instanceId!, plan);
        return 'advance';
      },
    },
  ];

  try {
    let i = 0;
    while (i < steps.length) {
      const r = await steps[i]!.run();
      if (r === 'cancel') { info('cancelled'); return; }
      if (r === 'back') {
        // Hop back over the instance step when it auto-advanced, so ⌃B from
        // the target list lands on the app picker rather than a skipped screen.
        do { i = Math.max(0, i - 1); }
        while (i > 0 && steps[i]!.id === 'instance'
               && instancesOf(apps, draft.targetAppId!).length === 1);
        continue;
      }
      i++;
    }
  } catch (err) {
    if (err instanceof PromptCancelled) { info('cancelled'); return; }
    throw err;
  }
}

interface ChangePlan {
  adds: Array<{ appId: string; rw: boolean; data: boolean }>;
  /** mountIds to DELETE. */
  removes: string[];
}

/**
 * Diff desired state against what's mounted. A mode change (ro↔rw) can't be
 * done in place — POSTing over a live mount returns 409 — so it becomes a
 * remove followed by an add.
 */
function planChanges(
  existing: AuraMount[],
  desired: Map<string, { rw: boolean; data: boolean }>,
): ChangePlan {
  const plan: ChangePlan = { adds: [], removes: [] };
  const byApp = new Map<string, AuraMount[]>();
  for (const m of existing) {
    byApp.set(m.targetAppId, [...(byApp.get(m.targetAppId) ?? []), m]);
  }

  for (const [appId, want] of desired) {
    const have = byApp.get(appId) ?? [];
    const haveSource = have.find((m) => m.kind === 'source');
    const haveData   = have.find((m) => m.kind === 'data');

    if (!haveSource) plan.adds.push({ appId, rw: want.rw, data: false });
    else if (haveSource.mode !== (want.rw ? 'rw' : 'ro')) {
      plan.removes.push(haveSource.id);
      plan.adds.push({ appId, rw: want.rw, data: false });
    }

    if (want.data && !haveData) plan.adds.push({ appId, rw: want.rw, data: true });
    else if (want.data && haveData && haveData.mode !== (want.rw ? 'rw' : 'ro')) {
      plan.removes.push(haveData.id);
      plan.adds.push({ appId, rw: want.rw, data: true });
    } else if (!want.data && haveData) plan.removes.push(haveData.id);
  }

  // Anything mounted but no longer desired.
  for (const m of existing) {
    if (!desired.has(m.targetAppId) && !plan.removes.includes(m.id)) plan.removes.push(m.id);
  }
  return plan;
}

/**
 * There is no bulk endpoint, so this is N requests and NOT atomic — a failure
 * partway leaves a partial set. Report each outcome rather than implying the
 * whole plan applied.
 */
async function applyChanges(instanceId: string, plan: ChangePlan): Promise<void> {
  let failed = 0;
  // Removes first: a mode change is remove+add on the same path, and doing the
  // add first would collide with the live mount.
  for (const id of plan.removes) {
    try {
      await api.del<RemoveResponse>(`/api/instances/${encodeURIComponent(instanceId)}/mounts/${encodeURIComponent(id)}`);
      ok(`detached ${id}`);
    } catch (err) { failed++; warn(`detach ${id}: ${apiError(err)}`); }
  }
  for (const a of plan.adds) {
    try {
      const res = await api.post<AddResponse>(`/api/instances/${encodeURIComponent(instanceId)}/mounts`, {
        targetAppId: a.appId, mode: a.rw ? 'rw' : 'ro', data: a.data,
      });
      ok(`mounted ${a.appId}${a.data ? ':data' : ''} at ${color.bold(res.mount.containerPath)}`);
    } catch (err) { failed++; warn(`mount ${a.appId}: ${apiError(err)}`); }
  }
  if (failed > 0) fail(`${failed} of ${plan.adds.length + plan.removes.length} change(s) failed — state is partial`);
}

/** Turn a cancelled picker into a clean exit instead of a stack trace. */
function guard<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof PromptCancelled) { info('cancelled'); return; }
      throw err;
    }
  };
}

interface MountOpts { instance?: string; rw?: boolean; data?: boolean; all?: boolean }

/**
 * Read the effective options for a subcommand.
 *
 * `--instance` is declared on BOTH `mount` and its subcommands so that either
 * position parses. Commander resolves `aura mount ls --instance x` against the
 * PARENT's declaration and leaves the subcommand's own opts empty — verified,
 * not assumed — so reading `cmd.opts()` here would silently ignore the flag and
 * operate on $APP_INSTANCE_ID instead. `optsWithGlobals()` merges the ancestors
 * and is correct for both positions.
 */
function effectiveOpts(cmd: Command): MountOpts {
  return cmd.optsWithGlobals() as MountOpts;
}

export function registerMount(program: Command): void {
  const mount = program
    .command('mount')
    .description(
      "Mount another app's files into this app's container, live and without a restart. " +
      'Read-only by default. Container sandboxes only.',
    )
    .option('--instance <id>', 'Target instance (default: $APP_INSTANCE_ID)')
    // Bare `aura mount` opens the interactive wizard: pick a target app and
    // instance, then manage its whole mount set on one screen. `ls` stays
    // available explicitly for scripting and non-TTY use.
    .action(guard(async () => { await runWizard(); }));

  mount
    .command('ls')
    .alias('list')
    .description('List what is currently mounted into an instance.')
    .option('--instance <id>', 'Target instance (default: $APP_INSTANCE_ID)')
    .action(guard(async (_opts: MountOpts, cmd: Command) => { await listMounts(effectiveOpts(cmd)); }));

  mount
    .command('add [appId...]')
    .description(
      'Mount one or more apps into the target instance. With no appId, opens an ' +
      'interactive picker over every installed app (system/global/user — switch scope with m).',
    )
    .option('--rw', 'Mount read-WRITE (default: read-only)')
    .option('--data', "Mount the target's data dir instead of its source")
    .option('--instance <id>', 'Target instance (default: $APP_INSTANCE_ID)')
    .action(guard(async (appIds: string[], _opts: MountOpts, cmd: Command) => {
      await addMounts(appIds ?? [], effectiveOpts(cmd));
    }));

  mount
    .command('rm [appId...]')
    .alias('remove')
    .description(
      'Detach mounts. A bare appId detaches both its source and data mounts; ' +
      'pass `<appId>:data` for just the data one. With no args, opens a picker.',
    )
    .option('--all', 'Detach every mount from the instance')
    .option('--instance <id>', 'Target instance (default: $APP_INSTANCE_ID)')
    .action(guard(async (tokens: string[], _opts: MountOpts, cmd: Command) => {
      await removeMounts(tokens ?? [], effectiveOpts(cmd));
    }));
}
