/**
 * The profile field registry (D46): one entry per profile field, so a new
 * field is one entry here (plus a migration only when it needs a default),
 * never a new route or SDK release.
 *
 * Every field declares an access class:
 *   basic    any app may read it, no grant
 *   granted  an app reads it only with a per-app `user.profile.<field>` grant
 *   private  never reaches an app; only the user (the desktop, Settings)
 *
 * `ownerEditable` fields are what `PATCH /api/user/me/profile` accepts.
 * `pref` names a per-user preference that backs the field, so one value has
 * one store (the profile's `locale` is the user's `locale` preference).
 */
import type { UserPrefKey } from './userData.js';

export type ProfileAccess = 'basic' | 'granted' | 'private';

export interface ProfileField {
  access: ProfileAccess;
  ownerEditable: boolean;
  description: string;
  /** Null when the value is acceptable, else why not. `null` input clears the field. */
  validate(value: unknown): string | null;
  /** Backed by this per-user preference instead of the profile record. */
  pref?: UserPrefKey;
}

const MAX_AVATAR_URL = 2048;
const MAX_AVATAR_DATA = 64 * 1024;
/** BCP 47 shape, e.g. `en`, `de-AT`, `zh-Hant-TW`. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const AVATAR_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

const text = (max: number) => (v: unknown): string | null =>
  typeof v !== 'string' ? 'must be a string'
    : v.trim() !== v ? 'must not start or end with spaces'
      : v.length === 0 || v.length > max ? `must be 1-${max} characters`
        // Control characters and bidi overrides would let a name pose as something else.
        : /[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(v) ? 'must not contain control characters' : null;

export const PROFILE_FIELDS = Object.freeze({
  displayName: {
    access: 'basic', ownerEditable: true, description: 'The name apps show for the user.',
    validate: text(64),
  },
  locale: {
    access: 'basic', ownerEditable: true, description: 'Preferred language (BCP 47), e.g. `en` or `de-AT`.',
    validate: (v: unknown) => (typeof v === 'string' && LOCALE.test(v) ? null : 'must be a BCP 47 language tag such as `en` or `de-AT`'),
    pref: 'locale',
  },
  avatar: {
    access: 'basic', ownerEditable: true, description: 'Optional picture: an https URL or a small data:image URL.',
    validate: (v: unknown) => {
      if (typeof v !== 'string') return 'must be a string';
      if (v.startsWith('https://')) {
        try { new URL(v); } catch { return 'must be a valid https URL'; }
        return v.length <= MAX_AVATAR_URL ? null : `must be at most ${MAX_AVATAR_URL} characters`;
      }
      if (AVATAR_DATA.test(v)) return v.length <= MAX_AVATAR_DATA ? null : `must be at most ${MAX_AVATAR_DATA} characters`;
      return 'must be an https URL or a data:image (png, jpeg, webp, gif) URL';
    },
  },
} satisfies Record<string, ProfileField>);

export type ProfileFieldName = keyof typeof PROFILE_FIELDS;
/** Every field optional: a new field ships without breaking a reader. */
export type UserProfile = { [K in ProfileFieldName]?: string };

export const PROFILE_FIELD_NAMES = Object.freeze(Object.keys(PROFILE_FIELDS) as ProfileFieldName[]);

export const isProfileField = (name: string): name is ProfileFieldName => Object.hasOwn(PROFILE_FIELDS, name);

/** The grant an app needs for a `granted` field. */
export const profileGrantPermission = (field: string): string => `user.profile.${field}`;

/**
 * Who reads a profile:
 *   user  the user themselves (the desktop, a trusted system UI): every field
 *         but never through an app
 *   app   an app: `basic` fields, `granted` ones it holds a grant for, never `private`
 */
export type ProfileAudience =
  | { kind: 'user' }
  | { kind: 'app'; granted(field: ProfileFieldName): Promise<boolean> | boolean };

/**
 * The profile as `audience` may see it. Absent and unknown fields stay
 * absent, never an error: only fields the registry knows are copied.
 * `fields` is the registry; tests pass their own.
 */
export async function filterProfile(
  profile: UserProfile,
  audience: ProfileAudience,
  fields: Readonly<Record<string, Pick<ProfileField, 'access'>>> = PROFILE_FIELDS,
): Promise<UserProfile> {
  const out: Record<string, string> = {};
  const source = profile as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    const value = source[name];
    if (typeof value !== 'string') continue;
    const access: ProfileAccess = fields[name]!.access;
    if (audience.kind === 'app') {
      if (access === 'private') continue;
      if (access === 'granted') {
        let held = false;
        try { held = await audience.granted(name as ProfileFieldName); } catch { held = false; }
        if (!held) continue;
      }
    }
    out[name] = value;
  }
  return out as UserProfile;
}

export type ProfilePatchResult =
  | { ok: true; set: UserProfile; clear: ProfileFieldName[] }
  | { ok: false; field: string; error: string };

/**
 * A profile change as the user sends it: known, owner-editable fields only,
 * each validated by its entry. `null` clears a field.
 */
export function parseProfilePatch(input: unknown): ProfilePatchResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, field: '', error: 'body must be an object of profile fields' };
  const set: UserProfile = {};
  const clear: ProfileFieldName[] = [];
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, field: '', error: 'no fields to change' };
  for (const [name, value] of entries) {
    if (!isProfileField(name)) return { ok: false, field: name, error: 'unknown profile field' };
    const field: ProfileField = PROFILE_FIELDS[name];
    if (!field.ownerEditable) return { ok: false, field: name, error: 'not editable' };
    if (value === null) { clear.push(name); continue; }
    const why = field.validate(value);
    if (why) return { ok: false, field: name, error: why };
    set[name] = value as string;
  }
  return { ok: true, set, clear };
}
