/**
 * Server-side instance owner. New spawns carry the `aura.owner` label. Idle
 * warm-pool members have no owner until they are claimed. A running container
 * from before this label is adopted under the bootstrap owner and never
 * recreated.
 */
import { DEFAULT_OWNER_ID } from '../auth/identityContracts.js';

export const OWNER_LABEL = 'aura.owner';
/** A preview instance (Track P): the label holds its workspace, relative to the root dataDir. */
export const PREVIEW_LABEL = 'aura.preview';
const OWNER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The owner of an adopted container. Undefined only for an unclaimed pool member. */
export function adoptedInstanceOwner(label: string | undefined, inPool: boolean): string | undefined {
  if (label && OWNER_ID_RE.test(label)) return label;
  return inPool ? undefined : DEFAULT_OWNER_ID;
}
