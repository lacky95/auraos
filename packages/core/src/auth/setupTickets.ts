/**
 * One-time setup and reset codes — file operations only (no Valkey), so the
 * CLI can create one in the master container even while the shell is down.
 *
 *   <dataDir>/aura/secrets/setup-tickets/<sha256>.json   0600
 *
 * A ticket holds only `{sha256, purpose, expiresAt, username?}`. The code is
 * shown once to the operator and never written or logged. It has 100 random
 * bits and expires after 10 minutes. `rename` makes a claim single-use, and
 * because the file is named by the code's hash, a wrong code touches nothing.
 *
 * Creating a ticket also leaves a small event file, because the CLI has no
 * Valkey. The shell moves those into the audit log (`drainCreatedEvents`).
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

export interface SetupTicketEvent {
  at: number;
  purpose: SetupTicketPurpose;
  username?: string;
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
    if (t.purpose !== 'setup' && t.purpose !== 'reset') return null;
    if (t.username !== undefined && typeof t.username !== 'string') return null;
    return {
      sha256: t.sha256, purpose: t.purpose, expiresAt: t.expiresAt,
      ...(t.username !== undefined ? { username: t.username } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Create a one-time code for the operator. A new code replaces earlier codes of
 * the same purpose. The returned `code` is the only copy.
 */
export function createSetupTicket(
  dataDir: string,
  input: { purpose: SetupTicketPurpose; username?: string },
  now: () => number = Date.now,
): { code: string; expiresAt: number } {
  if (input.purpose !== 'setup' && input.purpose !== 'reset') throw new Error('invalid ticket purpose');
  const dir = defaultSetupTicketDir(dataDir);
  mkdirSync(join(dir, 'events'), { recursive: true, mode: 0o700 });

  const at = now();
  for (const name of readdirSync(dir)) {
    if (!TICKET_FILE_RE.test(name)) continue;
    const t = readTicket(join(dir, name));
    if (!t || t.purpose === input.purpose || t.expiresAt <= at) rmSync(join(dir, name), { force: true });
  }

  // Five bits per byte is unbiased over a 32-character alphabet.
  const code = [...randomBytes(CODE_CHARS)].map((b) => ALPHABET[b & 31]!).join('');
  const expiresAt = at + SETUP_TICKET_TTL_MS;
  const username = input.username !== undefined ? { username: input.username } : {};
  const ticket: SetupTicket = { sha256: hashCode(code), purpose: input.purpose, expiresAt, ...username };
  writePrivate(join(dir, `${ticket.sha256}.json`), ticket);
  const event: SetupTicketEvent = { at, purpose: input.purpose, ...username };
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

  async claim(code: string, purpose: SetupTicketPurpose): Promise<SetupTicket | null> {
    if (this.beforeClaim) await this.beforeClaim().catch(() => undefined);
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
