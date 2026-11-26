/**
 * One-time setup and reset codes — file operations only (no Valkey), so the
 * CLI can create one in the master container even while the shell is down.
 *
 *   <dataDir>/aura/secrets/setup-tickets/<sha256>.json   0600
 *
 * A ticket holds only `{sha256, purpose, expiresAt, username?, subject?}`. The code is
 * shown once to the operator and never written or logged. It has 100 random
 * bits and expires after 10 minutes. `rename` makes a claim single-use, and
 * because the file is named by the code's hash, a wrong code touches nothing.
 *
 * Creating a ticket also leaves a small event file, because the CLI has no
 * Valkey. The shell moves those into the audit log (`drainCreatedEvents`).
 *
 * An `operator` ticket is the host operator's word on one `subject` (D18,
 * `aura approve <id>`): the CLI creates it and presents it at once over HTTP,
 * which only a process that can write this directory can do. The host CLI
 * also identifies each of its API requests this way (`operatorRequestSubject`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markClaimedTicket } from './claimedTickets.js';
import type { SetupTicket, SetupTicketPurpose, SetupTickets } from './identityContracts.js';

export const SETUP_TICKET_TTL_MS = 10 * 60_000;

// Crockford base32: no I, L, O or U, so a code survives being read aloud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 20;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_CHARS}}$`);
const SHA256_RE = /^[0-9a-f]{64}$/;
const TICKET_FILE_RE = /^[0-9a-f]{64}\.json$/;
const PURPOSES: ReadonlySet<string> = new Set<SetupTicketPurpose>(['setup', 'reset', 'operator']);
/** `approve:apr_…`, `nexus.install:<sha256>`: printable, no spaces. */
const SUBJECT_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** A local user id (the owner's `default`, or a generated `u…` id). */
const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The subject of an operator ticket that identifies one API request of the
 * host CLI as the operator (`X-Aura-Operator`): its method and path. The CLI
 * creates it, the shell resolver claims it; both compute it here.
 */
export function operatorRequestSubject(method: string, pathname: string): string {
  return `request:${createHash('sha256').update(`${method.toUpperCase()} ${pathname}`).digest('hex')}`;
}

export interface SetupTicketEvent {
  at: number;
  purpose: SetupTicketPurpose;
  username?: string;
  userId?: string;
  subject?: string;
}

export function defaultSetupTicketDir(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data'): string {
  return join(dataDir, 'aura', 'secrets', 'setup-tickets');
}

function canonicalCode(code: unknown): string | null {
  if (typeof code !== 'string' || code.length > 64) return null;
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}

const hashCode = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

function writePrivate(file: string, data: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readTicket(file: string): SetupTicket | null {
  try {
    const t = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SetupTicket>;
    if (typeof t.sha256 !== 'string' || !SHA256_RE.test(t.sha256) || typeof t.expiresAt !== 'number') return null;
    if (typeof t.purpose !== 'string' || !PURPOSES.has(t.purpose)) return null;
    if (t.username !== undefined && typeof t.username !== 'string') return null;
    if (t.userId !== undefined && (typeof t.userId !== 'string' || !USER_ID_RE.test(t.userId))) return null;
    if (t.subject !== undefined && (typeof t.subject !== 'string' || !SUBJECT_RE.test(t.subject))) return null;
    return {
      sha256: t.sha256, purpose: t.purpose, expiresAt: t.expiresAt,
      ...(t.username !== undefined ? { username: t.username } : {}),
      ...(t.userId !== undefined ? { userId: t.userId } : {}),
      ...(t.subject !== undefined ? { subject: t.subject } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Create a one-time code for the operator. A new setup or reset code replaces
 * earlier codes of the same purpose; operator codes stand side by side, each
 * for its own `subject`. The returned `code` is the only copy.
 */
export function createSetupTicket(
  dataDir: string,
  input: { purpose: SetupTicketPurpose; username?: string; userId?: string; subject?: string },
  now: () => number = Date.now,
): { code: string; expiresAt: number } {
  if (!PURPOSES.has(input.purpose)) throw new Error('invalid ticket purpose');
  if ((input.purpose === 'operator') !== (input.subject !== undefined)) throw new Error('an operator ticket, and only one, names a subject');
  if (input.subject !== undefined && !SUBJECT_RE.test(input.subject)) throw new Error('invalid ticket subject');
  if (input.userId !== undefined && (input.purpose !== 'reset' || !USER_ID_RE.test(input.userId))) throw new Error('only a reset ticket is bound to a user id');
  const dir = defaultSetupTicketDir(dataDir);
  mkdirSync(join(dir, 'events'), { recursive: true, mode: 0o700 });

  const at = now();
  for (const name of readdirSync(dir)) {
    if (!TICKET_FILE_RE.test(name)) continue;
    const t = readTicket(join(dir, name));
    if (!t || (t.purpose === input.purpose && t.purpose !== 'operator') || t.expiresAt <= at) rmSync(join(dir, name), { force: true });
  }

  // Five bits per byte is unbiased over a 32-character alphabet.
  const code = [...randomBytes(CODE_CHARS)].map((b) => ALPHABET[b & 31]!).join('');
  const expiresAt = at + SETUP_TICKET_TTL_MS;
  const username = input.username !== undefined ? { username: input.username } : {};
  const subject = input.subject !== undefined ? { subject: input.subject } : {};
  const userId = input.userId !== undefined ? { userId: input.userId } : {};
  const ticket: SetupTicket = { sha256: hashCode(code), purpose: input.purpose, expiresAt, ...username, ...userId, ...subject };
  writePrivate(join(dir, `${ticket.sha256}.json`), ticket);
  const event: SetupTicketEvent = { at, purpose: input.purpose, ...username, ...userId, ...subject };
  writePrivate(join(dir, 'events', `${at}-${randomBytes(4).toString('hex')}.json`), event);
  return { code: code.replace(/(.{5})(?=.)/g, '$1-'), expiresAt };
}

export interface FileSetupTicketsOptions {
  dir: string;
  now?: () => number;
  /** Called before each claim, so ticket creation is audited ahead of its use. */
  beforeClaim?: () => Promise<void>;
}

export class FileSetupTickets implements SetupTickets {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly beforeClaim?: () => Promise<void>;
  private draining = false;

  constructor(opts: FileSetupTicketsOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.beforeClaim = opts.beforeClaim;
  }

  /** The live ticket `code` names, without using it up: what an operator is about to confirm. */
  async peek(code: string, purpose: SetupTicketPurpose): Promise<SetupTicket | null> {
    return this.find(code, purpose)?.ticket ?? null;
  }

  private find(code: string, purpose: SetupTicketPurpose): { file: string; ticket: SetupTicket } | null {
    const canonical = canonicalCode(code);
    if (!canonical) return null;
    const sha256 = hashCode(canonical);
    const file = join(this.dir, `${sha256}.json`);
    const ticket = readTicket(file);
    if (!ticket || ticket.sha256 !== sha256 || ticket.purpose !== purpose) return null;
    if (ticket.expiresAt <= this.now()) {
      rmSync(file, { force: true });
      return null;
    }
    return { file, ticket };
  }

  async claim(code: string, purpose: SetupTicketPurpose): Promise<SetupTicket | null> {
    if (this.beforeClaim) await this.beforeClaim().catch(() => undefined);
    const found = this.find(code, purpose);
    if (!found) return null;
    const { file, ticket } = found;
    const claimed = `${file}.claimed-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(file, claimed); // Only one concurrent caller can win this.
    } catch {
      return null;
    }
    rmSync(claimed, { force: true });
    // Frozen: the claim vouches for exactly these fields.
    Object.freeze(ticket);
    markClaimedTicket(ticket);
    return ticket;
  }

  /**
   * Pass each pending creation event to `record`, oldest first. An event is
   * removed only after `record` succeeds, so a failed audit write is retried.
   */
  async drainCreatedEvents(record: (e: SetupTicketEvent) => Promise<void>): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    let done = 0;
    try {
      const dir = join(this.dir, 'events');
      let names: string[];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
      catch { return 0; }
      for (const name of names) {
        const file = join(dir, name);
        let event: SetupTicketEvent;
        try { event = JSON.parse(readFileSync(file, 'utf-8')) as SetupTicketEvent; }
        catch { rmSync(file, { force: true }); continue; }
        await record(event);
        rmSync(file, { force: true });
        done++;
      }
      return done;
    } finally {
      this.draining = false;
    }
  }
}
