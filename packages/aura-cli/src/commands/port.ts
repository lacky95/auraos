/**
 * `aura port` — expose one app's TCP port onto another app's loopback, or
 * publish it on the real host. Everything goes through the shell HTTP API.
 *
 *   aura port ls [app]
 *   aura port expose <srcApp>:<port> --into <targetApp> [--port <n>] [--sticky]
 *   aura port expose <srcApp>:<port> --host [<addr>] [--host-port <n>] [--sticky]
 *   aura port rm <ownerApp> <portId>
 *
 * The one-PC bridge: a browser (or any localhost-bound client) in <targetApp>
 * reaches <srcApp> at `http://localhost:<port>`, no restart, isolation kept by
 * default.
 */
import { Option, type Command } from 'commander';
import { api, type ShellError } from '../lib/client.js';
import { color, fail, ok, table } from '../lib/format.js';

// ─── API shapes ──────────────────────────────────────────────────────────────

type PortExposeKind = 'into' | 'host';
interface AuraPortExpose {
  id: string;
  kind: PortExposeKind;
  ownerInstanceId: string;
  sourceAppId: string;
  sourceInstanceId: string;
  sourcePort: number;
  port: number;
  bindAddr?: string;
  sticky: boolean;
  containerName: string;
  createdAt: string;
}
interface PortsResponse { ports: AuraPortExpose[] }
interface ExposeResponse { ok: true; port: AuraPortExpose }

interface InstanceLite { instanceId: string; appId: string; state: string; inPool?: boolean }
interface AppDto {
  manifest: { id: string; name?: string };
  instances: InstanceLite[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pull the shell's own error message out of a failed request, verbatim. */
function apiError(err: unknown): string {
  const e = err as ShellError;
  if (typeof e?.body === 'string' && e.body.length > 0) {
    try {
      const parsed = JSON.parse(e.body) as { error?: string; message?: string };
      const msg = parsed.error ?? parsed.message;
      if (msg) return e.status ? `${msg} ${color.dim(`(HTTP ${e.status})`)}` : msg;
    } catch { /* not JSON */ }
    return e.status ? `HTTP ${e.status}: ${e.body}` : e.body;
  }
  return e instanceof Error ? e.message : String(err);
}

async function fetchApps(): Promise<AppDto[]> {
  return api.get<AppDto[]>('/api/apps');
}

/** Running instances across all apps (skip warm-pool spares). */
function runningInstances(apps: AppDto[]): Array<InstanceLite & { appName: string }> {
  const out: Array<InstanceLite & { appName: string }> = [];
  for (const app of apps) {
    for (const inst of app.instances) {
      if (inst.inPool) continue;
      out.push({ ...inst, appName: app.manifest.name ?? app.manifest.id });
    }
  }
  return out;
}

/** First running instance of an app, or fail with a clear message. */
function resolveAppInstance(apps: AppDto[], appId: string): string {
  const inst = runningInstances(apps).find((i) => i.appId === appId);
  if (!inst) fail(`No running instance of ${appId}. Start it first.`);
  return inst!.instanceId;
}

/** Split `<app>:<port>` on the LAST colon (app ids contain none, but be safe). */
function parseSourcePort(token: string): { app: string; port: number } {
  const idx = token.lastIndexOf(':');
  if (idx <= 0) fail(`Expected <sourceApp>:<port>, got '${token}'`);
  const app = token.slice(0, idx);
  const port = Number(token.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid port in '${token}'`);
  return { app, port };
}

// ─── Commands ────────────────────────────────────────────────────────────────

interface ExposeOpts { into?: string; host?: string | boolean; port?: string; hostPort?: string; sticky?: boolean }

async function exposeCmd(sourceSpec: string, opts: ExposeOpts): Promise<void> {
  const hasInto = typeof opts.into === 'string';
  const hasHost = opts.host !== undefined;
  if (hasInto === hasHost) fail('Pass exactly one of --into <targetApp> or --host [addr].');

  const { app: sourceApp, port: sourcePort } = parseSourcePort(sourceSpec);
  const apps = await fetchApps();

  if (hasInto) {
    const targetInstance = resolveAppInstance(apps, opts.into!);
    // sanity: the source must be running too, so the error is friendly not a 500
    resolveAppInstance(apps, sourceApp);
    try {
      const res = await api.post<ExposeResponse>(`/api/instances/${encodeURIComponent(targetInstance)}/ports`, {
        kind: 'into',
        sourceAppId: sourceApp,
        sourcePort,
        port: opts.port ? Number(opts.port) : undefined,
        sticky: opts.sticky === true,
      });
      const e = res.port;
      ok(`${sourceApp}:${sourcePort} → ${opts.into} localhost:${e.port}  ${color.dim(`(${e.id}${e.sticky ? ', sticky' : ''})`)}`);
    } catch (err) { fail(apiError(err)); }
    return;
  }

  // host
  const bindAddr = typeof opts.host === 'string' ? opts.host : '127.0.0.1';
  const sourceInstance = resolveAppInstance(apps, sourceApp);
  try {
    const res = await api.post<ExposeResponse>(`/api/instances/${encodeURIComponent(sourceInstance)}/ports`, {
      kind: 'host',
      sourcePort,
      hostPort: opts.hostPort ? Number(opts.hostPort) : undefined,
      bindAddr,
      sticky: opts.sticky === true,
    });
    const e = res.port;
    ok(`${sourceApp}:${sourcePort} → host ${e.bindAddr}:${e.port}  ${color.dim(`(${e.id}${e.sticky ? ', sticky' : ''})`)}`);
  } catch (err) { fail(apiError(err)); }
}

async function lsCmd(appFilter?: string): Promise<void> {
  const apps = await fetchApps();
  const instances = runningInstances(apps).filter((i) => !appFilter || i.appId === appFilter);

  const rows: Array<Record<string, string>> = [];
  for (const inst of instances) {
    let ports: AuraPortExpose[] = [];
    try {
      ports = (await api.get<PortsResponse>(`/api/instances/${encodeURIComponent(inst.instanceId)}/ports`)).ports;
    } catch { /* instance may have vanished mid-loop */ }
    for (const e of ports) {
      rows.push({
        OWNER: inst.appId,
        ID: e.id,
        KIND: e.kind,
        SOURCE: `${e.sourceAppId}:${e.sourcePort}`,
        LISTEN: e.kind === 'host' ? `host ${e.bindAddr}:${e.port}` : `target 127.0.0.1:${e.port}`,
        STICKY: e.sticky ? 'yes' : '',
      });
    }
  }
  if (rows.length === 0) { console.log(color.dim('no port exposes')); return; }
  console.log(table(rows, ['OWNER', 'ID', 'KIND', 'SOURCE', 'LISTEN', 'STICKY']));
}

async function rmCmd(ownerApp: string, portId: string): Promise<void> {
  const apps = await fetchApps();
  const ownerInstance = resolveAppInstance(apps, ownerApp);
  try {
    await api.del(`/api/instances/${encodeURIComponent(ownerInstance)}/ports/${encodeURIComponent(portId)}`);
    ok(`removed ${portId} from ${ownerApp}`);
  } catch (err) { fail(apiError(err)); }
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerPort(program: Command): void {
  const port = program
    .command('port')
    .description('Expose an app\'s TCP port onto another app\'s loopback, or publish it on the host.');

  port
    .command('ls [app]')
    .alias('list')
    .description('List port exposes (optionally filtered to one app).')
    .action(async (app?: string) => { await lsCmd(app); });

  port
    .command('expose <sourceApp:port>')
    .description('Expose <sourceApp>:<port> into a target app\'s localhost, or onto the host.')
    .option('--into <targetApp>', 'Make the port appear on this app\'s 127.0.0.1')
    .addOption(new Option('--host [addr]', 'Publish on the host (default bind 127.0.0.1)'))
    .option('--port <n>', 'Listen port inside the target (into; default = source port)')
    .option('--host-port <n>', 'Published host port (host; default = source port)')
    .option('--sticky', 'Persist so it is re-established when the owner restarts')
    .action(async (sourceSpec: string, opts: ExposeOpts) => { await exposeCmd(sourceSpec, opts); });

  port
    .command('rm <ownerApp> <portId>')
    .alias('remove')
    .description('Remove an expose (portId from `aura port ls`, e.g. into-5173).')
    .action(async (ownerApp: string, portId: string) => { await rmCmd(ownerApp, portId); });
}
