/**
 * Device-keyboard policy (`aura.keyboard.policy`): keep the device's own
 * on-screen keyboard (iPad, iPhone, Android) away from text fields, so the
 * shell's virtual keyboard is the only one that comes up.
 *
 * Installed next to the synthetic-key receiver, in the same two places: every
 * proxied app document and the shell page itself. The shell owns the setting
 * (`kbState.$suppressNative`, OS KV `os/virtual-keyboard/suppressNative`) and
 * tells each document about it:
 *
 *   document → shell  { type: 'aura.keyboard.hello' }            on load
 *   shell → document  { type: 'aura.keyboard.policy', suppressNative }  reply + on change
 *   document → shell  { type: 'aura.keyboard.field', focused }   a text field got /
 *                                                                 lost focus (touch screens)
 *
 * The only web-side switch Safari honours is `inputmode="none"`: focus and
 * the caret stay, no on-screen keyboard appears, hardware keyboards still
 * type. Chromium honours it too. The attribute is set *before* focus lands
 * (pointerdown, capture) because iOS picks the keyboard when the element is
 * focused; `focusin` covers fields an app focuses itself, which iOS 13+
 * re-evaluates live. The original value is kept in `data-aura-inputmode` and
 * put back when the policy is turned off, so apps keep their own hints.
 *
 * The `field` messages let the shell open its keyboard when a field gets
 * focus and close it again when focus leaves — the device keyboard's own
 * behaviour. They are only sent on coarse-pointer (touch) screens.
 *
 * Kept as ES5-style source in a string because it is injected verbatim as a
 * <script>; do not reference anything outside the IIFE.
 */
export const NATIVE_KEYBOARD_JS = String.raw`(function(){try{
if(window.__auraNativeKb)return;window.__auraNativeKb=true;
var P=window.parent||window,on=false,muted=[],ATTR='data-aura-inputmode',blurTimer=null;
function coarse(){try{return matchMedia('(pointer: coarse)').matches;}catch(_){return false;}}
function editable(el){if(!el||el.nodeType!==1||el.disabled||el.readOnly)return false;if(el.isContentEditable)return true;var t=el.tagName;if(t==='TEXTAREA')return true;if(t!=='INPUT')return false;return /^(text|search|email|url|tel|password|number|)$/i.test(el.type||'');}
function deepTarget(e){var p=e.composedPath?e.composedPath():null;var t=p&&p[0];return t&&t.nodeType===1?t:e.target;}
function focused(){var a=document.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return a;}
function mute(el){if(!editable(el))return;if(!el.hasAttribute(ATTR)){el.setAttribute(ATTR,el.getAttribute('inputmode')||'');muted.push(el);}if(el.getAttribute('inputmode')!=='none')el.setAttribute('inputmode','none');}
function unmuteAll(){for(var i=0;i<muted.length;i++){var el=muted[i],o=el.getAttribute(ATTR);if(o)el.setAttribute('inputmode',o);else el.removeAttribute('inputmode');el.removeAttribute(ATTR);}muted=[];}
function post(m){try{P.postMessage(m,P===window?location.origin:'*');}catch(_){}}
function setOn(v){v=!!v;if(v===on)return;on=v;if(on)mute(focused());else unmuteAll();}
addEventListener('pointerdown',function(e){if(on)mute(deepTarget(e));},true);
addEventListener('focusin',function(e){var t=deepTarget(e);if(on)mute(t);if(editable(t)&&coarse()){clearTimeout(blurTimer);post({type:'aura.keyboard.field',focused:true});}},true);
addEventListener('focusout',function(e){if(!editable(deepTarget(e))||!coarse())return;clearTimeout(blurTimer);blurTimer=setTimeout(function(){if(!editable(focused()))post({type:'aura.keyboard.field',focused:false});},200);},true);
addEventListener('message',function(ev){var d=ev.data;if(!d||d.type!=='aura.keyboard.policy'||ev.source!==P)return;setOn(d.suppressNative);});
post({type:'aura.keyboard.hello'});
}catch(_){}})();`;
