/**
 * The one password policy (Settings → Users & Identities). Every path that
 * sets a password checks it here: setup, reset and change. Logging in never
 * does, so a tighter policy never locks out an existing password.
 *
 * The rules are public: the setup page and Settings show them. The stored
 * record is sealed by ValkeyUserStore, so a Valkey writer cannot lower them.
 */

/** In UTF-8 bytes. Longer input is refused before hashing. */
export const PASSWORD_MAX_BYTES = 512;

export interface PasswordPolicy {
  /** In characters (code points). */
  minLength: number;
  /** How many of the classes lowercase, uppercase, digit and other a password must use. */
  requiredClasses: number;
  /** The password may not equal the username, ignoring case. */
  differFromUsername: boolean;
}

export const PASSWORD_POLICY_LIMITS = Object.freeze({
  minLength: Object.freeze({ min: 4, max: 128 }),
  requiredClasses: Object.freeze({ min: 0, max: 4 }),
});

export const DEFAULT_PASSWORD_POLICY: Readonly<PasswordPolicy> = Object.freeze({
  minLength: 4,
  requiredClasses: 0,
  differFromUsername: true,
});

/** The rule a password failed, so a page can say which one. */
export type PasswordRule = 'length' | 'max-bytes' | 'classes' | 'username';

const inRange = (n: unknown, { min, max }: { min: number; max: number }): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/** A valid policy built from untrusted input, or null. Only the three rule fields are read. */
export function parsePasswordPolicy(input: unknown): PasswordPolicy | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { minLength, requiredClasses, differFromUsername } = input as Record<string, unknown>;
  if (!inRange(minLength, PASSWORD_POLICY_LIMITS.minLength)) return null;
  if (!inRange(requiredClasses, PASSWORD_POLICY_LIMITS.requiredClasses)) return null;
  if (typeof differFromUsername !== 'boolean') return null;
  return { minLength, requiredClasses, differFromUsername };
}

const CLASSES = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{Ll}\p{Lu}\p{Nd}]/u];

/** How many of the four character classes the password uses. */
export const passwordClasses = (password: string): number => CLASSES.filter((re) => re.test(password)).length;

export const passwordWithinMax = (password: string): boolean => Buffer.byteLength(password) <= PASSWORD_MAX_BYTES;

/** The first rule the password breaks, or null. `username` is the normalized one, when known. */
export function passwordViolation(
  password: unknown,
  { username, policy }: { username?: string; policy: PasswordPolicy },
): PasswordRule | null {
  if (typeof password !== 'string' || [...password].length < policy.minLength) return 'length';
  if (!passwordWithinMax(password)) return 'max-bytes';
  if (passwordClasses(password) < policy.requiredClasses) return 'classes';
  if (policy.differFromUsername && username && password.toLowerCase() === username) return 'username';
  return null;
}
