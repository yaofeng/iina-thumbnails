const { core, menu, utils, overlay, input, event, file, preferences } = iina;

// UI language follows the system locale (JavaScriptCore's Intl uses the macOS setting).
let LANG='en';
try{if(/^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale||''))LANG='zh';}catch(_){}
const I18N={
  en:{menu:'Show Thumbnails',count:'Thumbnails',blur:'Background blur',preview:'Play on hover',loading:'Loading thumbnails…',
    noVideo:'No local video is ready.',noDir:'IINA thumbnail-cache directory does not exist yet.',
    noCache:h=>`IINA has not generated the native thumbnail cache for this video yet. Expected cache: ${h}`,
    readFail:e=>`Could not read IINA thumbnail cache: ${e}`,hashFail:e=>`Could not calculate IINA cache name: ${e}`,
    noHash:'Could not calculate IINA cache name.',badHash:h=>`Unexpected IINA cache name: ${h}`},
  zh:{menu:'显示缩略图',count:'缩略图',blur:'背景模糊',preview:'悬停播放',loading:'正在加载缩略图…',
    noVideo:'当前没有可用的本地视频。',noDir:'IINA 的缩略图缓存目录还不存在。',
    noCache:h=>`IINA 还没有为这个视频生成缩略图缓存。预期的缓存文件：${h}`,
    readFail:e=>`无法读取 IINA 缩略图缓存：${e}`,hashFail:e=>`无法计算 IINA 缓存文件名：${e}`,
    noHash:'无法计算 IINA 缓存文件名。',badHash:h=>`异常的 IINA 缓存文件名：${h}`}
}[LANG];

const DEFAULT_COUNT=20;
function columnsForCount(n){
  // Choose the column count that makes the 4:3 thumbnails as large as possible
  // while still fitting every row inside the available panel.
  const frame=core.window.frame;
  const W=Number(frame.width)||0, H=Number(frame.height)||0;
  const panelW=W*.94, panelH=H-48-56-38, gap=8;
  if(!W||!H||panelW<=0||panelH<=0) return n<=20?5:n<=30?6:7;
  let bestCols=5, bestCellW=0;
  for(let cols=3;cols<=16;cols++){
    const rows=Math.ceil(n/cols);
    const maxW=(panelW-gap*(cols-1))/cols;
    const maxH=(panelH-gap*(rows-1))/rows;
    const cellW=Math.min(maxW,maxH*4/3);
    if(cellW>bestCellW){bestCellW=cellW;bestCols=cols;}
  }
  return bestCols;
}
let count=DEFAULT_COUNT;
let visible=false, overlayReady=false, thumbs=[], mouseHandlerInstalled=false, pollTimer=null, resizeWatchTimer=null, lastResizeW=0, lastResizeH=0, blurEnabled=true, selected=-1, previewEnabled=true, hoverTimer=null, hoverIdx=-1, ffmpegPath, previewCache=new Map();

function getCount(){
  const n=Number(preferences.get("thumbnail_count"));
  return [10,15,20,30,40,60,100].includes(n) ? n : DEFAULT_COUNT;
}
function refreshCount(){
  count=getCount();
  const storedBlur=preferences.get("background_blur");
  blurEnabled = storedBlur === undefined || storedBlur === null ? true : Boolean(storedBlur);
  const storedPreview=preferences.get("hover_preview");
  previewEnabled = (storedPreview === undefined || storedPreview === null ? true : Boolean(storedPreview)) && Boolean(ffmpeg());
}
// Hover preview: a short run of frames pulled with ffmpeg and flipped through inside the hovered thumbnail.
function ffmpeg(){
  if(ffmpegPath===undefined)ffmpegPath=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(p=>file.exists(p))||'';
  return ffmpegPath;
}
function previewLabel(){return I18N.preview;}
// Control-bar geometry, shared by the CSS widths and the native click hit-testing.
// Offsets are relative to the horizontal center of the video; Latin text advances 7.2188px
// at 12px monospace and CJK glyphs advance a full 12px.
// The preview toggle is only reserved when ffmpeg is available; otherwise it is not rendered at all.
function textWidth(s){let w=0;for(const ch of String(s))w+=/[⺀-鿿豈-﫿＀-￯]/.test(ch)?12:7.2188;return w;}
function barLayout(){
  const blurW=130, hasPreview=!!ffmpeg(), prevW=hasPreview?Math.ceil(textWidth(previewLabel())+19)+2:0;
  const lead=10+textWidth(I18N.count)+9+120+9+22+9;
  const total=lead+6+blurW+9+(hasPreview?6+prevW:0)+10;
  const blurL=-total/2+lead+6, prevL=blurL+blurW+9+6;
  return {blurL,blurR:blurL+blurW,prevL,prevR:prevL+prevW,prevW,hasPreview};
}
// Clips are small silent h264 mp4s cut by ffmpeg straight from the video file (the same approach as
// the Bookmarks plugin), so the overlay can play them in a normal <video>.
const CLIP_SECONDS=4, CLIP_WIDTH=360;
const ENCODERS=[["-c:v","libx264","-crf","28","-preset","veryfast"],["-c:v","h264_videotoolbox","-b:v","600k"]];
let clipGen=0;
async function makeClip(source,time,idx){
  const out=utils.resolvePath(`@tmp/thumbnails-clip-${idx}.mp4`);
  for(const enc of ENCODERS){
    try{
      const done=await utils.exec(ffmpeg(),["-v","error","-y","-ss",String(Math.max(0,time)),"-i",source,"-t",String(CLIP_SECONDS),"-an","-sn","-vf",`scale=${CLIP_WIDTH}:-2:in_color_matrix=auto:out_color_matrix=bt709:out_range=tv`,"-pix_fmt","yuv420p","-colorspace","bt709","-color_primaries","bt709","-color_trc","bt709",...enc,"-movflags","+faststart",out]);
      if(done.status!==0)continue;
      const b64=await utils.exec("/usr/bin/base64",["-i",out]);
      try{file.delete(out);}catch(_){}
      if(b64.status===0)return "data:video/mp4;base64,"+String(b64.stdout).replace(/\s/g,"");
    }catch(e){}
  }
  return null;
}
// One in-flight promise per thumbnail: hover and the background prefetch share the same work.
function clipFor(idx){
  const t=thumbs[idx], path=localFilePath(core.status.url);
  if(!t||!path||/^https?:/.test(path))return Promise.resolve(null);
  const key=path+'|'+Math.round(Number(t.time)*10);
  if(!previewCache.has(key)){
    const p=makeClip(path,Number(t.time),idx);
    previewCache.set(key,p);
    p.then(c=>{if(!c){previewCache.delete(key);return;}if(overlayReady)overlay.postMessage('clip',{k:Math.round(Number(t.time)*10),clip:c});});
    if(previewCache.size>120)previewCache.delete(previewCache.keys().next().value);
  }
  return previewCache.get(key);
}
async function runPreview(idx){
  const clip=await clipFor(idx);
  if(!clip||!visible||hoverIdx!==idx)return;
  overlay.postMessage('preview',{index:idx,clip});
}
// Cut the remaining clips in the background, one at a time, so most hovers play instantly.
async function prefetchClips(){
  const gen=++clipGen;
  for(let i=0;i<count;i++){
    if(gen!==clipGen||!visible||!previewEnabled||!ffmpeg())return;
    if(thumbs[i])await clipFor(i);
  }
}


function formatTime(seconds) { seconds=Math.max(0,Math.round(seconds)); const h=Math.floor(seconds/3600), m=Math.floor((seconds%3600)/60), s=seconds%60; return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`; }
// Only one tick at a time, and cut short, so fast slider moves never stack sounds into a louder one.
const TICK_SOUND='/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Media Keys.aif';
let tickPlaying=false;
function playTick(){if(tickPlaying)return;tickPlaying=true;utils.exec('/usr/bin/afplay',['-v','0.075','-t','0.1',TICK_SOUND]).catch(()=>{}).then(()=>{tickPlaying=false;});}
function toggleBlur(){
  blurEnabled=!blurEnabled;
  playTick();
  preferences.set('background_blur',blurEnabled);
  preferences.sync();
  render(thumbs.length?'':I18N.loading,!thumbs.length);
}
function togglePreview(){
  if(!ffmpeg())return;
  previewEnabled=!previewEnabled;
  playTick();
  if(previewEnabled)prefetchClips();
  preferences.set('hover_preview',previewEnabled);
  preferences.sync();
  render(thumbs.length?'':I18N.loading,!thumbs.length);
}
function setupOverlay() { if(overlayReady)return; overlay.simpleMode(); overlay.setStyle(`:root{color-scheme:dark}*{text-shadow:none!important}html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;font-family:ui-monospace,"SF Mono",Menlo,Monaco,monospace;text-transform:uppercase}.shade{position:absolute;inset:0;background:rgba(0,0,0,.10);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);pointer-events:none}.shade.noBlur{backdrop-filter:none;-webkit-backdrop-filter:none}.panel{box-sizing:border-box;position:absolute;left:3%;right:3%;top:48px;bottom:56px;padding:0;background:transparent;border:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;overflow:visible}.grid{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));grid-template-rows:none;gap:8px;width:100%;height:100%}.thumb{position:relative;min-width:0;min-height:0;overflow:hidden;border-radius:7px;border:1px solid rgba(255,255,255,.16);background:#111;box-shadow:0 2px 8px rgba(0,0,0,.28);cursor:pointer}.thumb.empty{background:transparent;border-color:transparent;box-shadow:none}.thumb.empty:hover{box-shadow:none;filter:none}.thumb:not(.empty):hover,.thumb.sel{z-index:1;border-color:#d9b24c;box-shadow:0 0 0 1px #d9b24c,0 6px 22px rgba(0,0,0,.5)}.thumb img{width:100%;height:100%;display:block;object-fit:cover;pointer-events:none}.noTime .time{display:none}.thumb video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none}.thumb video.playing{opacity:1}.time{z-index:2;position:absolute;left:.6em;bottom:.5em;padding:.2em .5em;border-radius:.4em;color:white;background:rgba(0,0,0,.36);font-size:var(--ts,10px);font-variant-numeric:tabular-nums;pointer-events:none}.status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:9px;color:rgba(255,255,255,.86);background:rgba(0,0,0,.62);font-size:13px;white-space:nowrap;box-shadow:0 4px 18px rgba(0,0,0,.25)}.countControl{width:max-content;position:absolute;left:50%;right:auto;top:0px;transform:translateX(-50%);display:flex;align-items:center;gap:9px;padding:6px 10px;border-radius:9px;color:rgba(255,255,255,.9);background:rgba(0,0,0,.52);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font-size:12px;box-shadow:0 4px 18px rgba(0,0,0,.22)}.countControl > input[type="range"]{width:120px;height:16px;margin:0;accent-color:#fff;cursor:pointer}.countValue{min-width:22px;text-align:right;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.82)}.blurToggle{display:flex;align-items:center;gap:5px;margin-left:6px;width:130px;height:28px;box-sizing:border-box;white-space:nowrap;color:rgba(255,255,255,.82);cursor:pointer}.blurToggle input{width:14px;height:14px;margin:0;accent-color:#fff;cursor:pointer}.spinner{width:13px;height:13px;border:2px solid rgba(255,255,255,.28);border-top-color:rgba(255,255,255,.9);border-radius:50%;animation:spin .75s linear infinite;flex:none}@keyframes spin{to{transform:rotate(360deg)}}`); overlay.onMessage('thumbnail-count',(value)=>{const n=Number(value);if(![10,15,20,30,40,60,100].includes(n))return;preferences.set('thumbnail_count',n);preferences.sync();count=n;thumbs=[];render(I18N.loading,true);loadNativeCache();}); overlay.onMessage('slider-tick',playTick); overlay.onMessage('webview-ready',async()=>{try{const r=await utils.exec('/usr/bin/base64',['-i',TICK_SOUND]);if(r.status===0)overlay.postMessage('tick-sound','data:audio/x-aiff;base64,'+String(r.stdout).replace(/\s/g,''));}catch(e){}}); overlay.onMessage('hover',(i)=>{clearTimeout(hoverTimer);hoverIdx=Number(i);if(!previewEnabled||!ffmpeg())return;const idx=hoverIdx;hoverTimer=setTimeout(()=>runPreview(idx),60);}); overlay.onMessage('hover-end',()=>{clearTimeout(hoverTimer);hoverIdx=-1;}); overlay.onMessage('background-blur',(value)=>{blurEnabled=Boolean(value);preferences.set('background_blur',blurEnabled);preferences.sync();render(thumbs.length?'':I18N.loading,!thumbs.length);}); overlay.onMessage('seek',(i)=>{const t=thumbs[Number(i)];if(t&&Number.isFinite(Number(t.time))){core.seekTo(Number(t.time));closeOverlay();}}); overlay.onMessage('close',closeOverlay); overlayReady=true; }
function gridGeometry() {
  const frame=core.window.frame;
  const W=Number(frame.width)||0, H=Number(frame.height)||0;
  const panelW=W*.94, panelH=H-48-56-38, gap=8, cols=columnsForCount(count), rows=Math.ceil(count/cols);
  if(!W||!H||panelW<=0||panelH<=0) return {rows,panelW,panelH,gap,left:0,top:0,width:panelW,height:panelH,cellW:0,cellH:0};
  const maxCellW=(panelW-gap*(cols-1))/cols;
  const maxCellH=(panelH-gap*(rows-1))/rows;
  const cellW=Math.min(maxCellW,maxCellH*4/3);
  const cellH=cellW*3/4;
  const width=cellW*cols+gap*(cols-1);
  const height=cellH*rows+gap*(rows-1);
  return {rows,cols,panelW,panelH,gap,left:(panelW-width)/2,top:38+(panelH-height)/2,width,height,cellW,cellH};
}
function render(statusText='',loading=false) {
  setupOverlay();
  const g=gridGeometry(), bar=barLayout();
  let grid='';
  for(let i=0;i<count;i++){
    const t=thumbs[i];
    grid += t ? `<div class="thumb${i===selected?' sel':''}" data-clickable data-k="${Math.round(Number(t.time)*10)}" onclick="iina.postMessage('seek',${i})" onmouseenter="window.__pvGo&&window.__pvGo(this);iina.postMessage('hover',${i})" onmouseleave="iina.postMessage('hover-end');window.__pvStop&&window.__pvStop()"><img src="${t.image}" draggable="false"><div class="time">${formatTime(t.time)}</div></div>` : `<div class="thumb empty"></div>`;
  }
  // Timestamps shrink with the thumbnails (10px at full size) and disappear once they would crowd them.
  const ts=Math.min(10,g.cellW*.07), hideTime=g.cellW<90;
  const gridStyle=`--cols:${g.cols};--ts:${ts.toFixed(2)}px;position:absolute;left:${g.left.toFixed(2)}px;top:${g.top.toFixed(2)}px;width:${g.width.toFixed(2)}px;height:${g.height.toFixed(2)}px;grid-template-rows:repeat(${g.rows},minmax(0,1fr));`;
  const blurClass=blurEnabled?'':' noBlur';
  overlay.setContent(`<div class="shade${blurClass}"></div><div class="panel"><div class="countControl"><span>${I18N.count}</span><input data-clickable type="range" min="0" max="6" step="1" value="${[10,15,20,30,40,60,100].indexOf(count)}" aria-label="Thumbnail count" oninput="this.nextElementSibling.textContent=[10,15,20,30,40,60,100][this.value];(window.__tick||function(){iina.postMessage('slider-tick')})()" onchange="iina.postMessage('thumbnail-count', [10,15,20,30,40,60,100][this.value])"><span class="countValue">${count}</span><div class="blurToggle" role="checkbox" aria-checked="${blurEnabled}"><input type="checkbox" tabindex="-1" ${blurEnabled?'checked':''} style="pointer-events:none"><span>${I18N.blur}</span></div>${bar.hasPreview?`<div class="blurToggle previewToggle" style="width:${bar.prevW}px" role="checkbox" aria-checked="${previewEnabled}"><input type="checkbox" tabindex="-1" ${previewEnabled?'checked':''} style="pointer-events:none"><span>${previewLabel()}</span></div>`:''}</div><div class="grid${hideTime?' noTime':''}" data-pv="${previewEnabled&&ffmpeg()?1:0}" data-clickable onclick="if(event.target===this)iina.postMessage('close')" style="${gridStyle}">${grid}</div><img style="display:none" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" onload="if(!window.__pv){window.__pv=1;window.__tick=function(){var ac=window.__ac,buf=window.__tickBuf;if(!ac||!buf){iina.postMessage('slider-tick');return;}if(ac.state==='suspended')ac.resume();var t=ac.currentTime;if(window.__tickSrc){window.__tickGain.gain.setTargetAtTime(0,t,0.004);try{window.__tickSrc.stop(t+0.03);}catch(e){}}var s=ac.createBufferSource(),g=ac.createGain();g.gain.value=0.075;s.buffer=buf;s.connect(g);g.connect(ac.destination);s.start(t,0,0.12);window.__tickSrc=s;window.__tickGain=g;};iina.onMessage('tick-sound',function(d){try{var b=atob(d.split(',')[1]),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);window.__ac=new (window.AudioContext||window.webkitAudioContext)();window.__ac.decodeAudioData(u.buffer,function(x){window.__tickBuf=x;},function(){});}catch(e){}});iina.postMessage('webview-ready');window.__clips={};window.__pvStop=function(){var v=window.__pvV;if(v){v.pause();v.remove();}window.__pvV=null;};window.__pvPlay=function(el,clip){try{if(!el||el.parentNode.dataset.pv!=='1'||!el.matches(':hover')||(window.__pvV&&window.__pvV.parentNode===el))return;window.__pvStop();var v=document.createElement('video');v.muted=true;v.loop=true;v.playsInline=true;var show=function(){v.classList.add('playing');};if(v.requestVideoFrameCallback)v.requestVideoFrameCallback(show);else v.addEventListener('playing',show);v.src=clip;el.appendChild(v);window.__pvV=v;v.play().catch(function(){});}catch(e){}};window.__pvGo=function(el){var c=window.__clips[el.dataset.k];if(c)setTimeout(function(){window.__pvPlay(el,c);},15);};iina.onMessage('clip',function(d){window.__clips[d.k]=d.clip;});iina.onMessage('clips-reset',function(){window.__clips={};});iina.onMessage('preview',function(d){window.__pvPlay(document.querySelectorAll('.thumb')[d.index],d.clip);});}">${statusText?`<div class="status">${loading?'<span class="spinner"></span>':''}<span>${statusText}</span></div>`:''}</div>`);
}
function stopResizeWatch(){ if(resizeWatchTimer){clearInterval(resizeWatchTimer);resizeWatchTimer=null;} lastResizeW=0; lastResizeH=0; }
function startResizeWatch(){
  stopResizeWatch();
  if(!visible)return;
  const f=core.window.frame;
  lastResizeW=Number(f.width)||0; lastResizeH=Number(f.height)||0;
  // IINA's window-resized event may arrive only after the native resize gesture ends.
  // Poll the live window frame while the viewer is open so the grid follows the drag.
  resizeWatchTimer=setInterval(()=>{
    if(!visible){stopResizeWatch();return;}
    const frame=core.window.frame;
    const w=Number(frame.width)||0, h=Number(frame.height)||0;
    if(w===lastResizeW && h===lastResizeH)return;
    lastResizeW=w; lastResizeH=h;
    render(thumbs.length?'':I18N.loading,!thumbs.length);
  },33);
}
function closeOverlay() { visible=false; clipGen++; selected=-1; if(overlayReady){overlay.hide();overlay.setClickable(false);} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} stopResizeWatch(); }
function installMouseHandler() {
  if(mouseHandlerInstalled)return;
  input.onMouseUp(input.MOUSE,({x,y})=>{
    if(!visible)return false;
    const frame=core.window.frame,W=Number(frame.width),H=Number(frame.height);
    if(!W||!H)return false;
    const topY=H-Number(y);
    const panelX=W*.03,panelY=48,panelW=W*.94,panelH=H-48-56;

    // Handle the blur toggle natively. The overlay WebView can receive the
    // checkbox click, but the HIGH-priority input handler otherwise treats
    // the label area as a click outside the thumbnail grid and closes the view.
    // Keep the slider/WebView interaction unchanged.
    // The control bar is fixed at the horizontal center of the video,
    // independent of the thumbnail grid width/count.
    const controlCenter=W/2;
    const bar=barLayout();
    const blurLeft=controlCenter+bar.blurL-2;
    const blurRight=controlCenter+bar.blurR+2;
    const blurTop=panelY;
    const blurBottom=blurTop+40;
    if(bar.hasPreview&&x>=controlCenter+bar.prevL-2&&x<=controlCenter+bar.prevR+2&&topY>=blurTop&&topY<=blurBottom){
      togglePreview();
      return true;
    }
    if(x>=blurLeft&&x<=blurRight&&topY>=blurTop&&topY<=blurBottom){
      toggleBlur();
      return true;
    }
    const g=gridGeometry();
    const gridX=panelX+g.left,gridY=panelY+g.top,gridW=g.width,gridH=g.height,gap=g.gap,cellW=g.cellW,cellH=g.cellH,rows=g.rows,cols=g.cols;
    if(x<panelX||x>panelX+panelW||topY<panelY||topY>panelY+panelH){closeOverlay();return true;}
    if(x<gridX||x>gridX+gridW||topY<gridY||topY>gridY+gridH){closeOverlay();return true;}
    const col=Math.floor((x-gridX)/(cellW+gap)),row=Math.floor((topY-gridY)/(cellH+gap));
    if(col<0||col>=cols||row<0||row>=rows)return true;
    const lx=(x-gridX)-col*(cellW+gap),ly=(topY-gridY)-row*(cellH+gap);
    if(lx>cellW||ly>cellH){closeOverlay();return true;}
    const t=thumbs[row*cols+col];
    if(t&&Number.isFinite(Number(t.time))){core.seekTo(Number(t.time));closeOverlay();}
    return true;
  },input.PRIORITY_HIGH);
  // Keyboard: arrows move a highlight, Enter jumps, Esc closes.
  // Handlers pass the key through (return false) while the viewer is closed.
  const moveSelection=(dx,dy)=>{
    if(!thumbs.length)return true;
    if(selected<0)selected=0;
    else{
      const cols=gridGeometry().cols||1;
      const next=selected+dx+dy*cols;
      if(next>=0&&next<count&&thumbs[next])selected=next;
    }
    render();
    return true;
  };
  // IINA's menu bar claims every key bound in input.conf (arrows seek, Enter is
  // next-file, ...) before plugins see it, so each action also gets a Shift
  // variant, which IINA leaves unbound by default.
  const jump=()=>{const t=thumbs[selected];if(t&&Number.isFinite(Number(t.time))){core.seekTo(Number(t.time));closeOverlay();}return true;};
  const keys={LEFT:()=>moveSelection(-1,0),RIGHT:()=>moveSelection(1,0),UP:()=>moveSelection(0,-1),DOWN:()=>moveSelection(0,1),ENTER:jump,ESC:()=>{closeOverlay();return true;}};
  for(const k of Object.keys(keys))for(const name of [k,'Shift+'+k])input.onKeyDown(name,()=>visible?keys[k]():false,input.PRIORITY_HIGH);
  mouseHandlerInstalled=true;
}
function u64le(a,o){let n=0,m=1;for(let i=0;i<8;i++){n+=a[o+i]*m;m*=256;}return n;}
function i64le(a,o){const u=u64le(a,o);return u>=0x8000000000000000?u-0x10000000000000000:u;}
function f64le(a,o){return new DataView(a.buffer,a.byteOffset,a.byteLength).getFloat64(o,true);}
function base64(a){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let out='',i=0;for(;i+2<a.length;i+=3){const n=a[i]*65536+a[i+1]*256+a[i+2];out+=chars[(n>>18)&63]+chars[(n>>12)&63]+chars[(n>>6)&63]+chars[n&63];}const r=a.length-i;if(r===1){const n=a[i]*65536;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+'==';}else if(r===2){const n=a[i]*65536+a[i+1]*256;out+=chars[(n>>18)&63]+chars[(n>>12)&63]+chars[(n>>6)&63]+'=';}return out;}
function parseNativeCache(bytes,duration){
  if(bytes.length<17) throw new Error(`IINA cache is too small (${bytes.length} bytes).`);
  if(bytes[0]!==2) throw new Error(`Unsupported IINA cache version: ${bytes[0]}.`);
  const items=[];let pos=17;
  while(pos<bytes.length){
    if(pos+16>bytes.length) throw new Error('IINA cache has a truncated thumbnail header.');
    const block=i64le(bytes,pos),ts=f64le(bytes,pos+8);pos+=16;
    const jpegLen=block-8;
    if(jpegLen<2||pos+jpegLen>bytes.length) throw new Error('IINA cache contains an invalid thumbnail block.');
    const jpeg=bytes.slice(pos,pos+jpegLen);pos+=jpegLen;
    if(jpeg[0]===0xff&&jpeg[1]===0xd8) items.push({time:ts,image:'data:image/jpeg;base64,'+base64(jpeg)});
  }
  if(!items.length) throw new Error('IINA cache contains no JPEG thumbnails.');
  const selected=[];
  for(let i=0;i<count;i++){const target=duration*(i+0.5)/count;let best=items[0],bd=Math.abs(items[0].time-target);for(let j=1;j<items.length;j++){const d=Math.abs(items[j].time-target);if(d<bd){best=items[j];bd=d;}}selected.push(best);}
  return selected;
}
function localFilePath(url){
  let s=String(url||'');
  if(s.startsWith('file://')){
    s=s.slice(7);
    try{s=decodeURIComponent(s);}catch(_){}
    if(s.startsWith('localhost/')) s=s.slice('localhost'.length);
  }
  return s;
}
async function readNativeCache(){
  const url=core.status.url,duration=Number(core.status.duration);
  if(!url||!duration||duration<=0||core.status.isNetworkResource)return {ok:false,error:I18N.noVideo,waiting:true};
  const path=localFilePath(url);
  const dir=utils.resolvePath('~/Library/Caches/com.colliderli.iina/thumb_cache');
  if(!file.exists(dir))return {ok:false,error:I18N.noDir,waiting:true};
  // IINA names its cache file with MD5(URL.path), not with a hash of the file contents.
  // This is the same calculation used by Utility.mpvWatchLaterMd5() for local files.
  let hashResult;
  try{hashResult=await utils.exec('/sbin/md5',['-qs',path]);}catch(e){return {ok:false,error:I18N.hashFail(String(e.message||e))}}
  if(hashResult.status!==0)return {ok:false,error:(hashResult.stderr||'').trim()||I18N.noHash};
  const cacheName=String(hashResult.stdout||'').trim().toLowerCase();
  if(!/^[0-9a-f]{32}$/.test(cacheName))return {ok:false,error:I18N.badHash(cacheName)};
  const cachePath=dir.replace(/\/$/,'')+'/'+cacheName;
  if(!file.exists(cachePath))return {ok:false,error:I18N.noCache(cacheName),waiting:true};
  try{
    const h=file.handle(cachePath,'read');const bytes=h.readToEnd();h.close();
    return {ok:true,thumbs:parseNativeCache(bytes,duration),cache:cachePath};
  }catch(e){return {ok:false,error:I18N.readFail(String(e.message||e))}
  }
}
async function loadNativeCache() { refreshCount(); const r=await readNativeCache(); if(r.ok){thumbs=r.thumbs;render();if(previewEnabled&&ffmpeg())prefetchClips();return true;} thumbs=[]; render(r.waiting?I18N.loading:r.error,!!r.waiting); return false; }
function watchCache() { if(pollTimer)clearInterval(pollTimer); let tries=0; pollTimer=setInterval(async()=>{tries++; if(!visible){clearInterval(pollTimer);pollTimer=null;return;} if(await loadNativeCache()||tries>=60){clearInterval(pollTimer);pollTimer=null;}},1000); }
async function toggle() { if(visible){closeOverlay();return;} refreshCount(); visible=true;setupOverlay();installMouseHandler();overlay.setClickable(true);overlay.show(); startResizeWatch(); if(!(await loadNativeCache()))watchCache(); }
event.on('iina.file-loaded',()=>{thumbs=[];selected=-1;previewCache.clear();if(overlayReady)overlay.postMessage('clips-reset',{}); if(visible)render(I18N.loading,true);});
event.on('iina.thumbnails-ready',()=>{if(visible)loadNativeCache();});
event.on('iina.window-resized',()=>{
  if(!visible)return;
  const frame=core.window.frame;
  lastResizeW=Number(frame.width)||lastResizeW;
  lastResizeH=Number(frame.height)||lastResizeH;
  render(thumbs.length?'':I18N.loading,!thumbs.length);
});
menu.addItem(menu.item(I18N.menu,toggle,{keyBinding:'0'}));
input.onKeyDown('0',({isRepeat})=>{if(isRepeat)return true;toggle();return true;},input.PRIORITY_HIGH);
