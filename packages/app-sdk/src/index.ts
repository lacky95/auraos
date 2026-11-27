export { OsClient, viewportGrid } from './OsClient.js';
export type { ViewportChangeInfo } from './OsClient.js';
// Keyboard / Back / system-action namespaces mounted on `osClient.{keymap,nav,system}`.
// Apps that just want to subscribe to a shortcut import only the types.
export { KeymapApi }   from './keymap.js';
export { NavApi }      from './nav.js';
export { SystemApi }   from './system.js';
export { SurfaceApi }  from './surface.js';
export type {
  SurfaceRect, NeedsTopLevelInfo, NeedsTopLevelHandler, OccludedInfo, OccludedHandler,
} from './surface.js';
export { ActivityApi } from './activity.js';
// Free-flight activities — `osClient.flight`.
export { FlightApi, FlightHandle } from './flight.js';
export { UserApi, UserConfirmError, UserError } from './user.js';
export type { AuraUser, ConfirmLevel, ConfirmOptions, ConfirmResult, UserProfileView } from './user.js';
export { StorageApi, StorageError } from './storage.js';
// One error type (OsError {status, code}); the classes above and below extend it.
export { OsError } from './errors.js';
// The app contract (D48): its version, Context, approvals, permissions.
export { AURA_CONTRACT } from './contract.js';
export { ContextApi } from './aura-context.js';
export { ApprovalsApi, APPROVAL_HEADER, approvalHeader } from './approvals.js';
export { CredentialsApi } from './credentials.js';
export type { CredentialRequest, CredentialResult } from './credentials.js';
// D108 app setup: the app-facing types (osClient.setup, the setup hooks).
export type { SetupConfig, SetupConfigValue, SetupDegraded, SetupHookInput, SetupReason, ValidateResult, MigrateConfigInput, MigrateConfigResult } from './setup-types.js';
export type { ApprovalAsk, ApprovalLevel, ApprovalOutcome, ApprovalResult, ApprovalWaitOptions } from './approvals.js';
export { PermissionsApi } from './permissions.js';
export { ThemeApi } from './theme.js';
export type { ThemeSelection, ThemeStrategy } from './theme.js';
export { DataApi } from './data.js';
export { IntentsApi } from './intents.js';
export type { StartIntent, StartIntentResult } from './intents.js';
export type {
  FlightEdge, FlightRect, FlightBadge, FlightNotice, FlightNoticeLevel, FlightAction, FlightState, FlightOpenOptions,
  FlightMode, FlightAnchor, FlightEdgeSize,
  FlightClosingEvent, FlightEvents,
} from './flight.js';
// Interface Registry — `osClient.interfaces`. Discovery + runtime registration.
export { InterfacesApi } from './interfaces.js';
export { appHostUrl, appHostUrlFromRequest } from './hosts.js';
// The one App Host name rule, for pages that must tell this desktop's apps apart from websites.
export { parseAppHost } from './hostRules.js';
export type { ParsedAppHost } from './hostRules.js';
// App Host transport: the runtime bootstrap and the verified shell channel.
export { appHostRuntime, bodylessMutationHeaders, osAuthHeaders, osUrl } from './os-auth.js';
export { postToShell, isFromShell } from './channel.js';
// Notifications — `osClient.notifications`. create / update / remove / get /
// list / waitForAnswer / waitForInteraction / subscribe.
export { NotificationsApi, NotificationsError, parseSse } from './notifications.js';
export type {
  Notification,
  NotificationInput,
  NotificationPatch,
  NotificationEvent,
  NotificationWarning,
  NotificationComponent,
  NotificationContext,
  NotificationContextKind,
  NotificationType,
  NotificationPriority,
  NotificationVisibility,
  NotificationState,
  ListFilter as NotificationListFilter,
  WaitResult,
  SubscribeOptions,
  NotificationsOptions,
  CreateResult as NotificationCreateResult,
  NotificationInteraction,
  NotificationInteractionValue,
  InteractionWaitResult as NotificationInteractionWaitResult,
} from './notifications.js';
export type {
  InterfaceView,
  ConsumerView,
  InterfaceFilter,
  InterfaceSpec,
  InterfaceKind,
} from './interfaces.js';
export type {
  KeymapHandler,
  KeymapHandlerCtx,
  KeymapChangeInfo,
} from './keymap.js';
export type {
  BackEvent,
  BackHandler,
  InstallGridNavOptions,
  GridNavHandle,
} from './nav.js';
export type { NavigateOptions } from './activity.js';

// Lifecycle hook factories — apps use these in place of hand-rolled APIRoutes
// for /api/lifecycle/* files. See ./lifecycle.ts for the full API.
export {
  createHealthEndpoint,
  createLifecycleHandler,
  createActivityCreateHandler,
  createActivityDestroyHandler,
  createIntentHandler,
  createSaveStateHandler,
  createAssignHandler,
} from './lifecycle.js';
export { parseIntentPayload, IntentRejectedError } from './intent.js';
export type { IntentPayload } from './intent.js';
export type {
  LifecycleHookName,
  LifecycleContext,
  ActivityCreateRequest,
  ActivityCreateResult,
  ActivityRestore,
  SaveStateRequest,
  SaveStateResult,
  IntentRequest,
  AssignRequest,
} from './lifecycle.js';

// Android-`Context`-equivalent: env-var + header readers. See ./context.ts.
export {
  getAppContext,
  readIdentityHeaders,
  ownAppId,
  ownInstanceId,
  identityResponseHeaders,
} from './context.js';
export type {
  AppContext,
  IdentityHeaders,
} from './context.js';

// integration.mjs is `.mjs` so app `astro.config.mjs` can import it via
// Node's loader before Astro/Vite take over. Re-export through the package
// barrel so it shows up alongside OsClient. `auraIdentityIntegration` is a
// back-compat alias for the previous name.
// @ts-expect-error — JS file, no .d.ts; only consumed from .mjs configs anyway
export { auraAppIntegration, auraIdentityIntegration } from './integration.mjs';

// Proxy helper for apps writing Astro `[...path].ts` routes that forward to
// an upstream HTTP service. Encapsulates the gzip-vs-decompressed-body
// header dance that bites every author the first time. Direct subpath
// import (`@aura/app-sdk/proxy`) also works for apps that prefer it.
export { proxyFetch, sanitizeHeaders } from './proxy.js';
export type { ProxyFetchOptions } from './proxy.js';

// Sibling-container runtime manager for "bring-your-own-runtime" apps.
//
// NOTE: intentionally NOT re-exported from the barrel. `sidecars.ts` imports
// `node:child_process`, and any client-side module that pulls `@aura/app-sdk`
// via the barrel (e.g. `import { OsClient } from '@aura/app-sdk'`) would drag
// `sidecars.ts` into the browser bundle. Vite externalizes `node:child_process`
// for the browser and the app then breaks with "Module has been externalized
// for browser compatibility" the moment it renders. Server code that needs it
// imports directly from the subpath instead:
//
//   import { createSidecars } from '@aura/app-sdk/sidecars';
