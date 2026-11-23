import { AURA_CHANNEL_VERSION } from '@aura/core/aura-channel';
import { AURA_RESERVED_PATHS } from '@aura/core/host-rules';
import type { AuraRuntimeBootstrap, ProxyConfig } from '@aura/core';
import {
  consoleRelayJs, focusOnClickJs, INPUT_COMPAT_JS, keyForwarderJs, sseMuxJs,
  type DocumentChannel,
} from './appDocumentScripts.js';
import { nativeKeyboardJs } from './keyboard/nativeKeyboardScript.js';
import { syntheticReceiverJs } from './keyboard/receiverScript.js';

/**
 * `/_aura/runtime.js`: everything the proxy injects into a document, as one
 * script an App Host page loads itself (D43).
 *
 * All of it talks only to the verified Shell: `window.top` at the exact origin
 * derived from this page's own `location` (`{label}--{desktop}` → `{desktop}`),
 * never from a request header. There is no relay. A nested frame reports to the
 * Shell itself and the Shell posts straight back to it, so an embedding parent
 * app is never on the path and cannot inject keys (5.16 safeguard 1).
 */

const SHELL_ONLY = 'ev.origin!==SHELL||ev.source!==window.top';

export const APP_HOST_CHANNEL: DocumentChannel = {
  parent: 'window.top',
  target: 'SHELL',
  guard: `if(${SHELL_ONLY})return;`,
  muxPath: `'${AURA_RESERVED_PATHS.os}sse-mux'`,
  // The mux reaches the shell API only; an app's own streams stay native.
  muxSkip: `||abs.pathname.indexOf('${AURA_RESERVED_PATHS.os}')!==0`,
};

/**
 * A nested frame says when it takes focus, so the Shell knows where to post
 * keys. `hello` rather than `field`, which opens the on-screen keyboard.
 */
const NESTED_FOCUS_JS = String.raw`(function(){try{
if(window.parent===window.top)return;
function report(){try{window.top.postMessage({type:'aura.keyboard.hello',focused:true},SHELL);}catch(_){}}
addEventListener('focus',report);addEventListener('focusin',report,true);
}catch(_){}})();`;

export interface AppRuntimeInput {
  appId: string;
  instanceId: string;
  label: string;
  slot: number;
  cfg: ProxyConfig;
  themeStrategy: 'inherit' | 'themed' | 'override';
  framework: { id: string; version: string };
  theme: AuraRuntimeBootstrap['theme'];
  keymap: { actions: unknown[]; bindings: Record<string, string | null> };
}

export function buildAppRuntimeJs(input: AppRuntimeInput): string {
  const { cfg, theme, themeStrategy } = input;
  const appIdJs = JSON.stringify(input.appId);
  const bindings = Object.fromEntries(
    Object.entries(input.keymap.bindings).filter((e): e is [string, string] => e[1] !== null),
  );
  const bootstrap = {
    channelVersion: AURA_CHANNEL_VERSION,
    appId: input.appId,
    instanceId: input.instanceId,
    label: input.label,
    slot: input.slot,
    gatewayBase: AURA_RESERVED_PATHS.os,
    theme,
    keymap: { claims: [], bindings },
    consoleRelay: cfg.injectConsoleRelay,
  };
  const meta: Array<[string, string]> = [
    ['aura-app-id', input.appId],
    ['aura-instance-id', input.instanceId],
  ];
  if (cfg.injectMeta) {
    meta.push(
      ['aura-app-base-path', ''],
      ['aura-design-framework', input.framework.id],
      ['aura-design-framework-version', input.framework.version],
      ['aura-theme-strategy', themeStrategy],
      ['aura-color-mode', theme.colorMode],
      ['aura-resolved-mode', theme.resolvedMode],
      ['aura-keymap-actions', JSON.stringify(input.keymap.actions)],
      ['aura-keymap-bindings', JSON.stringify(input.keymap.bindings)],
    );
    if (themeStrategy !== 'override') {
      meta.push(
        ['aura-theme-id', theme.themeId],
        ['aura-theme-id-dark', theme.themeIdDark],
        ['aura-theme-id-light', theme.themeIdLight],
      );
    }
  }
  const themeCss = `${AURA_RESERVED_PATHS.os}api/os/theme.css`;
  const linkTheme = cfg.injectMeta && themeStrategy === 'inherit';

  const parts = [
    // The event-source shim and input compatibility must see app scripts first.
    cfg.injectEventSourceMux ? sseMuxJs(APP_HOST_CHANNEL) : '',
    cfg.injectInputCompat ? INPUT_COMPAT_JS : '',
    focusOnClickJs(APP_HOST_CHANNEL),
    cfg.injectConsoleRelay ? consoleRelayJs(appIdJs, APP_HOST_CHANNEL) : '',
    cfg.injectKeyForwarder ? keyForwarderJs(appIdJs, APP_HOST_CHANNEL) : '',
    cfg.injectKeyForwarder ? syntheticReceiverJs(SHELL_ONLY) : '',
    cfg.injectKeyForwarder ? nativeKeyboardJs('window.top', 'SHELL', `if(${SHELL_ONLY})return;`) : '',
    cfg.injectKeyForwarder ? NESTED_FOCUS_JS : '',
  ].filter(Boolean).join('\n');

  return `(function(){try{
if(window.AuraRuntimeBootstrap)return;
var LABEL=${JSON.stringify(input.label)},H=location.host,AT=H.indexOf('--');
if(AT<=0||H.slice(0,AT)!==LABEL)return;
var SHELL=location.protocol+'//'+H.slice(AT+2);
var B=${JSON.stringify(bootstrap)},ACT=null;
try{ACT=new URLSearchParams(location.search).get('_aura_activity');}catch(_){}
B.activityId=ACT;B.shellOrigin=SHELL;B.appOrigin=location.origin;
Object.freeze(B.theme);Object.freeze(B.keymap);
Object.defineProperty(window,'AuraRuntimeBootstrap',{value:Object.freeze(B)});
window.AURA_APP_ID=B.appId;window.AURA_INSTANCE_ID=B.instanceId;window.AURA_APP_BASE_PATH='';
var M=${JSON.stringify(meta)};if(ACT)M.push(['aura-activity-id',ACT]);
var HEAD=document.head||document.documentElement;
M.forEach(function(m){if(document.querySelector('meta[name="'+m[0]+'"]'))return;var e=document.createElement('meta');e.name=m[0];e.content=m[1];HEAD.appendChild(e);});
${linkTheme ? `if(!document.querySelector('link[href$="/api/os/theme.css"]')){var L=document.createElement('link');L.rel='stylesheet';L.href=${JSON.stringify(themeCss)};HEAD.appendChild(L);}` : ''}
${parts}
}catch(_){}})();
`;
}
