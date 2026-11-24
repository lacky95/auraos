/**
 * The scripts every app document runs: console relay, key forwarder, focus on
 * click, input compatibility and the EventSource multiplexer. App Host
 * documents get them from `/_aura/runtime.js` (lib/appRuntime.ts), talking
 * only to the verified Shell at its exact origin (APP_HOST_CHANNEL).
 *
 * Kept as ES5-style source in strings because they are served verbatim.
 */

/** How a script reaches the shell. Every field is a JS source fragment. */
export interface DocumentChannel {
  /** Expression for the window that receives reports. */
  parent: string;
  /** Expression for the postMessage target origin. */
  target: string;
  /** Statement that returns from a `message` handler unless the shell sent it. */
  guard: string;
  /** Expression for the multiplexer's WebSocket path. */
  muxPath: string;
  /** `||condition` that keeps a stream off the multiplexer. */
  muxSkip: string;
}

export const consoleRelayJs = (appIdJs: string, c: DocumentChannel): string => `(function(){try{
var P=${c.parent};if(!P||P===window)return;
var SRC=${appIdJs};
var LVL=['log','info','warn','error','debug'];
var orig={};LVL.forEach(function(l){orig[l]=console[l].bind(console);});
function fmt(a){if(a===null)return'null';if(a===undefined)return'undefined';if(typeof a==='string')return a;if(typeof a==='number'||typeof a==='boolean')return String(a);if(a instanceof Error)return a.name+': '+a.message+(a.stack?'\\n'+a.stack:'');try{var s=new WeakSet();return JSON.stringify(a,function(_k,v){if(typeof v==='object'&&v!==null){if(s.has(v))return'[Circular]';s.add(v);}if(typeof v==='function')return'[Function]';return v;},2)||String(a);}catch(e){try{return String(a);}catch(_){return'[unserializable]';}}}
function relay(lvl,args){try{P.postMessage({type:'aura.console.relay',entry:{type:'aura.console',level:lvl,timestamp:Date.now(),source:SRC,args:Array.from(args).map(fmt)}},${c.target});}catch(_){}}
LVL.forEach(function(l){console[l]=function(){orig[l].apply(console,arguments);relay(l,arguments);};});
window.addEventListener('error',function(e){relay('error',['Uncaught '+e.message+' at '+(e.filename||'?')+':'+(e.lineno||0)+':'+(e.colno||0)]);});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;var m=r instanceof Error?(r.name+': '+r.message+(r.stack?'\\n'+r.stack:'')):String(r);relay('error',['Unhandled rejection: '+m]);});
var shuttingDown=false;var openES=new Set();var openWS=new Set();
var NativeES=window.EventSource;if(NativeES){var W=function(u,i){var es=new NativeES(u,i);openES.add(es);var reported=false;es.addEventListener('error',function(){if(shuttingDown)return;if(reported)return;if(es.readyState!==2)return;reported=true;openES.delete(es);relay('debug',['EventSource closed: '+u]);});var origClose=es.close.bind(es);es.close=function(){openES.delete(es);return origClose();};return es;};W.prototype=NativeES.prototype;['CONNECTING','OPEN','CLOSED'].forEach(function(k,i){W[k]=i;});window.EventSource=W;}
var NativeWS=window.WebSocket;if(NativeWS){var WW=function(u,p){var ws=p?new NativeWS(u,p):new NativeWS(u);openWS.add(ws);ws.addEventListener('close',function(){openWS.delete(ws);});return ws;};WW.prototype=NativeWS.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k,i){WW[k]=i;});window.WebSocket=WW;}
var nFetch=window.fetch.bind(window);window.fetch=async function(input,init){var u=typeof input==='string'?input:(input&&input.url)||String(input);try{var r=await nFetch(input,init);if(!r.ok&&!shuttingDown){relay(r.status>=500?'error':'warn',['fetch '+((init&&init.method)||'GET')+' '+u+' \\u2192 '+r.status+' '+r.statusText]);}return r;}catch(e){if(!shuttingDown)relay('error',['fetch '+((init&&init.method)||'GET')+' '+u+' failed: '+(e&&e.message||String(e))]);throw e;}};
var X=window.XMLHttpRequest;if(X){var oO=X.prototype.open,oS=X.prototype.send;X.prototype.open=function(m,u){this.__am=m;this.__au=u;return oO.apply(this,arguments);};X.prototype.send=function(){var self=this;this.addEventListener('error',function(){if(!shuttingDown)relay('error',['xhr '+self.__am+' '+self.__au+' network error']);});this.addEventListener('load',function(){if(self.status>=400&&!shuttingDown){relay(self.status>=500?'error':'warn',['xhr '+self.__am+' '+self.__au+' \\u2192 '+self.status]);}});return oS.apply(this,arguments);};}
// Lifecycle: the shell postMessages 'aura.shutdown' before removing the iframe.
// Closing tracked EventSource/WebSocket first means their teardown is a clean
// .close() call rather than a network-abort, so no spurious error events fire
// in the moments before the iframe is torn down. We ack so the shell knows it
// can proceed; the shell has a hard timeout regardless.
window.addEventListener('message',function(ev){${c.guard}if(!ev.data||ev.data.type!=='aura.shutdown')return;shuttingDown=true;try{openES.forEach(function(es){try{es.close();}catch(_){}});openWS.forEach(function(ws){try{ws.close(1000,'app-shutdown');}catch(_){}});openES.clear();openWS.clear();}catch(_){}try{P.postMessage({type:'aura.shutdown.done',source:SRC},${c.target});}catch(_){}});
}catch(_){}})();`;

export const keyForwarderJs = (appIdJs: string, c: DocumentChannel): string => `(function(){try{
var P=${c.parent};if(!P||P===window)return;
var SRC=${appIdJs};
var claims=new Set();
var mod={cl:0,cr:0,al:0,ar:0,sl:0,sr:0,ml:0,mr:0};
function isMod(c){return c==='ControlLeft'||c==='ControlRight'||c==='AltLeft'||c==='AltRight'||c==='ShiftLeft'||c==='ShiftRight'||c==='MetaLeft'||c==='MetaRight'||c==='OSLeft'||c==='OSRight';}
function setMod(c,v){if(c==='ControlLeft')mod.cl=v;else if(c==='ControlRight')mod.cr=v;else if(c==='AltLeft')mod.al=v;else if(c==='AltRight')mod.ar=v;else if(c==='ShiftLeft')mod.sl=v;else if(c==='ShiftRight')mod.sr=v;else if(c==='MetaLeft'||c==='OSLeft')mod.ml=v;else if(c==='MetaRight'||c==='OSRight')mod.mr=v;}
function pick(e,name,lf,rt){var n=e[name];if(!n)return null;if(rt&&!lf)return 'R'+'_';/*placeholder*/return lf&&!rt?'L_':null;}
function combo(e){
  var c=e.code;
  if(isMod(c))return c;
  var p=[];
  if(e.ctrlKey){p.push(mod.cr&&!mod.cl?'RCtrl':(mod.cl&&!mod.cr?'LCtrl':'Ctrl'));}
  if(e.altKey){p.push(mod.ar&&!mod.al?'RAlt':(mod.al&&!mod.ar?'LAlt':'Alt'));}
  if(e.shiftKey){p.push(mod.sr&&!mod.sl?'RShift':(mod.sl&&!mod.sr?'LShift':'Shift'));}
  if(e.metaKey){p.push(mod.mr&&!mod.ml?'RSuper':(mod.ml&&!mod.mr?'LSuper':'Super'));}
  p.push(c);
  return p.join('+');
}
function expand(combo){
  // Mirror @aura/core/keymap's expandCombo: enumerate generic siblings
  // so a binding of "Shift+Enter" matches "RShift+Enter" etc.
  var segs=combo.split('+');
  if(segs.length<=1)return [combo];
  var key=segs[segs.length-1];
  var mods=segs.slice(0,-1);
  var variants=[[]];
  for(var i=0;i<mods.length;i++){
    var m=mods[i];var base=m;var sided=false;
    if(m==='RShift'||m==='LShift'){base='Shift';sided=true;}
    else if(m==='RCtrl'||m==='LCtrl'){base='Ctrl';sided=true;}
    else if(m==='RAlt'||m==='LAlt'){base='Alt';sided=true;}
    else if(m==='RSuper'||m==='LSuper'){base='Super';sided=true;}
    var next=[];
    for(var v=0;v<variants.length;v++){
      next.push(variants[v].concat([m]));
      if(sided)next.push(variants[v].concat([base]));
    }
    variants=next;
  }
  var out=[];
  for(var v2=0;v2<variants.length;v2++){
    out.push(variants[v2].concat([key]).join('+'));
  }
  return out;
}
window.addEventListener('message',function(ev){${c.guard}var d=ev.data;if(!d||d.type!=='aura.key.claim')return;claims=new Set(Array.isArray(d.combos)?d.combos:[]);});
window.addEventListener('keydown',function(e){
  if(isMod(e.code))setMod(e.code,1);
  var c=combo(e);if(!c)return;
  // Iframe-side match must mirror dispatcher: expand the physical combo
  // and forward if ANY generic sibling is claimed.
  var cands=expand(c);var hit=false;for(var i=0;i<cands.length;i++){if(claims.has(cands[i])){hit=true;break;}}
  if(!hit)return;
  e.preventDefault();e.stopPropagation();
  try{P.postMessage({type:'aura.key',combo:c,appId:SRC},${c.target});}catch(_){}
},{capture:true});
window.addEventListener('keyup',function(e){
  if(isMod(e.code))setMod(e.code,0);
  // Firefox-on-Linux ergonomic fix: a lone Alt keyup opens Firefox's
  // window menu (File / Edit / View …), which steals focus from the
  // iframe. That fires on AltGr release too — so pressing AltGr+Q to
  // type @ (German layout) or AltGr+E for € pops the menu and kicks
  // the user out of the terminal. preventDefault on every Alt /
  // AltGraph keyup suppresses that activation without otherwise
  // changing keyboard behaviour. Chromium isn't affected; the call is
  // a no-op there.
  if(e.key==='Alt'||e.key==='AltGraph'){e.preventDefault();}
},{capture:true});
window.addEventListener('blur',function(){mod.cl=mod.cr=mod.al=mod.ar=mod.sl=mod.sr=mod.ml=mod.mr=0;});
}catch(_){}})();`;

export function focusOnClickJs(c: DocumentChannel): string {
  const p = c.parent;
  return `(function(){try{
if(window.__auraFocusOnClick)return;window.__auraFocusOnClick=true;
addEventListener('pointerdown',function(){try{if(!document.hasFocus())window.focus();}catch(_){}
try{if(${p}!==window)${p}.postMessage({type:'aura.pointerdown'},${c.target});}catch(_){}} ,true);
}catch(_){}})();`;
}

export const INPUT_COMPAT_JS = `(function(){try{
if(window.__auraInputCompat||!('ontouchstart' in window))return;
window.__auraInputCompat=true;
var ET=EventTarget.prototype,oAdd=ET.addEventListener,oRem=ET.removeEventListener;
var hov=null;
oAdd.call(window,'mousemove',function(e){if(e.isTrusted)hov={x:e.clientX,y:e.clientY};},true);
function moveTo(e){
  if(hov&&Math.abs(hov.x-e.clientX)<1.5&&Math.abs(hov.y-e.clientY)<1.5)return;
  var init={bubbles:true,cancelable:true,composed:true,view:window,clientX:e.clientX,clientY:e.clientY,screenX:e.screenX,screenY:e.screenY,button:0,buttons:0,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,metaKey:e.metaKey};
  try{
    if(typeof PointerEvent==='function')e.target.dispatchEvent(new PointerEvent('pointermove',Object.assign({pointerId:e.pointerId,pointerType:'mouse',isPrimary:true},init)));
    e.target.dispatchEvent(new MouseEvent('mousemove',init));
  }catch(_){}
  hov={x:e.clientX,y:e.clientY};
}
function onBtn(e){if(e.isTrusted&&e.pointerType==='mouse')moveTo(e);}
function onHover(e){if(e.isTrusted&&e.pointerType==='mouse'&&e.buttons===0)moveTo(e);}
oAdd.call(window,'pointerdown',onBtn,true);
oAdd.call(window,'pointerup',onBtn,true);
oAdd.call(window,'pointermove',onHover,true);
oAdd.call(window,'pointerover',onHover,true);
if(typeof Touch!=='function'||typeof TouchEvent!=='function')return;
var WATCH={touchstart:1,mousedown:1,pointerdown:1};
var reg=new WeakMap();
function slot(el,t,o,make){var m=reg.get(el);if(!m){if(!make)return null;m=new Map();reg.set(el,m);}var k=t+((typeof o==='boolean'?o:!!(o&&o.capture))?'!':'');var s=m.get(k);if(!s&&make){s=new Set();m.set(k,s);}return s||null;}
ET.addEventListener=function(t,l,o){if(l&&WATCH[t]===1&&this instanceof Element)slot(this,t,o,true).add(l);return oAdd.apply(this,arguments);};
ET.removeEventListener=function(t,l,o){if(l&&WATCH[t]===1&&this instanceof Element){var s=slot(this,t,o,false);if(s)s.delete(l);}return oRem.apply(this,arguments);};
function has(el,t){var m=reg.get(el);if(!m)return false;var a=m.get(t),b=m.get(t+'!');return !!((a&&a.size)||(b&&b.size));}
function handlesMouse(el){return has(el,'mousedown')||has(el,'pointerdown')||typeof el.onmousedown==='function'||typeof el.onpointerdown==='function';}
var g=null;
function fire(type,e){try{var t=new Touch({identifier:g.id,target:g.el,clientX:e.clientX,clientY:e.clientY,pageX:e.pageX,pageY:e.pageY,screenX:e.screenX,screenY:e.screenY});var end=type==='touchend'||type==='touchcancel';g.el.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,composed:true,touches:end?[]:[t],targetTouches:end?[]:[t],changedTouches:[t]}));}catch(_){g=null;}}
oAdd.call(document,'pointerdown',function(e){
  if(g||e.pointerType!=='mouse'||e.button!==0)return;
  var path=e.composedPath();
  for(var i=0;i<path.length;i++){var el=path[i];if(el===document||el===window)return;if(!(el instanceof Element))continue;if(handlesMouse(el))return;if(has(el,'touchstart')){g={pointerId:e.pointerId,id:4155+(e.pointerId|0),el:el};fire('touchstart',e);return;}}
},true);
function follow(type,end){return function(e){if(!g||e.pointerId!==g.pointerId)return;fire(type,e);if(end)g=null;};}
oAdd.call(window,'pointermove',follow('touchmove',false),true);
oAdd.call(window,'pointerup',follow('touchend',true),true);
oAdd.call(window,'pointercancel',follow('touchcancel',true),true);
}catch(_){}})();`;

export const sseMuxJs = (c: DocumentChannel): string => `(function(){try{
var NES=window.EventSource;if(!NES||window.__auraSseMux||typeof WebSocket!=='function'||typeof EventTarget!=='function')return;
window.__auraSseMux=true;
var PATH=${c.muxPath};
var ws=null,wsState=0,everOpened=false,nextId=1,streams=new Map(),queue=[];
function wsSend(m){var s=JSON.stringify(m);if(wsState===2)ws.send(s);else queue.push(s);}
function fallbackAll(){queue=[];streams.forEach(function(s){s._native();});}
function connect(){
  if(wsState!==0)return;wsState=1;
  var sock;try{sock=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+PATH);}catch(_){wsState=3;fallbackAll();return;}
  ws=sock;
  sock.onopen=function(){wsState=2;everOpened=true;var q=queue;queue=[];q.forEach(function(s){sock.send(s);});};
  sock.onmessage=function(e){var m;try{m=JSON.parse(e.data);}catch(_){return;}var s=streams.get(m.id);if(s)s._frame(m);};
  sock.onclose=function(){if(ws!==sock)return;ws=null;queue=[];
    if(!everOpened){wsState=3;fallbackAll();return;}
    wsState=0;streams.forEach(function(s){s._drop();});};
}
class AuraEventSource extends EventTarget{
  constructor(url,init){
    super();
    var abs=new URL(String(url),location.href);
    if(abs.origin!==location.origin||abs.pathname===PATH||wsState===3${c.muxSkip})return new NES(url,init);
    this.url=abs.href;this.withCredentials=!!(init&&init.withCredentials);
    this.readyState=0;this.onopen=null;this.onmessage=null;this.onerror=null;
    this._id=nextId++;this._path=abs.pathname+abs.search;this._last='';this._retry=3000;this._timer=0;this._types=new Set();this._nat=null;this._bound=null;
    streams.set(this._id,this);
    this._open();
  }
  _open(){this._timer=0;if(this.readyState===2||this._nat)return;connect();if(this._nat||wsState===3)return;wsSend({op:'open',id:this._id,url:this._path,lastEventId:this._last});}
  _fire(type,init){var ev=init?new MessageEvent(type,init):new Event(type);this.dispatchEvent(ev);var h=type==='open'?this.onopen:type==='error'?this.onerror:type==='message'?this.onmessage:null;if(typeof h==='function'){try{h.call(this,ev);}catch(e){setTimeout(function(){throw e;});}}}
  _frame(m){if(this.readyState===2||this._nat)return;
    if(m.op==='open'){this.readyState=1;this._fire('open');}
    else if(m.op==='event'){this._last=m.lastEventId||'';this._fire(m.type,{data:m.data,lastEventId:this._last,origin:location.origin});}
    else if(m.op==='retry'){this._retry=m.ms;}
    else if(m.op==='end'){this._drop();}
    else if(m.op==='fail'){this.readyState=2;streams.delete(this._id);this._fire('error');}}
  _drop(){if(this.readyState===2||this._nat||this._timer)return;this.readyState=0;this._fire('error');if(this.readyState===2)return;var self=this;this._timer=setTimeout(function(){self._open();},this._retry);}
  _native(){if(this.readyState===2||this._nat)return;clearTimeout(this._timer);this._timer=0;var self=this,n=new NES(this.url,{withCredentials:this.withCredentials});this._nat=n;this._bound=new Set();
    n.onopen=function(){self.readyState=n.readyState;self._fire('open');};
    n.onerror=function(){self.readyState=n.readyState;self._fire('error');};
    ['message'].concat(Array.from(this._types)).forEach(function(t){self._bind(t);});}
  _bind(t){if(t==='open'||t==='error'||this._bound.has(t))return;this._bound.add(t);var self=this;this._nat.addEventListener(t,function(e){self._last=e.lastEventId;self._fire(t,{data:e.data,lastEventId:e.lastEventId,origin:e.origin});});}
  addEventListener(t,l,o){this._types.add(t);if(this._nat)this._bind(t);return super.addEventListener(t,l,o);}
  close(){if(this.readyState===2)return;this.readyState=2;clearTimeout(this._timer);this._timer=0;streams.delete(this._id);if(this._nat){this._nat.close();return;}if(wsState!==3)wsSend({op:'close',id:this._id});}
}
['CONNECTING','OPEN','CLOSED'].forEach(function(k,i){Object.defineProperty(AuraEventSource,k,{value:i});Object.defineProperty(AuraEventSource.prototype,k,{value:i});});
Object.defineProperty(AuraEventSource,Symbol.hasInstance,{value:function(o){return o instanceof NES||Object.prototype.isPrototypeOf.call(AuraEventSource.prototype,o);}});
window.EventSource=AuraEventSource;
}catch(_){}})();`;
