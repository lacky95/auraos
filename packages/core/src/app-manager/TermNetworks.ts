import { execFileSync } from 'node:child_process';

/**
 * The private Terminal networks (D58): one internal Docker network per user,
 * `aura-term-<userId>`, shared only by that user's System Terminals and the
 * shell. A Terminal's own servers (PTY, MCP, session control) listen only on
 * its address there, so no app can connect to them; the shell dials that
 * address. The Terminal also stays on the shared app network for its
 * outgoing traffic (spawn/networkArgs.ts).
 *
 * Created lazily, on a user's first Terminal spawn; the shell joins each one
 * when it is created and again at boot (`joinExisting`), since a recreated
 * shell container starts on its compose networks only. Never removed: a
 * user's network outlives their Terminals.
 *
 * Network names stay inside the container runtime (D85 A7): nothing outside
 * it builds or reads them.
 */

/** Label on a Terminal network: the user it belongs to. */
export const TERM_NETWORK_USER_LABEL = 'aura.term.user';
/** Label on a Terminal container: the private network its servers listen on. */
export const TERM_NETWORK_CONTAINER_LABEL = 'aura.term.net';

const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_RE = /^aura-term-[a-z0-9][a-z0-9._-]{0,63}$/;
const IPV4_CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

export interface TermNetwork {
  /** `aura-term-<userId>`. */
  name: string;
  /** Its IPv4 subnet (CIDR): the Terminal listens on its address inside it. */
  subnet: string;
}

/** Runs the docker CLI: stdout, or a throw (with `stderr`) on a non-zero exit. */
export type DockerCli = (args: string[]) => string;

const dockerCli: DockerCli = (args) => execFileSync('docker', args, {
  encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
});

/** The private network of `userId`. Throws for an id that can't name one. */
export function termNetworkName(userId: string): string {
  if (!USER_ID_RE.test(userId)) throw new Error(`no Terminal network for user id ${JSON.stringify(userId)}`);
  return `aura-term-${userId}`;
}

const errText = (err: unknown): string =>
  String((err as { stderr?: string }).stderr ?? '') + String((err as Error).message ?? '');

interface Inspected { internal: boolean; user: string | undefined; subnets: string[] }

export class TermNetworks {
  constructor(
    /** The shell's own container (id or name); null when unknown. */
    private readonly shellRef: () => string | null,
    private readonly docker: DockerCli = dockerCli,
  ) {}

  /**
   * The user's network, created when missing, with the shell joined. Throws
   * (the Terminal spawn then fails closed, never falling back to the shared
   * network) when it can't be made, isn't `--internal`, belongs to another
   * user, has no IPv4 subnet, or the shell can't join it.
   */
  ensure(userId: string): TermNetwork {
    const name = termNetworkName(userId);
    let net = this.inspect(name);
    if (!net) {
      try {
        this.docker(['network', 'create', '--internal', '--label', `${TERM_NETWORK_USER_LABEL}=${userId}`, name]);
        console.log(`[TermNetworks] created ${name}`);
      } catch (err) {
        // Another spawn may have created it meanwhile; the inspect below decides.
        if (!/already exists/i.test(errText(err))) throw new Error(`cannot create ${name}: ${errText(err).trim()}`);
      }
      net = this.inspect(name);
      if (!net) throw new Error(`${name} is missing after create`);
    }
    if (!net.internal) throw new Error(`${name} exists but is not an internal network; refusing to put a Terminal on it`);
    if (net.user !== userId) throw new Error(`${name} exists but is not labelled ${TERM_NETWORK_USER_LABEL}=${userId}; refusing to use it`);
    const subnet = net.subnets.find((s) => IPV4_CIDR_RE.test(s));
    if (!subnet) throw new Error(`${name} has no IPv4 subnet`);
    this.joinShell(name);
    return { name, subnet };
  }

  /**
   * At boot: the shell joins every existing Terminal network it is not on,
   * so adopted Terminals are reachable before the first health probe.
   * Best-effort per network; a failure is logged and leaves that user's
   * Terminals unreachable (closed), never exposed.
   */
  joinExisting(): void {
    let names: string[];
    try {
      names = this.docker(['network', 'ls', '--filter', `label=${TERM_NETWORK_USER_LABEL}`, '--format', '{{.Name}}'])
        .split('\n').map((s) => s.trim()).filter((n) => NAME_RE.test(n));
    } catch (err) {
      console.warn(`[TermNetworks] listing Terminal networks failed: ${errText(err).trim()}`);
      return;
    }
    for (const name of names) {
      try {
        const net = this.inspect(name);
        if (!net?.internal) { console.warn(`[TermNetworks] ${name} is not internal; not joined`); continue; }
        this.joinShell(name);
      } catch (err) {
        console.warn(`[TermNetworks] joining ${name} failed: ${(err as Error).message}`);
      }
    }
  }

  private inspect(name: string): Inspected | null {
    let out: string;
    try {
      out = this.docker(['network', 'inspect', '-f',
        `{{.Internal}}\t{{index .Labels "${TERM_NETWORK_USER_LABEL}"}}\t{{range .IPAM.Config}}{{.Subnet}} {{end}}`, name]);
    } catch (err) {
      if (/no such network|not found/i.test(errText(err))) return null;
      throw new Error(`cannot inspect ${name}: ${errText(err).trim()}`);
    }
    const [internal, user, subnets] = out.trim().split('\t');
    return {
      internal: internal === 'true',
      user: user && user !== '<no value>' ? user : undefined,
      subnets: (subnets ?? '').split(' ').map((s) => s.trim()).filter(Boolean),
    };
  }

  private joinShell(name: string): void {
    const shell = this.shellRef();
    if (!shell) throw new Error(`the shell's own container is unknown; cannot join ${name}`);
    const joined = this.docker(['inspect', '-f', '{{json .NetworkSettings.Networks}}', shell]);
    const nets = JSON.parse(joined.trim() || '{}') as Record<string, unknown> | null;
    if (nets && Object.hasOwn(nets, name)) return;
    try {
      this.docker(['network', 'connect', name, shell]);
      console.log(`[TermNetworks] the shell joined ${name}`);
    } catch (err) {
      if (!/already exists|already attached/i.test(errText(err))) throw new Error(`the shell cannot join ${name}: ${errText(err).trim()}`);
    }
  }
}
