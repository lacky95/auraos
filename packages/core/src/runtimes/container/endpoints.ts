/**
 * The container module's `endpoints` group (5b-2 D-P): port exposure through
 * forwarder containers, moved here from PortManager unchanged. PortManager
 * keeps the policy (ids, declarations, replay, reaping dead owners); this
 * file owns the Docker mechanism.
 *
 * A forwarder is a tiny throwaway container running a node TCP pipe proxy
 * (`node -e`, node is guaranteed in `aura-base`). It is parameterised entirely
 * through env vars, so no user-controlled string is ever interpolated into a
 * shell.
 *
 *   into <targetApp>: the forwarder JOINS the target's network namespace
 *     (`--network container:aura-<target>`) and listens on the target's
 *     127.0.0.1:<port>, forwarding to `aura-<source>:<sourcePort>` over
 *     aura-net. Nothing new is published anywhere — the port appears only on
 *     the target's own loopback.
 *
 *   host: the forwarder stays on aura-net and docker PUBLISHES a host port
 *     (`-p <bindAddr>:<hostPort>:5000`) that forwards to
 *     `aura-<source>:<sourcePort>`. Default bind is 127.0.0.1 (host loopback
 *     only); 0.0.0.0 or a NIC IP must be asked for explicitly.
 *
 * Docker is authoritative for what runs: each forwarder carries `aura.port=1`
 * (so the generic sidecar reaper skips it) plus `aura.port.spec=<json>` holding
 * its full record, so a shell restart rehydrates the live set with one
 * `docker ps`. The `aura.parent=<ownerInstanceId>` label ties a forwarder to
 * its owner: the runner's `reapSiblingsOf` removes it when the owner restarts.
 */
import { execFileSync } from 'node:child_process';
import type { RuntimeEndpoints, RuntimeExposure } from '../ari.js';
import { containerName as instanceContainer } from './names.js';

/** The runtime facts a forwarder is created with (the container runner's). */
export interface ForwarderFacts {
  /** The image (node is in it): the base image. */
  image: string;
  /** The shared app network a `host` forwarder joins. */
  network: string;
  /** The raw-socket flags every container of this runtime gets (`--cap-drop NET_RAW`). */
  rawSocketArgs: readonly string[];
}

/**
 * The forwarder body. A bidirectional TCP pipe: everything the listener accepts
 * is spliced to a fresh upstream connection and back. Target host/port are
 * re-resolved per connection, so a source container that restarts (new IP, same
 * name) keeps working. Kept to a single line so it survives `node -e` intact.
 */
const PROXY_JS =
  'const net=require("net");' +
  'net.createServer(c=>{' +
  'const u=net.connect(+process.env.PF_TARGET_PORT,process.env.PF_TARGET_HOST);' +
  'c.pipe(u);u.pipe(c);' +
  'const k=()=>{c.destroy();u.destroy()};c.on("error",k);u.on("error",k);' +
  '}).listen(+process.env.PF_LISTEN_PORT,process.env.PF_LISTEN_HOST);';

function sanitizeToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function forwarderName(kind: RuntimeExposure['kind'], ownerInstanceId: string, bindAddr: string, port: number): string {
  if (kind === 'host') return `aura-porth--${sanitizeToken(bindAddr)}--${port}`;
  return `aura-port--${sanitizeToken(ownerInstanceId)}--${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const s = e?.stderr ? e.stderr.toString() : '';
  return (s || e?.message || String(err)).trim();
}

function isContainerRunning(name: string): boolean {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' });
    return out.trim() === 'true';
  } catch { return false; }
}

function containerLogs(name: string): string {
  try {
    return execFileSync('docker', ['logs', '--tail', '20', name],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, encoding: 'utf-8' }).trim();
  } catch { return ''; }
}

function forceRemove(name: string): void {
  execFileSync('docker', ['rm', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
}

export function containerEndpoints(facts: () => ForwarderFacts): RuntimeEndpoints {
  return {
    list() {
      let out = '';
      try {
        out = execFileSync(
          'docker',
          ['ps', '-a', '--filter', 'label=aura.port=1', '--format', '{{.Label "aura.port.spec"}}'],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, encoding: 'utf-8' },
        );
      } catch (err) {
        console.warn(`[PortManager] snapshot failed: ${(err as Error).message}`);
        return [];
      }
      const exposes: RuntimeExposure[] = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        try {
          exposes.push(JSON.parse(line) as RuntimeExposure);
        } catch {
          /* a forwarder without a parseable spec label — ignore */
        }
      }
      return exposes;
    },

    async expose(req) {
      const { image, network, rawSocketArgs } = facts();
      const { id, kind, ownerInstanceId, port } = req;
      const bindAddr = req.bindAddr ?? '127.0.0.1';
      const containerName = forwarderName(kind, ownerInstanceId, bindAddr, port);
      const record: RuntimeExposure = {
        id, kind, ownerInstanceId,
        sourceAppId: req.sourceAppId, sourceInstanceId: req.sourceInstanceId,
        sourcePort: req.sourcePort, port,
        ...(kind === 'host' ? { bindAddr } : {}),
        sticky: req.sticky,
        containerName,
        createdAt: new Date().toISOString(),
      };
      const labels = [
        '--label', 'aura.port=1',
        '--label', `aura.parent=${ownerInstanceId}`,
        '--label', `aura.app=${req.sourceAppId}`,
        '--label', `aura.port.spec=${JSON.stringify(record)}`,
      ];
      const env = [
        '-e', `PF_TARGET_HOST=${instanceContainer(req.sourceInstanceId)}`,
        '-e', `PF_TARGET_PORT=${req.sourcePort}`,
      ];

      let args: string[];
      if (kind === 'into') {
        args = [
          'create', '--name', containerName,
          '--network', `container:${instanceContainer(ownerInstanceId)}`,
          ...rawSocketArgs,
          '--restart', 'unless-stopped',
          ...labels,
          ...env,
          '-e', 'PF_LISTEN_HOST=127.0.0.1',
          '-e', `PF_LISTEN_PORT=${port}`,
          image, 'node', '-e', PROXY_JS,
        ];
      } else {
        // Docker publishes in the daemon host's network namespace. A Node bind
        // probe here would test the shell container instead, falsely rejecting
        // host NIC addresses with EADDRNOTAVAIL (and missing real host conflicts).
        // Let Docker's atomic bind operation be the authority.
        args = [
          'create', '--name', containerName,
          '--network', network,
          ...rawSocketArgs,
          '-p', `${bindAddr}:${port}:5000`,
          '--restart', 'unless-stopped',
          ...labels,
          ...env,
          '-e', 'PF_LISTEN_HOST=0.0.0.0',
          '-e', 'PF_LISTEN_PORT=5000',
          image, 'node', '-e', PROXY_JS,
        ];
      }

      let createdId: string | undefined;
      try {
        // Separate create/start so a failed host bind can be cleaned up by its
        // exact new ID. Never delete a pre-existing container on a name conflict.
        createdId = execFileSync('docker', args,
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, encoding: 'utf-8' }).toString().trim();
        execFileSync('docker', ['start', createdId],
          { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      } catch (err) {
        let msg = stderrOf(err);
        if (createdId) {
          try { forceRemove(createdId); }
          catch (cleanupError) { msg += `; forwarder cleanup failed: ${stderrOf(cleanupError)}`; }
        }
        throw new Error(/already in use|already allocated|Conflict/i.test(msg) ? `${id} conflicts: ${msg}` : `could not start forwarder: ${msg}`);
      }

      // The proxy can bind-fail INSIDE the netns (e.g. the port is already taken
      // there) and exit after `docker start` has already returned success. Confirm
      // it is still up; if not, surface its logs and clean up.
      await sleep(400);
      if (!isContainerRunning(containerName)) {
        const logs = containerLogs(containerName);
        forceRemove(containerName);
        throw new Error(`forwarder for ${id} exited immediately: ${logs || '(no output)'}`);
      }
      return record;
    },

    remove: (name) => forceRemove(name),
  };
}
