import {WorkerNP21,workerAssistBridge,mountWorkerChoice} from './solo-worker-client.js';
import {mountSoloView} from './solo-view.js';
import {SoloMusic} from './solo-music.js';
import {FireControl} from './fire-control.js';
import {NP21} from './vendor/np2/np2-original.js';
import {sha256} from './sha256.js';
import {mountPlayer} from './player-ui.js';
import {unpackTouch} from './touch-input.js';
import {createSoloAssist} from './solo-assist.js';
import {mountSoloPerformance} from './solo-performance.js';

const $=id=>document.getElementById(id);
const audioMode=$('audio-mode');
const runtimeMode=mountWorkerChoice(audioMode.closest('label').parentElement);
let soloMusic;
window.addEventListener('pagehide',event=>{if(event.persisted)soloMusic?.suspend();else soloMusic?.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)soloMusic?.resume();});
try{const saved=localStorage.getItem('solo-audio-mode-v2');if(['independent','original','buffered'].includes(saved))audioMode.value=saved;}catch{}
audioMode.onchange=()=>{try{localStorage.setItem('solo-audio-mode-v2',audioMode.value);}catch{}};

let emulator,lang,meta,database,dirty=0,saved=0,saveTask,timer,starting=false,assist;
const status=text=>{$('status').textContent=text;player.note(text);if(!cover.hidden)cover.textContent=text;};
const report=error=>{console.error(error);status(`错误：${error.message}`);};
const canvas=$('canvas'),cover=$('cover');
const player=mountPlayer($('screen'),{solo:true,pure:true,onGesture:()=>{canvas.focus();soloMusic?.resume();emulator?.module.SDL2?.audioContext?.resume();}});
mountSoloView($('screen'));
const viewport=document.createElement('div');viewport.className='screen';viewport.append(canvas);player.stage.prepend(viewport);player.stage.append(cover);
player.setLabel('原版单人');player.setContext({key:'original:menu',play:false});
const markerLayer=document.createElement('div');markerLayer.className='hit-points';
const marker=document.createElement('i');marker.hidden=true;markerLayer.append(marker);viewport.append(markerLayer);
mountSoloPerformance({host:$('screen'),game:'03',getEmulator:()=>emulator,readState:()=>{
  if(emulator?.isWorker){const s=emulator.snapshot.state;return s?{playing:s.phase===1,generation:s.generation,ticks:s.ticks}:null;}
  const bridge=assist?.bridge,h=emulator?.module.HEAPU8;
  if(!h||!bridge.valid(h,bridge.live))return null;
  const at=bridge.live,f=bridge.meta.fields,v=new DataView(h.buffer);
  return {playing:h[at+f.phase]===1,generation:v.getUint16(at+f.generation,true),ticks:v.getUint32(at+f.ticks,true)};
}});

async function metadata(language){
  const response=await fetch('disks/manifest.json');if(!response.ok)throw Error('镜像清单加载失败');
  return (await response.json()).games[`3-${language}`];
}
async function storage(language,mode,value){
  database ||= await new Promise((resolve,reject)=>{
    const request=indexedDB.open('th03-original-solo',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('disks');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(Error('原版存档数据库被占用'));
  });
  return new Promise((resolve,reject)=>{
    const tx=database.transaction('disks',mode),store=tx.objectStore('disks');
    const request=mode==='readonly'?store.get(language):store.put(value,language);
    tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(tx.error||request.error);
  });
}
function validate(data,info){
  if(data.length!==info.size||new TextDecoder().decode(data.subarray(info.languageMarkerOffset,info.languageMarkerOffset+8))!==info.languageMarker)throw Error('存档大小或语言不匹配');
  // Reject multiplayer saves rather than silently booting their injected launcher.
  const signature=new TextEncoder().encode('TH03LOCALPAUSE1!');
  for(let at=data.indexOf(signature[0]);at>=0;at=data.indexOf(signature[0],at+1))
    if(signature.every((b,i)=>data[at+i]===b))throw Error('这是双人补丁存档，请导入原版单人存档');
}
async function loadDisk(){
  meta=await metadata(lang);
  try{const disk=await storage(lang,'readonly');if(disk){const data=new Uint8Array(disk);validate(data,meta);return data;}}
  catch(error){$('save-status').textContent=`存档读取失败：${error.message}`;}
  const response=await fetch(meta.url);if(!response.ok)throw Error('原版镜像加载失败');
  const data=new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if(await sha256(data)!==meta.sha256)throw Error('原版镜像校验失败');
  return data; // No disk patches, config changes, score unlocks or skipped intros.
}
async function exportDisk(){const disk=assist.exportDisk(await emulator.getDiskImage(`3-${lang}.hdi`));return soloMusic?soloMusic.exportDisk(disk):disk;}
async function save(){
  if(saveTask)return saveTask;
  if(!emulator||dirty===saved)return;
  saveTask=(async()=>{try{while(saved!==dirty){const version=dirty;
    await storage(lang,'readwrite',await exportDisk());saved=version;}
    $('save-status').textContent='原版进度已保存';
  }catch(error){$('save-status').textContent=`保存失败：${error.message}`;}finally{saveTask=null;}})();
  return saveTask;
}
$('start').onclick=async()=>{
  if(starting||emulator)return;starting=true;$('start').disabled=true;audioMode.disabled=true;runtimeMode.disabled=true;player.enter();
  for(const id of ['language','clock','import'])$(id).disabled=true;
  try{
    if(audioMode.value==='independent')soloMusic=new SoloMusic(status);
    lang=$('language').value;status('正在加载原版镜像');const disk=await loadDisk();
    assist=await createSoloAssist(()=>emulator);await assist.install(disk);
    if(soloMusic)await soloMusic.install(disk,'YUMEZIKU');
    const config={canvas,clk_base:2457600,clk_mult:Number($('clock').value),
      // Independent BGM uses its own audio clock; native PCM retains sound effects.
      DIPswtch:[0x3e,0xf3,0x7b],ExMemory:7,Latencys:100,SampleHz:44100,SNDboard:4,nativeSoloAudio:audioMode.value!=='original',
      no_mouse:true,use_menu:false,fontfile:lang==='cn'?'font_cn.bmp':'font.bmp',
      onDiskChange:()=>{dirty++;clearTimeout(timer);timer=setTimeout(save,1500);},
      onExit:()=>{soloMusic?.reset();release();save();status('游戏已退出，可点击重启');}};
    emulator=runtimeMode.value==='worker'?await WorkerNP21.create(config,{game:'03',patch:assist.bridge.meta,music:soloMusic?.reader.patch,onError:error=>{soloMusic?.suspend();player.exit();report(error);}}):await NP21.create(config);
    if(emulator.isWorker){assist.bridge=workerAssistBridge(emulator);emulator.onMusic=(ax,hash)=>soloMusic?.player.command(ax,hash);}
    await emulator.addDiskImage(`3-${lang}.hdi`,disk);await emulator.setHdd(0,`3-${lang}.hdi`);
    emulator.run();cover.hidden=true;$('reset').disabled=$('export').disabled=false;
    canvas.focus();emulator.module.SDL2?.audioContext?.resume();status('原版运行中');
  }catch(error){emulator?.dispose?.();soloMusic?.dispose();player.exit();report(error);$('start').textContent='刷新重试';$('start').disabled=false;$('start').onclick=()=>location.reload();}
  finally{starting=false;}
};
$('reset').onclick=async()=>{if(!confirm('重启原版游戏？当前对局会结束。'))return;release();emulator.pause();await save();assist.bridge.reset();soloMusic?.reset();emulator.reset();emulator.run();canvas.focus();status('原版运行中');};
$('export').onclick=async()=>{try{const url=URL.createObjectURL(new Blob([await exportDisk()]));
  const a=document.createElement('a');a.href=url;a.download=`th03-original-${lang}.hdi`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(error){report(error);}};
$('import').onchange=async event=>{try{const file=event.target.files[0];if(!file||emulator||starting)return;
  const language=$('language').value,data=new Uint8Array(await file.arrayBuffer());validate(data,await metadata(language));
  if(confirm('覆盖当前语言的原版单人进度？')){await storage(language,'readwrite',data);status('原版存档已导入');}
}catch(error){report(error);}finally{event.target.value='';}};

// Standard dragging uses stock keys; unlimited dragging is consumed by the native movement hook.
const keys={1:['ArrowUp','ArrowUp',38],2:['ArrowDown','ArrowDown',40],4:['ArrowLeft','ArrowLeft',37],8:['ArrowRight','ArrowRight',39],
  16:['KeyX','x',88],32:['KeyZ','z',90],128:['Escape','Escape',27],256:['Enter','Enter',13]};
let previous=0,dx=0,dy=0,last=performance.now(),hiddenPaused=false;
const focusKeys=new Set(),physical=new Set(),tapped=new Set(),synthetic=new WeakSet(),fire=new FireControl();
const physicalActions={KeyZ:512,KeyJ:512,ShiftLeft:32,ShiftRight:32,KeyK:32,KeyX:16,KeyL:16};
for(const type of ['keydown','keyup'])window.addEventListener(type,event=>{
  if(synthetic.has(event))return;
  const focus=event.code==='Space';
  if(!focus&&!physicalActions[event.code])return;
  event.stopImmediatePropagation();
  if(type==='keyup'){focusKeys.delete(event.code);physical.delete(event.code);return;}
  if(!emulator||player.isEditing()||event.target.closest?.('input,select,textarea,[contenteditable="true"]'))return;
  event.preventDefault();
  if(focus)focusKeys.add(event.code);
  else if(!event.repeat){physical.add(event.code);tapped.add(event.code);}
},true);
function send(bits){for(const [bit,[code,key,keyCode]] of Object.entries(keys))if(!!(previous&bit)!==!!(bits&bit)){
  const event=new KeyboardEvent(bits&bit?'keydown':'keyup',{code,key,keyCode,which:keyCode,bubbles:true});
  synthetic.add(event);canvas.dispatchEvent(event);
}previous=bits;}
function release(){emulator?.clearInput?.();send(0);dx=dy=0;focusKeys.clear();physical.clear();tapped.clear();fire.reset();player.reset();assist?.bridge.setFocus(0,0);assist?.bridge.setTouch([0,0]);}
function poll(now){
  const running=emulator?.state==='running'&&!document.hidden;player.setActive(running);
  const bridge=assist?.bridge,state=bridge?.update(now);
  const playing=running&&state?.phase===1;
  if(running&&!emulator.isWorker)soloMusic?.poll(emulator.module.HEAPU8,now);
  player.setContext({key:playing?`round:${state.generation}`:'original:menu',play:playing});
  let bits=0;
  if(running&&!player.isEditing()){
    bits=player.sample();for(const code of [...physical,...tapped])bits|=physicalActions[code]||0;tapped.clear();
    const shot=fire.sample(!!(bits&512),!!(bits&32),now,playing);bits=(bits&~544)|(shot?32:0);
    const packed=player.pack(0),touch=unpackTouch(packed);player.consume();
    bridge?.setFocus(playing&&player.focusEnabled()&&((bits&64)||focusKeys.size)?1:0,0);
    bridge?.setTouch([playing&&touch.unlimited?packed:0,0]);
    const step=Math.min(100,now-last)*16*3/16.667;
    dx=Math.max(-480,Math.min(480,dx+touch.x));dy=Math.max(-480,Math.min(480,dy+touch.y));
    if(!touch.active||!playing||touch.unlimited)dx=dy=0;
    if(Math.abs(dx)>8){bits|=dx<0?4:8;dx-=Math.sign(dx)*Math.min(Math.abs(dx),step);}
    if(Math.abs(dy)>8){bits|=dy<0?1:2;dy-=Math.sign(dy)*Math.min(Math.abs(dy),step);}
  }else{dx=dy=0;physical.clear();tapped.clear();fire.reset();bridge?.setFocus(0,0);bridge?.setTouch([0,0]);}
  marker.hidden=true;
  if(playing)for(const point of bridge.markers())if(point.seat===0&&(player.alwaysPoint()||point.focused&&player.focusPoints())){
    marker.hidden=false;marker.style.left=`${point.x/640*100}%`;marker.style.top=`${point.y/400*100}%`;
  }
  send(bits);last=now;requestAnimationFrame(poll);
}
requestAnimationFrame(poll);
window.addEventListener('blur',release);
document.addEventListener('visibilitychange',()=>{release();if(document.hidden){soloMusic?.suspend();hiddenPaused=emulator?.state==='running';emulator?.pause();save();}
  else if(hiddenPaused){hiddenPaused=false;emulator?.run();soloMusic?.resume();}});
window.addEventListener('beforeunload',event=>{if(dirty!==saved){event.preventDefault();event.returnValue='';}});
canvas.addEventListener('pointerdown',()=>canvas.focus());
