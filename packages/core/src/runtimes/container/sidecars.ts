/**
 * OS sidecars on the container runtime (Phase 6 D-S): the `workloads` group's
 * create, start, inspect, list, remove, seed, run and output, over the docker
 * CLI. SidecarManager (the kernel) decides what runs (sidecar-spec.ts), for
 * whom, with which tokens, tool grants and mounts, and keeps its record in
 * the `aura.sidecar.spec` label; this file turns that decision into Docker:
 * the `docker create` argv (network, labels, volumes, the inherited App Home
 * and identity, the tools dir, the mount root), the readiness of the image,
 * the boot check and the throwaway seed container.
 *
 * Labels (the actual state, re-learned by `docker ps` after a restart):
 *
 *   aura.parent=<instanceId>  aura.app=<appId>  aura.service=<name>
 *   aura.managed=os           aura.sidecar.template=<template>
 *   aura.sidecar.owner=<sidecar that spawned it, or ->
 *   aura.sidecar.spec=<the kernel's JSON record>
 *
 * `aura.parent` makes the runner's reaper treat it like any sidecar (removed
 * on stop and crash, skipped by orphan adoption). Every docker call is async:
 * dynamic sidecars come in bursts, and the kernel's event loop serves every
 * app at once. Argv is golden (test/golden-workload-args.test.mjs).
 *
 * The runner's facts are handed in (no runtime import of app-manager, D97).
 */
import { execFile } from 'node:child_process';
import type {
  RuntimeManagedWorkload, RuntimePullCredential, RuntimeWorkloadCreate, RuntimeWorkloadRun, RuntimeWorkloadRunResult, RuntimeWorkloadState, RuntimeWorkloads,
} from '../ari.js';
import type { ResolvedSidecarSpec } from '../../app-manager/sidecar-spec.js';
import type { SidecarRuntimeFacts } from './backends.js';
import { containerName, sidecarContainerName } from './names.js';
import { rawSocketArgs } from '../spawn/networkArgs.js';
import { sidecarIdentityArgs } from '../spawn/identityArgs.js';
import { containerHomeMount } from '../spawn/homeArgs.js';
import { LOGICAL_HOME_PATH as SHARED_HOME_PATH } from '../../homes/types.js';
import { MOUNT_ROOT_PATH, MY_TOOLS_PATH } from '../spawn/paths.js';

/** What the sidecar mechanism needs of the container runner. */
export interface ContainerSidecarFacts {
  sidecarRuntime(): SidecarRuntimeFacts;
  mountRootSubpath(consumer: string): string;
  /** D107: the instance's own workload network, ensured with the instance's container and the shell on it. */
  isolatedNetwork(instanceId: string): string;
}

/** The OS-sidecar members of the container module's `workloads` group. */
export type ContainerSidecarOps = Omit<RuntimeWorkloads, 'list' | 'remove' | 'removeOf' | 'exec' | 'logs'>;

const MAX_OUTPUT = 4 * 1024 * 1024;
const PULL_TIMEOUT_MS = 10 * 60_000;
/** How long a fresh sidecar must stay up before its start counts. */
const BOOT_CHECK_MS = 400;

interface DockerResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }

/** Run docker; never rejects — the caller decides what a non-zero exit means. */
function docker(args: string[], opts: { timeoutMs?: number; input?: string; maxBuffer?: number } = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    // Own timer instead of execFile's `timeout`: the docker CLI forwards the
    // SIGTERM to the exec'd process and then exits CLEANLY, so execFile
    // reports no error at all and a timeout would read as success.
    let timedOut = false;
    const child = execFile('docker', args, {
      maxBuffer: opts.maxBuffer ?? MAX_OUTPUT,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: timedOut ? null : e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''),
        timedOut,
        truncated: e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
    });
    let hardKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, opts.timeoutMs ?? 60_000);
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function dockerOk(args: string[], what: string, timeoutMs?: number): Promise<string> {
  const r = await docker(args, { timeoutMs });
  if (r.code !== 0) throw new Error(`${what}: ${r.stderr.trim() || `docker exited ${r.code}`}`);
  return r.stdout;
}

/**
 * `docker pull`, with the credential (if any) in a throwaway auth file that is
 * always removed. A failure carries the registry's words (redacted) as
 * `output`; the kernel tells an auth refusal from it (SidecarManager).
 */
async function pullImage(image: string, cred: RuntimePullCredential | null): Promise<void> {
  const auth = cred ? cred.authFile() : null;
  try {
    const r = await docker([...(auth ? ['--config', auth.dir] : []), 'pull', image], { timeoutMs: PULL_TIMEOUT_MS });
    if (r.code === 0) return;
    const raw = r.stderr.trim() || (r.timedOut ? 'timed out' : `docker exited ${r.code}`);
    const out = cred ? cred.redact(raw) : raw;
    throw Object.assign(new Error(`docker pull ${image}: ${out}`), { output: out });
  } finally {
    auth?.dispose();
  }
}

function volumeArgs(spec: ResolvedSidecarSpec): string[] {
  return spec.volumes.flatMap((v) => ['--mount',
    `type=volume,source=${v.source},target=${v.target}${v.subpath ? `,volume-subpath=${v.subpath}` : ''}`]);
}

/**
 * A tools allowlist dir, mounted the way the runner mounts an app's. `dirKey`
 * is the instance id for the app's own set, or the consumer key
 * `<inst>--<name>` for a sidecar's own.
 */
async function toolArgs(rt: SidecarRuntimeFacts, dirKey: string, image: string): Promise<string[]> {
  const r = await docker(['image', 'inspect', image, '--format', '{{range .Config.Env}}{{println .}}{{end}}']);
  const basePath = r.stdout.split('\n').find((l) => l.startsWith('PATH='))?.slice('PATH='.length)
    ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return [
    ...(rt.toolsMode === 'symlink'
      ? ['--mount', `type=volume,source=${rt.appDataVolume},target=/aura/all-tools,volume-subpath=aura/toolchain/bin,readonly`]
      : []),
    '--mount', `type=volume,source=${rt.appDataVolume},target=${MY_TOOLS_PATH},volume-subpath=aura/runtime/${dirKey}/tools,readonly`,
    '-v', `${rt.workspaceRoot}/packages:/workspace/packages:ro`,
    '--mount', `type=volume,source=${rt.nodeModulesVolume},target=/workspace/node_modules,readonly`,
    '-e', `PATH=${MY_TOOLS_PATH}:${basePath}`,
    '-v', `${rt.workspaceRoot}/os/bashrc.aura.sh:/etc/profile.d/aura-prompt.sh:ro`,
  ];
}

/** The `docker create` argv of one OS sidecar (golden: test/golden-workload-args.test.mjs). */
export async function sidecarCreateArgs(
  req: RuntimeWorkloadCreate, rt: SidecarRuntimeFacts, facts: { mountRootSubpath(consumer: string): string; baseImage: string; network?: string },
): Promise<string[]> {
  const { instanceId, appId, spec } = req;
  const container = sidecarContainerName(instanceId, spec.name);
  const consumer = `${instanceId}--${spec.name}`;
  const identity: Record<string, string> = spec.inheritIdentity ? {
    AURA_APP_ID: appId,
    AURA_INSTANCE_ID: instanceId,
    AURA_SIDECAR_NAME: spec.name,
    AURA_OS_URL: rt.osApiBase,
    OS_API_BASE: rt.osApiBase,
    AURA_SHELL_HOSTNAME: rt.shellHostname,
    ...(req.token ? { AURA_INSTANCE_TOKEN: req.token } : {}),
  } : {};
  // inheritHome: the parent's App Home (D65) the kernel resolved; never a Private Home.
  const homeMount = spec.inheritHome && req.home ? containerHomeMount({ appDataVolume: rt.appDataVolume, home: req.home }) : [];
  const a: string[] = [
    // D107: an isolated sidecar is on its instance's own network only (`facts.network`), else the shared one.
    'create', '--name', container, '--network', facts.network ?? rt.network, '--restart', spec.restart,
    // No raw sockets unless the template's reviewed privileged/NET_RAW asks (spawn/networkArgs.ts, D88 S1).
    ...rawSocketArgs(spec),
    '--label', `aura.parent=${instanceId}`,
    '--label', `aura.app=${appId}`,
    '--label', `aura.service=${spec.name}`,
    '--label', 'aura.managed=os',
    '--label', `aura.sidecar.template=${spec.template}`,
    '--label', `aura.sidecar.owner=${req.owner ?? '-'}`,
    '--label', `aura.sidecar.spec=${req.record}`,
    ...spec.dns.flatMap((d) => ['--dns', d]),
    ...spec.publish.flatMap((p) => ['-p', `${p.host}:${p.container}`]),
    ...volumeArgs(spec),
    // inheritHome: the app's own App Home (spawn/homeArgs.ts): the sidecar doesn't exceed its app.
    ...homeMount,
    // HOME after the template env (a template can't point it elsewhere while
    // the mount is there); identity last: a template env key can't replace
    // the OS's own values.
    ...Object.entries({ ...req.env, ...(spec.inheritHome ? { HOME: SHARED_HOME_PATH } : {}), ...identity })
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...spec.capabilities.flatMap((c) => ['--cap-add', c]),
    ...spec.devices.flatMap((d) => ['--device', d]),
    ...(spec.privileged ? ['--privileged'] : []),
    ...(spec.limits?.memory ? ['--memory', spec.limits.memory] : []),
    ...(spec.limits?.cpus ? ['--cpus', String(spec.limits.cpus)] : []),
    ...(spec.user ? ['--user', spec.user] : []),
    // P5-3: an aura-base sidecar that inherits the app's home is the app's own code: the app's identity.
    ...sidecarIdentityArgs(spec, req.parentIdentity, { appDataVolume: rt.appDataVolume, instanceId, baseImage: facts.baseImage }),
    ...(spec.workdir ? ['--workdir', spec.workdir] : []),
    ...(spec.inheritPermissions && req.permissions?.length ? ['-e', `AURA_PERMISSIONS=${req.permissions.join(',')}`] : []),
  ];
  // inheritTools: the app's own dir (whole set); ownTools: the sidecar's dir.
  if (spec.inheritTools) a.push(...await toolArgs(rt, instanceId, spec.image));
  else if (spec.ownTools) a.push(...await toolArgs(rt, consumer, spec.image));
  if (spec.mounts.own || spec.mounts.inherit) {
    a.push('--mount', `type=volume,source=${rt.appDataVolume},target=${MOUNT_ROOT_PATH},volume-subpath=${facts.mountRootSubpath(consumer)}`,
      '-e', `AURA_MOUNT_ROOT=${MOUNT_ROOT_PATH}`);
  }
  a.push(spec.image, ...spec.command);
  return a;
}

async function inspect(ref: string): Promise<RuntimeWorkloadState | null> {
  const r = await docker(['inspect', '--format', '{{.Name}}\t{{.State.Status}}\t{{json .Config.Labels}}\t{{.RestartCount}}', ref]);
  if (r.code !== 0) return null;
  const [name, state, labels, restarts] = r.stdout.trim().split('\t');
  let parsed: Record<string, string> = {};
  try { parsed = (JSON.parse(labels ?? '{}') ?? {}) as Record<string, string>; } catch { /* no labels */ }
  return { ref: (name ?? ref).replace(/^\//, ''), state: state ?? 'unknown', tags: parsed, restarts: Number(restarts) || 0 };
}

async function lastWords(ref: string): Promise<string> {
  const logs = await docker(['logs', '--tail', '20', ref]);
  return (logs.stdout + logs.stderr).trim();
}

/** The container module's OS-sidecar operations over the runner's facts. */
export function containerSidecars(runner: ContainerSidecarFacts, opts: { baseImage: string }): ContainerSidecarOps {
  const pulls = new Map<string, Promise<void>>();
  return {
    ref: sidecarContainerName,
    async listOf(instanceId) {
      const out = await dockerOk(['ps', '-a',
        '--filter', 'label=aura.managed=os', '--filter', `label=aura.parent=${instanceId}`,
        '--format', '{{.Names}}\t{{.State}}\t{{.Label "aura.sidecar.spec"}}'], 'docker ps');
      return out.split('\n').filter(Boolean).map((line): RuntimeManagedWorkload => {
        const [ref, state, record] = line.split('\t');
        return { ref: ref!, instanceId, state: state ?? 'unknown', ...(record ? { record } : {}) };
      });
    },
    async listManaged() {
      const r = await docker(['ps', '-a', '--filter', 'label=aura.managed=os',
        '--format', '{{.Names}}\t{{.Label "aura.parent"}}\t{{.Label "aura.sidecar.spec"}}']);
      if (r.code !== 0) return null;
      return r.stdout.split('\n').filter(Boolean).map((line): RuntimeManagedWorkload => {
        const [ref, instanceId, record] = line.split('\t') as [string, string, string];
        return { ref, instanceId, ...(record ? { record } : {}) };
      });
    },
    async spawnedBy(instanceId, owner) {
      const out = await dockerOk(['ps', '-aq', '--filter', 'label=aura.managed=os',
        '--filter', `label=aura.parent=${instanceId}`, '--filter', `label=aura.sidecar.owner=${owner}`], 'docker ps');
      return out.split('\n').filter(Boolean);
    },
    inspect,
    storageExists: async (name) => (await docker(['volume', 'inspect', name])).code === 0,
    async prepareImage(image, credential) {
      if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image])).code === 0) return;
      const cred = (await credential?.()) ?? null;
      // A credentialed pull is never shared with an anonymous one (or another source's).
      const key = cred ? `${image}\0${cred.source}` : image;
      let pull = pulls.get(key);
      if (!pull) {
        pull = pullImage(image, cred);
        pulls.set(key, pull);
        void pull.finally(() => pulls.delete(key)).catch(() => undefined);
      }
      await pull;
    },
    async instanceEnv(instanceId) {
      const r = await docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', containerName(instanceId)]);
      const env: Record<string, string> = {};
      for (const line of r.stdout.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
      }
      return env;
    },
    async seed({ instanceId, spec, env }) {
      const rt = { ...runner.sidecarRuntime(), ...(spec.network === 'instance' ? { network: runner.isolatedNetwork(instanceId) } : {}) };
      // aura.mount=1 keeps the throwaway out of sidecar listings; aura.parent
      // lets the reaper remove it if the instance dies mid-seed.
      const args = ['run', '--rm', '--network', rt.network, ...rawSocketArgs(spec), '--label', 'aura.mount=1', '--label', `aura.parent=${instanceId}`,
        ...volumeArgs(spec),
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        ...(spec.user ? ['--user', spec.user] : []),
        ...(spec.workdir ? ['--workdir', spec.workdir] : []),
        spec.image, ...spec.seed!.command];
      const r = await docker(args, { timeoutMs: 10 * 60_000 });
      if (r.code !== 0) throw new Error(`seed for ${spec.name} failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    },
    async create(req) {
      // D107: mandatory isolation is this runtime's to enforce (its feature says so), or the create is refused.
      const network = req.spec.network === 'instance' ? runner.isolatedNetwork(req.instanceId) : undefined;
      const args = await sidecarCreateArgs(req, runner.sidecarRuntime(), {
        mountRootSubpath: (c) => runner.mountRootSubpath(c), baseImage: opts.baseImage, ...(network ? { network } : {}),
      });
      return (await dockerOk(args, `docker create ${sidecarContainerName(req.instanceId, req.spec.name)}`)).trim();
    },
    async start(id, ref) {
      const started = await docker(['start', id]);
      if (started.code !== 0) {
        await docker(['rm', '-f', id]);
        throw new Error(`docker start ${ref}: ${started.stderr.trim()}`);
      }
      // A runtime that dies on boot (bad command, missing config) should fail
      // the spawn with its own words, not leave a corpse behind.
      await new Promise((r) => setTimeout(r, BOOT_CHECK_MS));
      const after = await inspect(ref);
      if (!after || after.state !== 'running') {
        const words = await lastWords(ref);
        await docker(['rm', '-f', ref]);
        throw new Error(`${ref} exited right after start:\n${words || '(no output)'}`);
      }
    },
    async attachInstance(instanceId) {
      runner.isolatedNetwork(instanceId);
    },
    async destroy(ref, o = {}) {
      if (o.quiet) { await docker(['rm', '-f', ref]); return; }
      await dockerOk(['rm', '-f', ref], `docker rm ${ref}`);
    },
    async run(ref, req: RuntimeWorkloadRun): Promise<RuntimeWorkloadRunResult> {
      const r = await docker(['exec',
        ...(req.stdin !== undefined ? ['-i'] : []),
        ...(req.user ? ['--user', req.user] : []),
        ...(req.workdir ? ['--workdir', req.workdir] : []),
        ...Object.entries(req.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        ref, ...req.argv], { timeoutMs: req.timeoutMs, input: req.stdin });
      return { exitCode: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated, timedOut: r.timedOut };
    },
    async output(ref, o) {
      const r = await docker(['logs', '--tail', String(o.tail),
        ...(o.since ? ['--since', o.since] : []),
        ...(o.timestamps ? ['--timestamps'] : []),
        ref]);
      if (r.code !== 0) throw new Error(`docker logs ${ref}: ${r.stderr.trim()}`);
      return { stdout: r.stdout, stderr: r.stderr };
    },
    lastWords,
  };
}
