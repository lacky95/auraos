/**
 * Virtual-keyboard relay for documents that hold their own iframes, as part
 * of `/api/os/keyboard.js` (pages/api/os/keyboard.js.ts).
 *
 * The receiver (receiverScript.ts) types into the focused element of ITS
 * document; when focus sits in a child iframe that element is the <iframe>,
 * so keys went nowhere. This passes the keyboard's messages one frame down
 * and the frames' reports one frame up — the same relay the Browser app does
 * for its engine, for any document that loads the bundle:
 *
 *   parent → focused child iframe: aura.key.synthetic
 *   parent → every child iframe:   aura.keyboard.policy
 *   child  → parent:               aura.keyboard.hello / .field / .open / .close
 *
 * A synthetic key that is passed down is stopped here, so this document's own
 * receiver doesn't also fire it at the <iframe> element (where the page's
 * shortcuts would see it). Must run BEFORE the receiver: the bundle puts it first.
 *
 * Kept as ES5-style source in a string because it is served verbatim.
 *
 * PHASE2-CUTOVER: a relay lets an embedding parent type into its child. App Hosts use lib/appRuntime.ts instead.
 */
export const FRAME_RELAY_JS = String.raw`(function(){try{
if(window.__auraKbRelay||window.parent===window)return;window.__auraKbRelay=true;
var UP={'aura.keyboard.hello':1,'aura.keyboard.field':1,'aura.keyboard.open':1,'aura.keyboard.close':1};
function isChild(w){for(var i=0;i<window.frames.length;i++)if(window.frames[i]===w)return true;return false;}
function field(el){if(!el||el.tagName==='IFRAME')return false;if(el.isContentEditable||el.tagName==='TEXTAREA')return true;return el.tagName==='INPUT'&&/^(text|search|email|url|tel|password|number|)$/i.test(el.type||'');}
window.addEventListener('message',function(e){
  var d=e.data;if(!d||typeof d!=='object'||typeof d.type!=='string')return;
  if(e.source===window.parent){
    if(d.type==='aura.keyboard.policy'){var fs=document.querySelectorAll('iframe');for(var i=0;i<fs.length;i++){try{fs[i].contentWindow&&fs[i].contentWindow.postMessage(d,'*');}catch(_){}}return;}
    if(d.type==='aura.key.synthetic'){var a=document.activeElement;if(a&&a.tagName==='IFRAME'&&a.contentWindow){e.stopImmediatePropagation();try{a.contentWindow.postMessage(d,'*');}catch(_){}}}
    return;
  }
  if(!UP[d.type]||!isChild(e.source))return;
  if(d.type==='aura.keyboard.field'&&!d.focused&&field(document.activeElement))return;
  try{window.parent.postMessage(d,'*');}catch(_){}
});
}catch(_){}})();`;
