/**
 * Capability definitions (SF-2): what `aura cap install <tool>` installs into
 * the shared toolchain, as data the master executes, never as shell.
 *
 * A definition comes only from a trusted registry: the release tree's
 * `.aura/capabilities.yaml` (the built-in registry, same trust as the code),
 * or an entry the owner approved when it was added (CapabilityRegistryStore,
 * sealed and digest-bound). A client request names a capability; it never
 * carries a definition.
 *
 * Sources:
 *   builtin  a binary already in the image (`binary_path`)
 *   apt      one Debian package from the signed archive (`package`)
 *   npm      one npm package from the default registry (`package`)
 *   steps    a fixed set of structured steps (below), each an argv or a file
 *            write the master performs; there is no free-form command
 *
 * `package_root` (optional, any source): the directory the binary must run
 * from, copied whole into the toolchain and granted as one unit — for tools
 * that find their resources relative to their own executable (Codex).
 * `binary_path`, when given, must lie inside it.
 *
 * Steps (each a one-key map in YAML):
 *   apt: [names]                          verified apt-get install
 *   download: {url, sha256, to, mode?}    one https file, checked against sha256
 *   extract: {url, sha256, format, to, strip?, members?, subdir?, unless_exists?}
 *                                         an https archive (tar.gz|zip), checked, unpacked
 *   deb: {url, sha256}                    a checked .deb, installed with apt
 *   file: {path, content, mode}           write a file (a shim)
 *   symlink: {target, path}
 *   mkdir: [paths]
 *   readable: path                        `chmod -R a+rX`
 *
 * Every write lands under CAPABILITY_WRITE_ROOTS; every name, path, URL and
 * digest is validated here, so a definition cannot carry an option, a shell
 * word, a traversal or a plain-http source. `capabilityDigest()` is what an
 * approval binds.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export type CapabilitySourceKind = 'builtin' | 'apt' | 'npm' | 'steps';

export type CapabilityStep =
  | { apt: string[] }
  | { download: { url: string; sha256: string; to: string; mode?: string } }
  | { extract: { url: string; sha256: string; format: 'tar.gz' | 'zip'; to: string; strip?: number; members?: string[]; subdir?: string; unless_exists?: string } }
  | { deb: { url: string; sha256: string } }
  | { file: { path: string; content: string; mode: string } }
  | { symlink: { target: string; path: string } }
  | { mkdir: string[] }
  | { readable: string };

export interface CapabilityDefinition {
  source: CapabilitySourceKind;
  binary?: string;
  binary_path?: string;
  package?: string;
  steps?: CapabilityStep[];
  sidecars?: string[];
  package_root?: string;
  description?: string;
}

export class CapabilityDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityDefinitionError';
  }
}

/** Where a definition may write. Everything else in the master is off limits. */
export const CAPABILITY_WRITE_ROOTS: readonly string[] = ['/usr/local/bin/', '/usr/local/lib/', '/home/aura/.aura/'];

export const CAPABILITY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A Debian package name (Policy 5.6.7); shared with base-install. */
export const DEBIAN_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]{1,63}$/;
const FILE_SUFFIX_RE = /\.(deb|udeb|ddeb|dsc|changes|buildinfo)$/;
/** An npm package from the default registry, optionally `@version`: no URL, git, file or tarball spec. */
const NPM_PACKAGE_RE = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}(@[0-9A-Za-z][0-9A-Za-z.+-]{0,63})?$/;
const BINARY_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PATH_RE = /^\/[A-Za-z0-9._+@/-]{1,511}$/;
const MEMBER_RE = /^[A-Za-z0-9._+@-][A-Za-z0-9._+@/-]{0,255}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MODE_RE = /^0?[0-7]{3}$/;
const MAX_STEPS = 32;
const MAX_FILE = 64 * 1024;

/** A Debian package name apt cannot mistake for an option, a file or a remove. */
export const isDebianPackageName = (p: unknown): p is string =>
  typeof p === 'string' && DEBIAN_PACKAGE_RE.test(p) && !p.endsWith('-') && !FILE_SUFFIX_RE.test(p);

const fail = (name: string, msg: string): never => { throw new CapabilityDefinitionError(`${name}: ${msg}`); };

function obj(name: string, where: string, v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(name, `${where} must be a mapping`);
  const extra = Object.keys(v as object).filter((k) => !keys.includes(k));
  if (extra.length) fail(name, `${where}: unknown field ${extra.join(', ')}`);
  return v as Record<string, unknown>;
}

function str(name: string, where: string, v: unknown, re: RegExp | null, max = 512): string {
  if (typeof v !== 'string' || !v.length || v.length > max) fail(name, `${where} must be a string`);
  if (re && !re.test(v as string)) fail(name, `${where} is not valid: ${JSON.stringify(v)}`);
  return v as string;
}

/** An absolute, normalized path with no traversal. */
function absPath(name: string, where: string, v: unknown): string {
  const p = str(name, where, v, PATH_RE);
  if (posix.normalize(p) !== p || p.split('/').includes('..') || p.endsWith('/')) fail(name, `${where} must be a normalized absolute path`);
  return p;
}

/**
 * A path the definition writes: below one of the write roots, or (`root: true`:
 * a directory files are merged into, never replaced) a root itself.
 */
function writePath(name: string, where: string, v: unknown, opts: { root?: boolean } = {}): string {
  const p = absPath(name, where, v);
  if (!CAPABILITY_WRITE_ROOTS.some((root) => p.startsWith(root) || (opts.root === true && p === root.slice(0, -1)))) {
    fail(name, `${where} must be under ${CAPABILITY_WRITE_ROOTS.join(', ')}`);
  }
  return p;
}

function httpsUrl(name: string, where: string, v: unknown): string {
  const s = str(name, where, v, /^https:\/\/[^\s"'`\\<>$]+$/, 2048);
  let u: URL;
  try { u = new URL(s); } catch { return fail(name, `${where} is not a URL`); }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) fail(name, `${where} must be an https URL without credentials`);
  return s;
}

const sha = (name: string, where: string, v: unknown) => str(name, `${where}.sha256`, v, SHA256_RE, 64);
const mode = (name: string, where: string, v: unknown) => str(name, `${where}.mode`, v, MODE_RE, 4);

function step(name: string, i: number, raw: unknown): CapabilityStep {
  const where = `steps[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1) fail(name, `${where} must be a one-key mapping`);
  const [kind, v] = Object.entries(raw as object)[0] as [string, unknown];
  switch (kind) {
    case 'apt': {
      if (!Array.isArray(v) || !v.length || v.length > 64) fail(name, `${where}.apt must list 1-64 packages`);
      const bad = (v as unknown[]).filter((p) => !isDebianPackageName(p));
      if (bad.length) fail(name, `${where}.apt: not a Debian package name: ${bad.map((p) => JSON.stringify(p)).join(', ')}`);
      return { apt: [...(v as string[])] };
    }
    case 'download': {
      const o = obj(name, `${where}.download`, v, ['url', 'sha256', 'to', 'mode']);
      return { download: { url: httpsUrl(name, `${where}.url`, o['url']), sha256: sha(name, where, o['sha256']), to: writePath(name, `${where}.to`, o['to']),
        ...(o['mode'] !== undefined ? { mode: mode(name, where, o['mode']) } : {}) } };
    }
    case 'extract': {
      const o = obj(name, `${where}.extract`, v, ['url', 'sha256', 'format', 'to', 'strip', 'members', 'subdir', 'unless_exists']);
      if (o['format'] !== 'tar.gz' && o['format'] !== 'zip') fail(name, `${where}.format must be tar.gz or zip`);
      const strip = o['strip'];
      if (strip !== undefined && (!Number.isInteger(strip) || (strip as number) < 0 || (strip as number) > 5)) fail(name, `${where}.strip must be 0-5`);
      const members = o['members'];
      if (members !== undefined && (!Array.isArray(members) || !members.length || members.some((m) => typeof m !== 'string' || !MEMBER_RE.test(m) || m.split('/').includes('..')))) {
        fail(name, `${where}.members must be relative archive paths`);
      }
      const subdir = o['subdir'];
      if (subdir !== undefined && (typeof subdir !== 'string' || !MEMBER_RE.test(subdir) || subdir.split('/').includes('..'))) fail(name, `${where}.subdir must be a relative path`);
      if (o['format'] === 'zip' && (strip !== undefined || members !== undefined)) fail(name, `${where}: strip and members are for tar.gz`);
      return { extract: {
        url: httpsUrl(name, `${where}.url`, o['url']), sha256: sha(name, where, o['sha256']), format: o['format'] as 'tar.gz' | 'zip',
        // Without members the target is replaced by the archive's tree: never a root.
        to: writePath(name, `${where}.to`, o['to'], { root: members !== undefined }),
        ...(strip !== undefined ? { strip: strip as number } : {}),
        ...(members !== undefined ? { members: [...(members as string[])] } : {}),
        ...(subdir !== undefined ? { subdir: subdir as string } : {}),
        ...(o['unless_exists'] !== undefined ? { unless_exists: absPath(name, `${where}.unless_exists`, o['unless_exists']) } : {}),
      } };
    }
    case 'deb': {
      const o = obj(name, `${where}.deb`, v, ['url', 'sha256']);
      return { deb: { url: httpsUrl(name, `${where}.url`, o['url']), sha256: sha(name, where, o['sha256']) } };
    }
    case 'file': {
      const o = obj(name, `${where}.file`, v, ['path', 'content', 'mode']);
      if (typeof o['content'] !== 'string' || (o['content'] as string).length > MAX_FILE || (o['content'] as string).includes('\0')) fail(name, `${where}.content must be text up to 64 KiB`);
      return { file: { path: writePath(name, `${where}.path`, o['path']), content: o['content'] as string, mode: mode(name, where, o['mode']) } };
    }
    case 'symlink': {
      const o = obj(name, `${where}.symlink`, v, ['target', 'path']);
      return { symlink: { target: writePath(name, `${where}.target`, o['target']), path: writePath(name, `${where}.path`, o['path']) } };
    }
    case 'mkdir': {
      if (!Array.isArray(v) || !v.length || v.length > 16) fail(name, `${where}.mkdir must list 1-16 paths`);
      return { mkdir: (v as unknown[]).map((p, j) => writePath(name, `${where}.mkdir[${j}]`, p)) };
    }
    case 'readable':
      return { readable: writePath(name, `${where}.readable`, v) };
    default:
      return fail(name, `${where}: unknown step '${kind}' (apt, download, extract, deb, file, symlink, mkdir, readable)`);
  }
}

/**
 * The validated definition of capability `name`, or a CapabilityDefinitionError.
 * Strict: an unknown field (an `install_cmd`, say) is an error, not ignored.
 */
export function parseCapabilityDefinition(name: string, raw: unknown): CapabilityDefinition {
  if (!CAPABILITY_NAME_RE.test(name)) fail(JSON.stringify(name), 'not a capability name');
  const o = obj(name, 'definition', raw, ['source', 'binary', 'binary_path', 'package', 'steps', 'sidecars', 'package_root', 'description']);
  const source = o['source'];
  if (source !== 'builtin' && source !== 'apt' && source !== 'npm' && source !== 'steps') {
    fail(name, `source must be builtin, apt, npm or steps (got ${JSON.stringify(source)})`);
  }
  const def: CapabilityDefinition = { source: source as CapabilitySourceKind };
  if (o['binary'] !== undefined) def.binary = str(name, 'binary', o['binary'], BINARY_RE, 64);
  if (o['binary_path'] !== undefined) def.binary_path = absPath(name, 'binary_path', o['binary_path']);
  if (o['package_root'] !== undefined) {
    def.package_root = absPath(name, 'package_root', o['package_root']);
    if (def.binary_path && !def.binary_path.startsWith(`${def.package_root}/`)) fail(name, 'binary_path must be inside package_root');
  }
  if (o['description'] !== undefined) def.description = str(name, 'description', o['description'], null, 500);
  if (o['sidecars'] !== undefined) {
    if (!Array.isArray(o['sidecars']) || o['sidecars'].length > 64) fail(name, 'sidecars must be a list');
    def.sidecars = (o['sidecars'] as unknown[]).map((s, i) => (typeof s === 'string' && s.startsWith('/') ? absPath(name, `sidecars[${i}]`, s) : str(name, `sidecars[${i}]`, s, BINARY_RE, 64)));
  }
  switch (def.source) {
    case 'apt':
      if (!isDebianPackageName(o['package'])) fail(name, `package must be a Debian package name (got ${JSON.stringify(o['package'])})`);
      def.package = o['package'] as string;
      break;
    case 'npm':
      def.package = str(name, 'package', o['package'], NPM_PACKAGE_RE, 200);
      break;
    case 'steps': {
      const steps = o['steps'];
      if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) fail(name, `steps must list 1-${MAX_STEPS} steps`);
      def.steps = (steps as unknown[]).map((s, i) => step(name, i, s));
      if (!def.binary_path) fail(name, 'a steps capability names its binary_path');
      break;
    }
    case 'builtin':
      break;
  }
  if (def.source !== 'apt' && def.source !== 'npm' && o['package'] !== undefined) fail(name, `package is for apt and npm`);
  if (def.source !== 'steps' && o['steps'] !== undefined) fail(name, `steps are for source: steps`);
  return def;
}

/** Canonical JSON: object keys sorted at every level, so the digest never depends on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** What an approval binds: the name and the exact validated definition. */
export function capabilityDigest(name: string, def: CapabilityDefinition): string {
  return createHash('sha256').update(canonical({ name, definition: def })).digest('hex');
}

/** The validated capabilities of a registry document (`capabilities:` of the YAML); one bad entry fails the whole file. */
export function parseCapabilityRegistry(doc: unknown): Record<string, CapabilityDefinition> {
  const caps = (doc && typeof doc === 'object' ? (doc as { capabilities?: unknown }).capabilities : undefined) ?? {};
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) throw new CapabilityDefinitionError('registry: capabilities must be a mapping');
  const out: Record<string, CapabilityDefinition> = {};
  for (const [name, raw] of Object.entries(caps)) out[name] = parseCapabilityDefinition(name, raw);
  return out;
}
