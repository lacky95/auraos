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
const SHELL_THEME_PATH = '/api/os/theme.css';

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

/**
 * Adds the theme for a page that doesn't link it. While the parser is waiting
 * on this script, `document.write` makes the link parser-created, so it blocks
 * first paint in every engine and the page never shows unthemed.
 *
 * A client-side router (Astro's ClientRouter, Turbo, htmx) swaps `<head>` for
 * the next page's, which has no such link, and the runtime does not run again.
 * Astro's `astro:before-swap` gets the link into the incoming head with the
 * current link's exact href (a refresh adds `?t=`), since Astro keeps a loaded
 * stylesheet only when the new head links the same href: no refetch, no flash.
 * Any other router that drops it gets it back from the head observer.
 */
function themeLinkJs(href: string): string {
  const h = JSON.stringify(href);
  return `var TQ='link[rel="stylesheet"][href*="${SHELL_THEME_PATH}"]';`
    + `var TH=function(d){if(d.querySelector(TQ))return;var C=document.querySelector(TQ),L=d.createElement('link');`
    + `L.rel='stylesheet';L.href=C?C.getAttribute('href'):${h};(d.head||d.documentElement).appendChild(L);};`
    + `var CS=document.currentScript;`
    + `if(document.readyState==='loading'&&CS&&!CS.async&&!CS.defer){if(!document.querySelector(TQ))document.write('<link rel="stylesheet" href="'+${h}+'">');}`
    + `else TH(document);`
    + `document.addEventListener('astro:before-swap',function(e){if(e.newDocument)TH(e.newDocument);});`
    + `if(typeof MutationObserver==='function')new MutationObserver(function(){TH(document);}).observe(HEAD,{childList:true});`;
}

/**
 * The Shell announces a theme or mode change; a loaded stylesheet won't refetch
 * by itself. Covers the link added above and an app's own `/api/os/theme.css`
 * tag (which the SDK's asset route redirects to the gateway).
 */
function themeRefreshJs(gatewayHref: string): string {
  return `addEventListener('message',function(ev){if(${SHELL_ONLY})return;var t=ev.data&&ev.data.type;`
    + `if(t!=='aura.theme.changed'&&t!=='aura.mode.changed')return;`
    + `document.querySelectorAll('link[rel="stylesheet"]').forEach(function(l){`
    + `var h=(l.getAttribute('href')||'').split('?')[0];`
    + `if(h==='${SHELL_THEME_PATH}'||h===${JSON.stringify(gatewayHref)})l.setAttribute('href',h+'?t='+Date.now());});});`;
}

export interface AppRuntimeInput {
  appId: string;
  instanceId: string;
  label: string;
  slot: number;
  cfg: ProxyConfig;
  themeStrategy: 'inherit' | 'themed' | 'override';
  framework: { id: string; version: string };
  theme: Omit<AuraRuntimeBootstrap['theme'], 'strategy' | 'framework'>;
  keymap: { bindings: Record<string, string | null> };
  /** Back stack per Activity of this instance; the page picks its own by `_aura_activity`. */
  histories: Record<string, Array<{ path: string; title?: string }>>;
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
    theme: { ...theme, strategy: themeStrategy, framework: input.framework },
    keymap: { claims: [], bindings },
    consoleRelay: cfg.injectConsoleRelay,
  };
  const themeCss = `${AURA_RESERVED_PATHS.os}${SHELL_THEME_PATH.slice(1)}`;
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
var B=${JSON.stringify(bootstrap)},HIST=${JSON.stringify(input.histories)},ACT=null;
try{ACT=new URLSearchParams(location.search).get('_aura_activity');}catch(_){}
B.activityId=ACT;B.activityHistory=Object.freeze((ACT&&Object.prototype.hasOwnProperty.call(HIST,ACT)&&HIST[ACT])||[]);
B.shellOrigin=SHELL;B.appOrigin=location.origin;
Object.freeze(B.theme.framework);Object.freeze(B.theme);Object.freeze(B.keymap);
Object.defineProperty(window,'AuraRuntimeBootstrap',{value:Object.freeze(B)});
var HEAD=document.head||document.documentElement;
${linkTheme ? themeLinkJs(themeCss) : ''}
${themeRefreshJs(themeCss)}
${parts}
}catch(_){}})();
`;
}
