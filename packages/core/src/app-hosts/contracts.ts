/**
 * App Hosts contract for Phase 2: the records, registry interface, frame
 * result and signed claims the registry, router, gateway and desktop share.
 * Types only, so importing this file adds no runtime code. The rules
 * themselves are in hostRules.ts.
 */
import type { NexusSource } from '../nexus/types.js';

export type AppInstallationState = 'active' | 'reserved' | 'retired';

/** What a restore compares against the saved installation (5.13). */
export interface AppSourceFingerprint {
  kind: NexusSource | 'system';
  /** Registry reference, git URL, or local path. */
  ref: string;
  /** Image digest or commit, when the source has one. */
  digest?: string;
}

/** This AuraOS's local claim on an app. `originId` alone never grants it (D20). */
export interface AppInstallation {
  installationId: string;
  appId: string;
  /** Null until an app without one is assigned one. */
  originId: string | null;
  /** Install scope: `system`, `global`, or `user`. */
  scope: string;
  userId: string;
  source: AppSourceFingerprint;
  state: AppInstallationState;
  createdAt: number;
  updatedAt: number;
}

/** Who shares a running instance (D19). `shared` is model-only in the alpha. */
export type AppInstanceScope =
  | { kind: 'user'; userId: string }
  | { kind: 'shared' };

export interface AppHostSlotAssignment {
  /** 1 is the base name; N >= 2 adds `xN`. */
  slot: number;
  label: string;
  /** Null when free: the slot keeps its label for the next instance in scope. */
  instanceId: string | null;
  assignedAt: number | null;
}

/** One installation's hosts within one instance scope. */
export interface AppHostRecord {
  installationId: string;
  appId: string;
  instanceScope: AppInstanceScope;
  /** The allocated slot-1 name. Never recomputed from the app id or manifest. */
  baseName: string;
  state: Exclude<AppInstallationState, 'retired'>;
  slots: AppHostSlotAssignment[];
  createdAt: number;
}

/** A label that once existed and may never be allocated again. */
export interface AppHostLabelTombstone {
  label: string;
  installationId: string;
  appId: string;
  retiredAt: number;
}

/** What the router learns from an exact label. */
export type AppHostResolution =
  | { status: 'active'; record: AppHostRecord; slot: AppHostSlotAssignment }
  /** Keep-data uninstall: the route is inactive and the label stays held. */
  | { status: 'reserved'; record: AppHostRecord; slot: AppHostSlotAssignment }
  | { status: 'retired'; tombstone: AppHostLabelTombstone }
  | { status: 'unknown' };

export interface AllocateAppHostInput {
  installation: AppInstallation;
  instanceScope: AppInstanceScope;
  isSystemApp: boolean;
}

/** Evidence for reactivating a reserved installation (5.13). */
export interface ReactivateAppHostInput {
  installationId: string;
  originId: string | null;
  source: AppSourceFingerprint;
  /** The operator confirmed the restore although the source changed. */
  confirmedSourceChange?: boolean;
}

/** The authority for App Host names. Every mutation is atomic. */
export interface AppHostRegistry {
  /** Idempotent for the same installation and scope. */
  allocate(input: AllocateAppHostInput): Promise<AppHostRecord>;
  resolveLabel(label: string): Promise<AppHostResolution>;
  /** Keep-data uninstall: deactivate routes, hold labels. */
  reserve(installationId: string): Promise<void>;
  /** Rejects when the origin differs, or the source differs without confirmation. */
  reactivate(input: ReactivateAppHostInput): Promise<AppHostRecord[]>;
  /** Delete app data: tombstone every label, permanently. */
  retire(installationId: string): Promise<AppHostLabelTombstone[]>;
  /** The instance's existing slot, or the lowest free one. */
  assignSlot(installationId: string, instanceScope: AppInstanceScope, instanceId: string): Promise<AppHostSlotAssignment>;
  /** Frees the slot but keeps its label for reuse within the scope. */
  releaseSlot(installationId: string, instanceScope: AppInstanceScope, instanceId: string): Promise<void>;
  listForApp(appId: string): Promise<AppHostRecord[]>;
}

/** The one answer to "what does this window load?" (`resolveAppFrame()`). */
export interface ResolvedAppFrame {
  origin: string;
  url: string;
  label: string;
  slot: number;
  /** Value of the iframe `sandbox` attribute. */
  sandbox: string;
  /** Value of the iframe `allow` attribute. */
  allow: string;
}

/** The one-time code redeemed at `/_aura/handoff`. */
export interface AppHostHandoffClaim {
  v: 1;
  /** Single-use id. */
  jti: string;
  /** The exact App Host origin this code is valid on. */
  aud: string;
  label: string;
  installationId: string;
  appId: string;
  slot: number;
  userId: string;
  /** Shell session it derives from, checked for liveness. */
  sid: string;
  /** Same-origin path to continue to. */
  returnPath: string;
  iat: number;
  exp: number;
}

/** The host-only cookie set by the handoff, stripped before forwarding. */
export interface AppHostCookiePayload {
  v: 1;
  /** The exact App Host origin. */
  aud: string;
  label: string;
  installationId: string;
  userId: string;
  sid: string;
  iat: number;
  exp: number;
}

/** Signed by the router and sent in `GATEWAY_IDENTITY_HEADER`. */
export interface GatewayIdentityClaim {
  v: 1;
  appId: string;
  installationId: string;
  instanceId: string | null;
  label: string;
  slot: number;
  /** The exact App Host origin the request arrived on. */
  origin: string;
  userId: string;
  /** Request binding, so a claim can't be replayed on another call. */
  method: string;
  path: string;
  iat: number;
  exp: number;
}
