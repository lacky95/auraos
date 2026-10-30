/**
 * Receiver for virtual-keyboard input (`aura.key.synthetic`).
 *
 * One implementation, installed in two places:
 *   • every proxied app document (proxy/[id]/[...path].ts, next to the key
 *     forwarder), so the shell can type into a focused app iframe;
 *   • the shell page itself (OSLayout), so the keyboard can type into shell
 *     inputs (launcher search, dialogs) through the same code path.
 *
 * Only messages from `window.parent` are accepted. In an app that is the
 * shell; in the shell (a top-level page) `parent === window`, so only the
 * shell itself can post. An app can never inject keys into the shell or into
 * another app.
 *
 * Synthetic events are `isTrusted === false`: they reach JS listeners (xterm,
 * CodeMirror, Monaco, app shortcuts) but the browser does no editing for
 * them. For plain <input>/<textarea> and contenteditable elements we
 * emulate the common edits (insert text, Backspace/Delete, caret moves,
 * Enter) — but only when the app didn't preventDefault the keydown, so apps
 * that handle keys themselves are never edited twice.
 *
 * Kept as ES5-style source in a string because it is injected verbatim as a
 * <script>; do not reference anything outside the IIFE.
 */
export const SYNTHETIC_RECEIVER_JS = String.raw`(function(){try{
if(window.__auraSynthRx)return;window.__auraSynthRx=true;
function active(d){var a=d.activeElement;while(a&&a.shadowRoot&&a.shadowRoot.activeElement)a=a.shadowRoot.activeElement;return a||d.body;}
var lastEl=null;
document.addEventListener('focusin',function(e){var t=e.composedPath?e.composedPath()[0]:e.target;if(t&&t.nodeType===1&&t!==document.body&&t!==document.documentElement)lastEl=t;},true);
function usable(el){if(!el||!el.isConnected||el.disabled)return false;if(el.classList&&el.classList.contains('xterm-helper-textarea'))return true;var r=el.getClientRects?el.getClientRects():null;return !r||r.length>0;}
// Where keys go. A tap into a window doesn't always leave an element focused
// inside it (touch, or the app moved focus away), and xterm and most apps
// ignore keys on <body>. Then restore the element that had focus last in this
// page, else the terminal's input, else an [autofocus] field.
function target(){
  var a=active(document);
  if(a&&a!==document.body&&a!==document.documentElement)return a;
  var c=usable(lastEl)?lastEl:null;
  if(!c){var x=document.querySelector('.xterm-helper-textarea,[autofocus]');if(usable(x))c=x;}
  if(c){try{c.focus({preventScroll:true});}catch(_){}var now=active(document);if(now&&now!==document.body&&now!==document.documentElement)return now;}
  return a||document.body;
}
function isField(t){if(!t)return false;if(t.tagName==='TEXTAREA')return true;if(t.tagName!=='INPUT')return false;return /^(text|search|email|url|tel|password|number|)$/i.test(t.type||'');}
function isXterm(t){return !!(t&&t.classList&&t.classList.contains('xterm-helper-textarea'));}
function caret(t){try{return [t.selectionStart,t.selectionEnd];}catch(_){return null;}}
function edit(t,inputType,data,apply){
  if(!t.dispatchEvent(new InputEvent('beforeinput',{inputType:inputType,data:data,bubbles:true,cancelable:true})))return;
  apply();
  t.dispatchEvent(new InputEvent('input',{inputType:inputType,data:data,bubbles:true}));
}
function insertText(t,text){
  if(t.isContentEditable){
    if(!t.dispatchEvent(new InputEvent('beforeinput',{inputType:text==='\n'?'insertParagraph':'insertText',data:text,bubbles:true,cancelable:true})))return;
    document.execCommand(text==='\n'?'insertParagraph':'insertText',false,text);return;
  }
  if(!isField(t))return;
  var c=caret(t);
  edit(t,text==='\n'?'insertLineBreak':'insertText',text,function(){
    if(c&&c[0]!=null){t.setRangeText(text,c[0],c[1],'end');}
    else{var d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t),'value');if(d&&d.set)d.set.call(t,(t.value||'')+text);else t.value=(t.value||'')+text;}
  });
}
function editKey(t,key,shift,ctrl){
  if(t.isContentEditable){
    var sel=window.getSelection&&window.getSelection();
    if(key==='Backspace'){document.execCommand('delete');return;}
    if(key==='Delete'){document.execCommand('forwardDelete');return;}
    if(!sel||!sel.modify)return;
    var how=shift?'extend':'move';
    if(key==='ArrowLeft')sel.modify(how,'backward',ctrl?'word':'character');
    else if(key==='ArrowRight')sel.modify(how,'forward',ctrl?'word':'character');
    else if(key==='ArrowUp')sel.modify(how,'backward','line');
    else if(key==='ArrowDown')sel.modify(how,'forward','line');
    else if(key==='Home')sel.modify(how,'backward','lineboundary');
    else if(key==='End')sel.modify(how,'forward','lineboundary');
    return;
  }
  if(!isField(t))return;
  if(ctrl&&(key==='a'||key==='A')){t.select();return;}
  var c=caret(t);if(!c||c[0]==null)return;
  var s=c[0],e=c[1],v=t.value||'',len=v.length;
  if(key==='Backspace'){if(s===e&&s===0)return;edit(t,'deleteContentBackward',null,function(){t.setRangeText('',s===e?s-1:s,e,'end');});return;}
  if(key==='Delete'){if(s===e&&e>=len)return;edit(t,'deleteContentForward',null,function(){t.setRangeText('',s,s===e?e+1:e,'start');});return;}
  var to=null;
  if(key==='ArrowLeft')to=s===e||shift?Math.max(0,(shift?(t.selectionDirection==='backward'?s:e):s)-1):s;
  else if(key==='ArrowRight')to=s===e||shift?Math.min(len,(shift?(t.selectionDirection==='backward'?s:e):e)+1):e;
  else if(key==='Home'){var ls=t.tagName==='TEXTAREA'?v.lastIndexOf('\n',s-1)+1:0;to=ls;}
  else if(key==='End'){var le=t.tagName==='TEXTAREA'?v.indexOf('\n',e):-1;to=le<0?len:le;}
  if(to==null)return;
  if(shift){var anchor=t.selectionDirection==='backward'?e:s;if(to<anchor)t.setSelectionRange(to,anchor,'backward');else t.setSelectionRange(anchor,to,'forward');}
  else t.setSelectionRange(to,to);
}
window.addEventListener('message',function(ev){
  var d=ev.data;if(!d||d.type!=='aura.key.synthetic')return;
  if(ev.source!==window.parent)return;
  var t=target();
  var mods={ctrlKey:!!d.ctrl,altKey:!!d.alt,shiftKey:!!d.shift,metaKey:!!d.meta};
  if(d.action==='text'){if(d.text&&!isXterm(t))insertText(t,String(d.text));
    else if(d.text&&isXterm(t)){for(var i=0;i<d.text.length;i++){var ch=d.text[i];var ki={key:ch,code:'',keyCode:ch.charCodeAt(0),which:ch.charCodeAt(0),charCode:ch.charCodeAt(0),bubbles:true,cancelable:true,composed:true};t.dispatchEvent(new KeyboardEvent('keypress',ki));}}
    return;}
  var init={key:d.key||'',code:d.code||'',keyCode:d.keyCode||0,which:d.keyCode||0,repeat:!!d.repeat,ctrlKey:mods.ctrlKey,altKey:mods.altKey,shiftKey:mods.shiftKey,metaKey:mods.metaKey,bubbles:true,cancelable:true,composed:true};
  if(d.action==='keyup'){t.dispatchEvent(new KeyboardEvent('keyup',init));return;}
  if(!t.dispatchEvent(new KeyboardEvent('keydown',init)))return;
  var k=init.key;
  var printable=k.length===1&&!mods.ctrlKey&&!mods.altKey&&!mods.metaKey;
  if(printable||k==='Enter'){
    var cc=k==='Enter'?13:k.charCodeAt(0);
    var kp=new KeyboardEvent('keypress',{key:k,code:init.code,keyCode:cc,which:cc,charCode:cc,ctrlKey:mods.ctrlKey,altKey:mods.altKey,shiftKey:mods.shiftKey,metaKey:mods.metaKey,bubbles:true,cancelable:true,composed:true});
    if(!t.dispatchEvent(kp))return;
    if(isXterm(t))return;
    if(printable){insertText(t,k);return;}
    if(t.tagName==='TEXTAREA'||t.isContentEditable){insertText(t,'\n');return;}
    if(t.tagName==='INPUT'&&t.form&&t.form.requestSubmit){try{t.form.requestSubmit();}catch(_){}}
    return;
  }
  if(isXterm(t))return;
  editKey(t,k,mods.shiftKey,mods.ctrlKey||mods.metaKey);
});
}catch(_){}})();`;
