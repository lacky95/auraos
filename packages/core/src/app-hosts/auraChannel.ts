/**
 * AuraChannel: every postMessage type exchanged between the shell, apps and
 * embedded apps, with who may send it to whom. Pure, with no imports.
 *
 * The source is packages/core/src/app-hosts/auraChannel.ts. The SDK carries a
 * byte-identical copy at packages/app-sdk/src/auraChannel.ts, because an app
 * can install @aura/app-sdk without @aura/core. core's aura-channel test fails
 * if the two differ, or if the code uses a message type missing here.
 *
 * A sender class is a claim the RECEIVER must verify from `event.origin` and
 * `event.source`, never from the payload.
 */

export const AURA_CHANNEL_VERSION = 1;

export type AuraChannelEndpoint =
  /** The desktop document, at the shell's exact origin. */
  | 'shell'
  /** An app document in a window the shell created. */
  | 'app'
  /** A frame nested inside an app document (e.g. the Browser's engine frame). */
  | 'app-subframe'
  /** An app displaying another app's session through an embed grant (D25). */
  | 'embed-host'
  /** The app displayed by an embed host. */
  | 'embedded-app'
  /**
   * A script the native WebView injects into nested frames. These messages
   * carry only `source: 'host'`, which any frame can forge, so a receiver must
   * treat them as unauthenticated hints.
   */
  | 'native-host';

export interface AuraChannelRoute {
  from: AuraChannelEndpoint;
  to: AuraChannelEndpoint;
}

const route = (from: AuraChannelEndpoint, to: AuraChannelEndpoint): AuraChannelRoute => ({ from, to });

const TO_SHELL = [route('app', 'shell')] as const;
const TO_APP = [route('shell', 'app')] as const;
/** The UI-integration messages an embed host may forward (5.16). */
const TO_APP_AND_EMBED = [route('shell', 'app'), route('embed-host', 'embedded-app')] as const;
const FROM_EMBEDDED = [route('embedded-app', 'embed-host')] as const;
/**
 * Keyboard reports: from a window, up through a proxied app's relay, or (App
 * Hosts) straight from a nested frame to the verified shell.
 */
const KEYBOARD_UP = [
  route('app', 'shell'), route('app-subframe', 'app'),
  route('app-subframe', 'shell'), route('embedded-app', 'shell'),
] as const;
const KEYBOARD_REPORT = [...KEYBOARD_UP, route('shell', 'shell')] as const;
const NATIVE_TO_APP = [route('native-host', 'shell'), route('shell', 'app')] as const;

/** Every message type and its allowed routes. */
export const AURA_CHANNEL_MESSAGES = {
  // Keys and keymap
  // An embedded App Host's runtime reports OS shortcuts to the verified shell
  // itself, the same as an app window, so its embedder relays nothing (D29).
  'aura.key': [route('app', 'shell'), route('embedded-app', 'shell')],
  'aura.key.claim': [route('shell', 'app'), route('shell', 'embedded-app')],
  // No embed-host route: a parent app must not inject keys (D29). The shell
  // posts directly to the focused frame; a relay only reaches the app's own subframes.
  'aura.key.synthetic': [route('shell', 'app'), route('shell', 'app-subframe'), route('shell', 'embedded-app'), route('shell', 'shell'), route('app', 'app-subframe')],
  'aura.keymap.subscribe': TO_SHELL,
  'aura.keymap.changed': TO_APP_AND_EMBED,
  'aura.action.fire': TO_APP,

  // On-screen keyboard
  'aura.keyboard.hello': KEYBOARD_REPORT,
  'aura.keyboard.field': KEYBOARD_REPORT,
  'aura.keyboard.open': KEYBOARD_UP,
  'aura.keyboard.close': KEYBOARD_UP,
  'aura.keyboard.policy': [route('shell', 'app'), route('shell', 'app-subframe'), route('shell', 'embedded-app'), route('shell', 'shell'), route('app', 'app-subframe')],

  // Navigation and window
  'aura.back': TO_APP,
  'aura.back.ack': TO_SHELL,
  'aura.pointerdown': [route('app', 'shell'), route('embedded-app', 'shell')],
  'aura.window.focus': TO_APP_AND_EMBED,
  'aura.window.label': TO_SHELL,
  'aura.window.rebind': TO_SHELL,
  'aura.shutdown': TO_APP,
  'aura.shutdown.done': TO_SHELL,
  'aura.perf.mark': TO_SHELL,

  // Theme and viewport
  'aura.theme.changed': TO_APP_AND_EMBED,
  'aura.mode.changed': TO_APP_AND_EMBED,
  'aura.viewport.changed': TO_APP_AND_EMBED,

  // Console
  'aura.console': TO_APP,
  'aura.console.relay': TO_SHELL,
  'aura.console.requestBacklog': TO_SHELL,
  'aura.console.backlog': TO_APP,

  // System actions
  'aura.lockscreen.activate': TO_SHELL,
  'aura.system.openLauncher': TO_SHELL,
  'aura.system.closeLauncher': TO_SHELL,
  'aura.system.toggleLauncher': TO_SHELL,
  'aura.system.openProcessManager': TO_SHELL,
  'aura.system.closeProcessManager': TO_SHELL,
  'aura.system.toggleProcessManager': TO_SHELL,
  'aura.system.toggleNavMode': TO_SHELL,
  'aura.system.toggleHome': TO_SHELL,
  'aura.system.lockScreen': TO_SHELL,
  'aura.system.switchWorkspace': TO_SHELL,

  // Admin unlock: Settings asks, the Shell collects the credential itself
  'aura.admin.unlock.request': TO_SHELL,
  'aura.admin.unlock.result': TO_APP,

  // Terminal session share: an embed host asks, the owner decides in the Shell (D25)
  'aura.terminal.share.request': TO_SHELL,
  'aura.terminal.share.result': TO_APP,

  // The desktop's cookie probe frame on an App Host (D44): whether the
  // browser kept a cookie there. Only the router answers that page.
  'aura.hostprobe.cookie': TO_SHELL,

  // Native host
  'aura.host.url-changed': NATIVE_TO_APP,
  'aura.host.needsTopLevel': NATIVE_TO_APP,
  'aura.host.popup': [route('native-host', 'shell')],
  'aura.frame.needsTopLevel': [route('app', 'shell'), route('app-subframe', 'shell')],

  // Native surface
  'aura.surface.query': TO_SHELL,
  'aura.surface.command': TO_SHELL,
  'aura.surface.attach': TO_SHELL,
  'aura.surface.setRect': TO_SHELL,
  'aura.surface.detach': TO_SHELL,
  'aura.surface.capability': TO_APP,
  'aura.surface.state': TO_APP,
  'aura.surface.occluded': TO_APP,

  // Flights
  'aura.flight.hello': TO_SHELL,
  'aura.flight.perch': TO_SHELL,
  'aura.flight.notify': TO_SHELL,
  'aura.flight.unfold': TO_SHELL,
  'aura.flight.show': TO_SHELL,
  'aura.flight.hide': TO_SHELL,
  'aura.flight.mode': TO_SHELL,
  'aura.flight.resize': TO_SHELL,
  'aura.flight.state': TO_APP,
  'aura.flight.closing': TO_APP,
  'aura.flight.action': TO_APP,

  // Terminal embed
  'aura.terminal.ready': FROM_EMBEDDED,
  'aura.terminal.locked': FROM_EMBEDDED,
  'aura.terminal.session-ended': FROM_EMBEDDED,
} as const satisfies Record<string, readonly AuraChannelRoute[]>;

export type AuraChannelType = keyof typeof AURA_CHANNEL_MESSAGES;

export interface AuraChannelMessage<T extends AuraChannelType = AuraChannelType> {
  type: T;
  [field: string]: unknown;
}

export function isAuraChannelType(type: unknown): type is AuraChannelType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(AURA_CHANNEL_MESSAGES, type);
}

/** Whether `type` may travel from `from` to `to`. Unknown types never may. */
export function isAuraChannelRouteAllowed(type: unknown, from: AuraChannelEndpoint, to: AuraChannelEndpoint): boolean {
  if (!isAuraChannelType(type)) return false;
  const routes: readonly AuraChannelRoute[] = AURA_CHANNEL_MESSAGES[type];
  return routes.some((r) => r.from === from && r.to === to);
}

/**
 * What `/_aura/runtime.js` starts from, and the one source of a page's runtime
 * identity (app, instance, activity) and theme for the SDK. Contains no credential.
 */
export interface AuraRuntimeBootstrap {
  channelVersion: typeof AURA_CHANNEL_VERSION;
  appId: string;
  instanceId: string;
  /** Null for a document that isn't an Activity window. */
  activityId: string | null;
  label: string;
  slot: number;
  /** The exact origin the channel accepts shell messages from. */
  shellOrigin: string;
  /** This App Host's own origin. */
  appOrigin: string;
  /** Always `/_aura/os/`, same-origin. */
  gatewayBase: string;
  theme: {
    themeId: string;
    themeIdDark: string;
    themeIdLight: string;
    colorMode: 'light' | 'dark' | 'auto';
    resolvedMode: 'light' | 'dark';
    /** The app's manifest `themeStrategy`. */
    strategy: 'inherit' | 'themed' | 'override';
    /** The active theme's design framework. */
    framework: { id: string; version: string };
  };
  keymap: {
    /** Combos the shell intercepts, as in `aura.key.claim`. */
    claims: string[];
    /** Action id to combo, as in `aura.keymap.changed`. */
    bindings: Record<string, string>;
  };
  /** Relay console output to the shell. */
  consoleRelay: boolean;
}
