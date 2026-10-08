import {NP21} from './vendor/np2/np2-wasm.js';
import {NP21 as SyncNP21} from './vendor/np2/np2-netplay.js';
import {mountControls} from './controls.js';
import {Fat12, installNativePause, nativeAssets, sha256} from './disk.js';
import {unlockDiskScores} from './scores.js';
import {NativePause} from './native-pause.js';
import {Netplay} from './netplay.js';
import {mountPlayer} from './player-ui.js';
import {Lockstep} from './lockstep.js';
import {createFrameGate} from './frame-limit.js';
import {LocalBgm} from './local-bgm.js';
import {NativeMusic, ConfirmedMusic} from './native-music.js';

const $ = id => document.getElementById(id);
const netQuery = new URLSearchParams(location.search);
let rollbackEnabled = false, roomFocusEnabled = true, roomTouchUnlimitedAllowed = false;
const online = ['rtc', 'relay'].includes(netQuery.get('net')) && ['host', 'guest'].includes(netQuery.get('role'))
  && /^[0-9]{4}$/.test(netQuery.get('room') || '') && !!netQuery.get('token');
const embedded = online && netQuery.get('embedded') === '1' && window.parent !== window;
function notifyRoom(message, loaded = false, error = false) {
  if (embedded) window.parent.postMessage({protocol: 'th03-lan/1', event: 'progress', message, loaded, error}, location.origin);
}
if (embedded) {
  document.body.classList.add('embedded');
  new ResizeObserver(() => window.parent.postMessage({protocol: 'th03-lan/1', event: 'resize',
    height: document.querySelector('main').getBoundingClientRect().height}, location.origin)).observe(document.querySelector('main'));
}
let emulator, manifest, database, activeLang, starting = false, dirty = 0, saved = 0, saveTask, saveTimer, netplay;
let visibilityPaused = false, storageWarning = '';
let nativePause, nativeState, pauseSeat = null, pauseSelection = 0, localBgm, nativeMusic, confirmedMusic;
let closed = false, closing = false, escapeAt = -Infinity, escapeTimer;
let sync, syncIdentity, syncFrame=0, syncReplaying=false;
const nativeCanvas = document.createElement('canvas');
nativeCanvas.width = 640; nativeCanvas.height = 400;
nativeCanvas.hidden = true; nativeCanvas.style.display = 'none';
document.body.append(nativeCanvas);
const visibleCanvas = $('canvas');
// TH04 single-player renders directly to its visible canvas. Only rollback
// needs a separate native canvas, because discarded frames must stay hidden.
const visibleContext = online ? visibleCanvas.getContext('2d', {alpha: false}) : null;
const presentationDue = createFrameGate();
let presentationCount = 0, lastUpload = -1;
function presentFrame() {
  if (!online || !emulator || closed || closing || emulator.state === 'exited') return;
  const uploaded=emulator.module.frameUploads||0;
  if(uploaded===lastUpload)return;
  lastUpload=uploaded;
  visibleContext.imageSmoothingEnabled = false;
  visibleContext.drawImage(nativeCanvas, 0, 0, 640, 400);
  presentationCount++;
}
const syncSnapshots=new Map();
const hiddenSeats=new Set();
let previousPerformance=null;
function performanceTotals(){
  const module=emulator?.module,costs=sync?.costs;
  return {at:performance.now(),steps:sync?.queue.frame??module?.localFrameCount??0,
    executed:costs?.steps??module?.localFrameCount??0,simulate:costs?.simulate??module?.localStepMs??0,
    uploads:module?.frameUploads||0,presentations:online?presentationCount:module?.frameUploads||0,
    capture:costs?.capture||0,captures:costs?.captures||0,hash:costs?.hash||0,
    restore:costs?.restore||0,replays:costs?.replays||0};
}
setInterval(()=>{
  if(!emulator||closed)return;
  const next=performanceTotals(),old=previousPerformance;previousPerformance=next;
  if(!old)return;
  const dt=Math.max(1,next.at-old.at),rate=k=>(next[k]-old[k])*1000/dt;
  const delta=k=>next[k]-old[k];
  const stats={stepsHz:rate('steps'),uploadsHz:rate('uploads'),presentationsHz:rate('presentations'),
    simulateMs:delta('simulate')/Math.max(1,delta('executed')),
    snapshotMs:delta('capture')/Math.max(1,delta('captures')),hashMs:delta('hash'),
    replaySteps:delta('replays'),restoreMs:delta('restore'),snapshotBytes:emulator.module.netSnapshotInfo?.().snapshotBytes||0};
  window.th03Performance=stats;
  $('performance-stats').textContent=`模拟 ${stats.stepsHz.toFixed(1)}/60 步/秒 · 画面上传 ${stats.uploadsHz.toFixed(1)} 次/秒 · 显示提交 ${stats.presentationsHz.toFixed(1)} 次/秒\n模拟 ${stats.simulateMs.toFixed(2)} ms/步 · 快照 ${stats.snapshotMs.toFixed(2)} ms/次 · 校验 ${stats.hashMs.toFixed(2)} ms\n补算 ${stats.replaySteps} 步 · 恢复 ${stats.restoreMs.toFixed(2)} ms · 快照 ${(stats.snapshotBytes/1048576).toFixed(1)} MiB\n${localBgm?.status||'音乐准备中'}`;
},1000);
const enqueue=value=>{if(netplay?.isLockstep&&!sync?.applying){netplay.command(value);return true;}return false;};
const nativeNow=()=>sync?.applying?syncFrame*1000/60:performance.now();
const inGameplay = () => !!nativeState?.phase;
const screenChildren = [...$('screen').children];
const player = mountPlayer($('screen'), {solo: true,network:online, onGesture: () => { clearEscape(); resumeAudio(); },
  onFullscreenExit: () => { if(pauseSeat===null)openPause(0); }});
$('screen').addEventListener('player-viewchange',event=>{
  if(embedded)window.parent.postMessage({protocol:'th03-lan/1',event:'view',immersive:event.detail.immersive},location.origin);
});
$('screen').classList.remove('screen');
const viewport = document.createElement('div'); viewport.className = 'screen';
viewport.append(...screenChildren); player.stage.prepend(viewport);
// Overlays must be outside the translated viewport's stacking context.
for (const id of ['cover', 'pause-shade', 'pause-menu']) player.stage.append($(id));
player.setLabel(online ? (netQuery.get('role') === 'host' ? '1P' : '2P') : '1P');
const controls = mountControls({canvas: $('canvas'), getEmulator: () => emulator, getNetwork: () => netplay,
  dialog: $('settings'), onGesture: () => { clearEscape(); resumeAudio(); }, onOtherInput: clearEscape,
  onPause: openPause, onMenu: navigatePause, onEscape: handleEscape,
  onFocus: (mask, points) => nativePause?.setFocus(mask, points),
  getTouch: () => player, getRoomFocus: () => roomFocusEnabled, getRoomUnlimited: () => !online||roomTouchUnlimitedAllowed, onTouch: inputs => nativePause?.setTouch(inputs),
  isPaused: () => pauseSeat !== null, inGameplay});
const markerLayer=document.createElement('div');markerLayer.className='hit-points';
const markerNodes=[0,1].map(()=>{const node=document.createElement('i');node.hidden=true;markerLayer.append(node);return node;});
viewport.append(markerLayer);
function drawLocalPoints(){
  for(const node of markerNodes)node.hidden=true;
  if(!closed&&!closing)for(const point of nativePause?.markers()||[]){
    const settingSeat=online?0:point.seat;
    const ownSeat=netplay?.localSeat??0;
    if((online&&point.seat!==ownSeat)||!(point.focused&&controls.pointEnabled(settingSeat)||point.seat===ownSeat&&player.alwaysPoint()))continue;
    const node=markerNodes[point.seat];node.hidden=false;node.style.left=`${point.x/640*100}%`;node.style.top=`${point.y/400*100}%`;
  }
  requestAnimationFrame(drawLocalPoints);
}
requestAnimationFrame(drawLocalPoints);
if(online){
  for(let seat=0;seat<2;seat++){
    const checkbox=$(`focus-enabled-${seat}`);checkbox.disabled=true;
    checkbox.closest('label').title='低速模式由房主在房间中统一设置';
  }
  $('focus-points-1').closest('fieldset').hidden=true;
  $('focus-points-0').closest('fieldset').querySelector('legend').textContent='本机玩家';
  document.querySelector('.control-hint').textContent='低速模式由房主在开局前统一设置。判定点开关仅影响本浏览器；默认 Ctrl、手柄 RB / R1 低速。';
}
function localizePause(){
  const cn=(activeLang||$('language').value)==='cn';
  $('pause-menu').lang=cn?'zh-CN':'ja';
  $('pause-title').textContent=`${(pauseSeat??0)+1}P ${cn?'暂停':'一時停止'}`;
  pauseButtons().forEach((button,i)=>{button.textContent=(cn?['继续','本局认输','背水阵']:['再開','ラウンド降参','背水の陣'])[i];});
}
$('language').addEventListener('change',localizePause);localizePause();
try {
  const difficulty = localStorage.getItem('th03-local-difficulty');
  if (/^[0-3]$/.test(difficulty)) $('difficulty').value = difficulty;
} catch {}
let restartOnLoad = false;
try {
  const launch = JSON.parse(sessionStorage.getItem('th03-local-restart'));
  sessionStorage.removeItem('th03-local-restart');
  if (launch && ['jp', 'cn'].includes(launch.lang) && /^[0-3]$/.test(launch.rank)
    && ['8', '16', '24', '32'].includes(launch.clock)) {
    $('language').value = launch.lang; $('difficulty').value = launch.rank; $('clock').value = launch.clock;
    restartOnLoad = true;
  }
} catch {}
$('difficulty').addEventListener('change', () => {
  try { localStorage.setItem('th03-local-difficulty', $('difficulty').value); } catch {}
});

function status(text, error = false) {
  $('status').textContent = text; $('status').dataset.error = String(error);
  if (starting) notifyRoom(text, false, error);
}
function report(error) {
  sync?.stop();
  console.error(error); status(`错误：${error.message || error}`, true);
  if (online) { emulator?.pause(); controls.release(); notifyRoom(`错误：${error.message || error}`, false, true); }
}
async function resumeAudio() {
  try { await emulator?.module.SDL2?.audioContext?.resume(); } catch {}
}
async function metadata(lang) {
  if (!manifest) {
    const response = await fetch('disks/manifest.json');
    if (!response.ok) throw Error(`镜像清单加载失败 (${response.status})`);
    manifest = await response.json();
  }
  const meta = manifest.games[`3-${lang}`];
  if (!meta) throw Error('找不到梦时空镜像');
  return meta;
}
function validate(data, meta) {
  const decode = (at, length) => new TextDecoder().decode(data.subarray(at, at + length));
  if (data.length !== meta.size || decode(meta.autoexecSizeOffset - 28, 11) !== 'AUTOEXECBAT') throw Error('存档镜像结构不匹配');
  if (decode(meta.languageMarkerOffset, 8) !== meta.languageMarker) throw Error('存档与所选语言版本不匹配');
}
async function prepareDisk(data, meta, lang = activeLang || $('language').value) {
  validate(data, meta);
  unlockDiskScores(new Fat12(data));
  await installNativePause(data, lang);
  const script = new TextEncoder().encode('@ECHO OFF\r\nPATH A:\\DOS;A:\\\r\nSET TEMP=A:\\DOS\r\nSET DOSDIR=A:\\DOS\r\nA:\r\nCD \\YUMEZIKU\r\nCALL GAME.BAT\r\n');
  if (script.length > meta.autoexecCapacity) throw Error('启动脚本空间不足');
  data.fill(0, meta.autoexecOffset, meta.autoexecOffset + meta.autoexecCapacity);
  data.set(script, meta.autoexecOffset);
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(meta.autoexecSizeOffset, script.length, true);
  // TH03 shares snd_active between BGM commands and sound-driver routing.
  // Keep FM command routing enabled; WEBMUSIC masks PMD music parts 0..14
  // to zero output and leaves part 15 (SE) enabled, as TH04's PMD bridge does.
  const cfg = meta.keyboardConfig;
  if (cfg.size !== 8 || cfg.offset < 0 || cfg.offset + cfg.size > data.length) throw Error('梦时空键盘配置位置无效');
  data[cfg.offset + 0] = 1; // PMD commands enabled, music output masked by TSR
  data[cfg.offset + 1] = 0; // KM_KEY_KEY
  const difficulty = Number($('difficulty').value);
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 3) throw Error('难度设置无效');
  data[cfg.offset + 2] = difficulty;
  return data;
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('th03-local-lab', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('disks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('存档数据库被占用'));
  });
}
async function stored(lang, mode, value) {
  database ||= await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('disks', mode), store = transaction.objectStore('disks');
    const request = mode === 'readonly' ? store.get(lang) : store.put(value, lang);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || Error('存档事务已取消'));
  });
}
async function loadDisk(lang) {
  const meta = await metadata(lang);
  if (!online) {
    try {
      const disk = await stored(lang, 'readonly');
      if (disk) { status('正在读取本地存档'); return prepareDisk(new Uint8Array(disk), meta); }
    } catch (error) {
      storageWarning = `存档读取受限：${error.message}`;
      $('save-status').textContent = storageWarning;
    }
  }
  status('正在加载梦时空镜像');
  const response = await fetch(meta.url);
  if (!response.ok) throw Error(`镜像加载失败 (${response.status})`);
  const data = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const hash = await sha256(data);
  if (hash !== meta.sha256) throw Error('原版镜像校验失败');
  return prepareDisk(data, meta);
}
function diskChanged(name) {
  if (online) return;
  if (!activeLang || !name.endsWith(`3-${activeLang}.hdi`)) return;
  dirty++; $('save-status').textContent = '等待保存';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1500);
}
async function save() {
  if (saveTask) return saveTask;
  if (!emulator || saved === dirty) return;
  saveTask = (async () => {
    try {
      while (saved !== dirty) {
        const version = dirty, disk = emulator.getDiskImage(`3-${activeLang}.hdi`);
        await stored(activeLang, 'readwrite', disk); saved = version;
      }
      storageWarning = ''; $('save-status').textContent = '已保存';
    } catch (error) { $('save-status').textContent = `保存失败：${error.message}`; }
    finally { saveTask = null; }
  })();
  return saveTask;
}
function reflectState() {
  if (closed || closing) return;
  const running = emulator?.state === 'running';
  $('reset').disabled = online || !!nativePause?.pending;
  if (emulator) status(emulator.state === 'exited' ? '游戏已退出' : running ? '运行中' : '已暂停');
}
function pauseButtons() { return Array.from($('pause-menu').querySelectorAll('button')); }
function refreshPauseMenu() {
  const buttons = pauseButtons(), allowed = nativeState?.phase === 1 && !nativePause?.pending;
  buttons[1].disabled = buttons[2].disabled = !allowed;
  if (buttons[pauseSelection].disabled) pauseSelection = 0;
  buttons.forEach((button, i) => { button.dataset.selected = String(i === pauseSelection); });
}
function openPause(seat) {
  if(enqueue('pause'))return;
  if(netplay&&!sync?.applying)seat=netplay.localSeat;
  if (closed || closing || !emulator || emulator.state === 'exited' || nativePause?.pending || pauseSeat !== null || (!online && $('settings').open)) return;
  nativeState = nativePause?.update(nativeNow());
  if (!nativeState?.phase) return;
  clearEscape();
  controls.release(); visibilityPaused = false; emulator.pause(); save();
  pauseSeat = seat; pauseSelection = 0;
  $('pause-menu').dataset.seat = String(seat);
  localizePause();
  $('pause-message').textContent = '';
  $('pause-menu').hidden = $('pause-shade').hidden = false;
  refreshPauseMenu(); reflectState(); pauseButtons()[0].focus();
}
function closePause() {
  if(enqueue('resume'))return;
  controls.release(); pauseSeat = null;
  $('pause-menu').hidden = $('pause-shade').hidden = true;
  visibilityPaused = document.hidden;
  if ((online || !document.hidden) && emulator?.state !== 'exited') emulator.run();
  reflectState(); $('canvas').focus(); resumeAudio();
}
function choosePause(choice) {
  if(enqueue(choice))return;
  if (pauseSeat === null) return;
  if (choice === 'resume') { closePause(); return; }
  if (!nativePause?.request(choice === 'round' ? 1 : 2, pauseSeat,nativeNow())) {
    $('pause-message').textContent = activeLang==='cn'?'当前回合无法认输。':'このラウンドでは降参できません。';
    nativeState = nativePause?.update(nativeNow()); refreshPauseMenu(); return;
  }
  closePause();
}
function navigatePause(seat, action) {
  if(enqueue(action))return;
  if (netplay && !sync?.applying && seat !== null) seat = seat === 0 ? netplay.localSeat : -1;
  if (pauseSeat === null || (seat !== null && seat !== pauseSeat)) return;
  const buttons = pauseButtons();
  if (action === 'resume') { closePause(); return; }
  if (action === 'confirm') { buttons[pauseSelection].click(); return; }
  if (!['up', 'down'].includes(action)) return;
  const step = action === 'up' ? -1 : 1;
  do { pauseSelection = (pauseSelection + step + buttons.length) % buttons.length; } while (buttons[pauseSelection].disabled);
  refreshPauseMenu(); buttons[pauseSelection].focus();
}
pauseButtons().forEach((button, i) => {
  button.addEventListener('click', () => choosePause(button.dataset.choice));
  button.addEventListener('focus', () => { if (!online || sync?.applying) { pauseSelection = i; refreshPauseMenu(); } });
});
// Clicking away from a pause button must not strand keyboard input on the
// canvas, touch overlay or iframe body. Restore focus without changing selection.
player.stage.addEventListener('pointerdown',event=>{
  if(pauseSeat===null||event.target.closest('#pause-menu'))return;
  event.preventDefault();event.stopPropagation();pauseButtons()[pauseSelection].focus();
},true);
window.addEventListener('focus',()=>{
  if(pauseSeat!==null&&!$('settings').open)pauseButtons()[pauseSelection].focus();
});
function clearEscape() { escapeAt = -Infinity; clearTimeout(escapeTimer); }
function handleEscape() {
  if(enqueue('escape'))return;
  if (closed || closing || !emulator || emulator.state !== 'running') return;
  nativeState = nativePause?.update(nativeNow());
  if (nativeState?.phase) { openPause(0); return; }
  if (!nativePause?.selecting) return;
  const now = performance.now();
  if (now - escapeAt <= 1000) { clearEscape(); closeGame(); return; }
  escapeAt = now;
  status('再按一次 Esc 关闭游戏');
  escapeTimer = setTimeout(() => { clearEscape(); reflectState(); }, 1000);
}
async function closeGame() {
  closing = true; controls.release(); visibilityPaused = false;
  emulator.pause(); clearTimeout(saveTimer); saveTimer = null;
  localBgm?.dispose(); localBgm = null;
  try { await emulator.module.SDL2?.audioContext?.suspend(); } catch {}
  await save();
  closed = true; closing = false; nativePause.reset(); nativeState = null; pauseSeat = null;
  $('pause-menu').hidden = $('pause-shade').hidden = true;
  $('cover').hidden = false; $('start').disabled = false; $('start').textContent = '启动游戏';
  for (const id of ['language', 'difficulty', 'clock', 'import']) $(id).disabled = false;
  $('reset').disabled = true;
  status(saved === dirty ? '游戏已关闭' : '游戏已关闭；存档保存失败，可导出备份', saved !== dirty); $('start').focus();
}
function trackNativePause() {
  if (!online && !closed && !closing && nativePause && emulator?.state !== 'exited') {
    nativeState = nativePause.update();
    if (nativeMusic && localBgm) {
      for (const [ax,hash] of nativeMusic.read(emulator.module.HEAPU8)) localBgm.command(ax,hash);
    }
    if (!nativePause.selecting && escapeAt !== -Infinity) { clearEscape(); reflectState(); }
    const result = nativePause.result();
    if (result === 'accepted') reflectState();
    if (result === 'rejected') {
      reflectState(); status('降参指令未被游戏接受，请重新暂停后再试。', true);
    }
    if (result === 'unknown') {
      reflectState(); status('无法确认降参指令的结果，请查看当前游戏画面。', true);
    }
    if (pauseSeat !== null) refreshPauseMenu();
  }
  player.setActive(!closed && !closing && emulator?.state === 'running' && pauseSeat === null && !$('settings').open);
  player.setContext({key: nativeState?.phase ? `round:${nativeState.generation}:${nativeState.phase}` : 'select:menu',
    play: nativeState?.phase === 1 && pauseSeat === null});
  setTimeout(trackNativePause, 100);
}
trackNativePause();
function stepSynchronized(inputs,frame,replay=false){
  emulator.module.netBeginFrame(frame,replay);
  const present = !replay && presentationDue(performance.now());
  // The native renderer can run ahead during catch-up. Avoid converting and
  // uploading discarded/intermediate frames; state simulation remains exact.
  emulator.module.skipFrameUpload = !present;
  try{
    syncReplaying=replay;
    syncFrame=frame;
    nativeState=nativePause.update(frame*1000/60);
    for(let seat=0;seat<2;seat++)for(const command of inputs[seat].commands){
      if(command==='hidden'){hiddenSeats.add(seat);continue;}
      if(command==='visible'){hiddenSeats.delete(seat);continue;}
      if(command==='pause'||command==='escape'){
        if(pauseSeat===seat)closePause();else if(pauseSeat===null)openPause(seat);
      }else if(pauseSeat===seat){
        if(['round','match','resume'].includes(command))choosePause(command);
        else navigatePause(seat,command);
      }
    }
    const paused=pauseSeat!==null||hiddenSeats.size>0;
    const applied=paused?inputs.map(input=>({...input,actions:[],touch:0})):inputs;
    controls.applyFrame(applied);
    if(!paused){
      emulator.run();emulator.step();
      confirmedMusic?.stage(frame,nativeMusic.read(emulator.module.HEAPU8));
      nativeState=nativePause.update((frame+1)*1000/60);
      nativePause.result((frame+1)*1000/60);
    }else emulator.pause();
    if(present)presentFrame();
    if(pauseSeat!==null&&!replay)refreshPauseMenu();
    window.th03SyncState={frame:frame+1,tick:emulator.module.netInfo().tick,phase:nativeState?.phase??0,
      selecting:nativePause.selecting,pauseSeat,hidden:[...hiddenSeats]};
  }finally{
    emulator.module.skipFrameUpload = false;
    emulator.module.netEndFrame();
    syncReplaying=false;
  }
}
function captureSynchronized(frame){
  if(syncSnapshots.has(frame))return;
  emulator.module.netCapture(frame);
  syncSnapshots.set(frame,{app:{pauseSeat,pauseSelection,hidden:[...hiddenSeats],visibilityPaused,nativePause:nativePause.capture(),music:nativeMusic.capture(),controls:controls.capture()}});
}
function restoreSynchronized(frame){
  const saved=syncSnapshots.get(frame);if(!saved)throw Error(`同步快照已过期：${frame}`);
  emulator.module.netRestore(frame);const state=saved.app;
  pauseSeat=state.pauseSeat;pauseSelection=state.pauseSelection;hiddenSeats.clear();for(const seat of state.hidden)hiddenSeats.add(seat);
  visibilityPaused=state.visibilityPaused;nativePause.restore(state.nativePause);nativeMusic.restore(state.music);confirmedMusic.rewind(frame);controls.restore(state.controls);
  localizePause();
  $('pause-menu').hidden=$('pause-shade').hidden=pauseSeat===null;
  if(pauseSeat===null)emulator.run();else emulator.pause();
  for(const key of [...syncSnapshots.keys()])if(key>=frame)syncSnapshots.delete(key);
  return frame;
}
function confirmSynchronized(prefix){
  confirmedMusic?.confirm(prefix);
  emulator.module.netConfirm?.(prefix);
  for(const key of [...syncSnapshots.keys()])if(key<prefix)syncSnapshots.delete(key);
}
function syncHash(){
  const heap=emulator.module.HEAPU8;let h=2166136261;
  // Match TH04: verify all 640 KiB of DOS conventional memory instead of
  // synchronously hashing the 20.5 MiB emulator heap every two seconds.
  // Keep full-heap checking available for emulator regression tests.
  let base=-1;
  if(nativeMusic?.valid(heap,nativeMusic.at)){
    const segment=new DataView(heap.buffer).getUint16(nativeMusic.at+16,true);
    base=nativeMusic.at-nativeMusic.patch.mailbox_com_offset-segment*16;
  }
  const full=netQuery.get('fullHash')==='1';
  const start=full?0:Math.max(0,base),end=full?heap.length:base<0?0:base+0xa0000;
  for(let i=start;i<end;i++)h=Math.imul(h^heap[i],16777619);
  return (h>>>0).toString(16).padStart(8,'0')+':'+emulator.module.netInfo().tick+':'+pauseSeat+':'+[...hiddenSeats].sort().join(',');
}
$('start').addEventListener('click', async () => {
  if (starting || (emulator && !closed) || closing) return;
  if (closed) {
    // A fresh page releases SDL callbacks, WASM and audio before a new boot.
    try { sessionStorage.setItem('th03-local-restart', JSON.stringify({lang: $('language').value,
      rank: $('difficulty').value, clock: $('clock').value})); } catch {}
    location.reload(); return;
  }
  starting = true;
  for (const id of ['start', 'language', 'difficulty', 'clock', 'import']) $(id).disabled = true;
  $('start').textContent = '正在启动';
  try {
    if (online) {
      status('正在读取房间开局设置');
      const query = new URLSearchParams({protocol: 'th03-lan/1', room: netQuery.get('room'), token: netQuery.get('token')});
      const response = await fetch(`/api/state?${query}`, {cache: 'no-store'});
      const room = await response.json();
      if (!response.ok || !room.started || room.mode !== netQuery.get('net')) throw Error(room.error || '房间尚未开始或模式不一致');
      for (const id of ['language', 'difficulty', 'clock']) $(id).value = String(room.settings[id]);
      rollbackEnabled=room.settings.rollback===true;
      roomFocusEnabled=room.settings.focusEnabled!==false;
      roomTouchUnlimitedAllowed=room.settings.touchUnlimitedAllowed===true;
      player.setUnlimitedAllowed(roomTouchUnlimitedAllowed);
      for(let seat=0;seat<2;seat++)$(`focus-enabled-${seat}`).checked=roomFocusEnabled;
    }
    activeLang = $('language').value;
    localizePause();
    const disk = await loadDisk(activeLang);
    if(online){
      const response=await fetch('lockstep-runtime.json',{cache:'no-store'});
      if(!response.ok)throw Error('同步引擎清单缺失');
      const runtime=await response.json();
      for(const [path,expected] of Object.entries(runtime.files)){
        const asset=await fetch(path,{cache:'no-store'});if(!asset.ok||await sha256(new Uint8Array(await asset.arrayBuffer()))!==expected)
          throw Error('同步资源校验失败：'+path);
      }
      syncIdentity={protocol:runtime.protocol,files:runtime.files,disk:await sha256(disk),
        language:activeLang,difficulty:$('difficulty').value,clock:$('clock').value,rollback:rollbackEnabled,focusEnabled:roomFocusEnabled,touchUnlimitedAllowed:roomTouchUnlimitedAllowed};
    }
    nativePause = new NativePause(() => emulator, (await nativeAssets()).meta);
    nativeState = null; clearEscape();
    status('正在启动 NP21');
    emulator = await (online?SyncNP21:NP21).create({canvas:online?nativeCanvas:visibleCanvas,lockstep:online,lockstepEpoch:946684800000,clk_base:2457600,clk_mult:Number($('clock').value),
      DIPswtch: [0x3e, 0xf3, 0x7b], ExMemory: 7, Latencys: online?40:100, SampleHz: 44100, SNDboard: 4,
      no_mouse: true, use_menu: false, fontfile: activeLang === 'cn' ? 'font_cn.bmp' : 'font.bmp',
      onDiskChange: diskChanged, onExit: () => {
        localBgm?.stop();
        controls.release(); pauseSeat = null; nativeState = null;
        $('pause-menu').hidden = $('pause-shade').hidden = true;
        nativePause.reset(); reflectState(); save();
      }});
    localBgm = new LocalBgm(emulator.module.SDL2.audioContext, () => {});
    nativeMusic = new NativeMusic((await nativeAssets()).meta.startup.music);
    confirmedMusic = new ConfirmedMusic(localBgm);
    // The device decodes music asynchronously; downloads cannot stall game start.
    const loadingBgm=localBgm;
    loadingBgm.load({warmOpening:true}).catch(error => {
      if(loadingBgm.closed)return;
      loadingBgm.status = `本地音乐错误：${error.message}`;
      console.error(error);
    });
    emulator.addDiskImage(`3-${activeLang}.hdi`, disk);
    emulator.setHdd(0, `3-${activeLang}.hdi`);
    if (online) {
      netplay = new Netplay({room: netQuery.get('room'), token: netQuery.get('token'), role: netQuery.get('role'), mode: netQuery.get('net'),
        onState: message => {
          $('connection-path').hidden=false;$('connection-path').textContent=`本机连接：${message}`;
          if(embedded)window.parent.postMessage({protocol:'th03-lan/1',event:'connection',message},location.origin);
        }, onError: error => report(error)});
      emulator.pause();
      status('正在连接另一台设备');
      await netplay.start();
      status('本机资源已就绪，等待另一位玩家');
      await netplay.waitForPlayers();
      sync=new Lockstep({network:netplay,rollbackEnabled,directionPrediction:netQuery.get('net')==='relay'?6:3,step:stepSynchronized,hash:syncHash,capture:captureSynchronized,restore:restoreSynchronized,confirm:confirmSynchronized,onError:report,
        onState:message=>status(message)});
      await netplay.synchronize(syncIdentity);
    }
    closed = false; dirty = saved = 0;
    $('cover').hidden = true; emulator.run(); $('canvas').focus(); resumeAudio();
    if(online)sync.start();
    $('reset').disabled = online; $('export').disabled = false;
    reflectState();
    if (!storageWarning) $('save-status').textContent = online ? '联机镜像' : '存档已就绪';
    if (online) notifyRoom('游戏已启动', true);
  } catch (error) {
    netplay?.close(); netplay = null; report(error); $('start').textContent = '刷新重试'; $('start').disabled = false;
    $('start').onclick = () => location.reload();
  } finally { starting = false; }
});
if (restartOnLoad || embedded) $('start').click();
$('reset').addEventListener('click', async () => {
  if (online || closed || closing || nativePause?.pending) return;
  if (!confirm('重新启动梦时空？当前对局会结束。')) return;
  controls.release(); emulator.pause(); await save();
  netplay?.close(); netplay = null;
  if (saved !== dirty && !confirm('存档未成功保存，仍要重新启动？')) { reflectState(); return; }
  clearEscape(); pauseSeat = null; nativeState = null; nativePause.reset();
  $('pause-menu').hidden = $('pause-shade').hidden = true;
  localBgm?.stop(); nativeMusic?.reset(); confirmedMusic?.frames.clear();
  visibilityPaused = false; emulator.reset(); emulator.run(); reflectState(); $('canvas').focus(); resumeAudio();
});
$('controls').addEventListener('click', () => { controls.release(); $('settings').showModal(); });
$('fullscreen').addEventListener('click', async () => {
  if ($('screen').classList.contains('immersive')) await player.exit(); else await player.enter();
});
$('canvas').addEventListener('pointerdown', () => { clearEscape(); $('canvas').focus(); resumeAudio(); });
$('canvas').addEventListener('contextmenu', event => event.preventDefault());
$('export').addEventListener('click', () => {
  try {
    const url = URL.createObjectURL(new Blob([emulator.getDiskImage(`3-${activeLang}.hdi`)], {type: 'application/octet-stream'}));
    const link = document.createElement('a'); link.href = url;
    link.download = `th03-${activeLang}-${new Date().toISOString().slice(0, 10)}.hdi`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) { report(error); }
});
$('import').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if ((emulator && !closed) || starting || closing) throw Error('请在启动前导入存档');
    const lang = $('language').value, meta = await metadata(lang);
    if (file.size !== meta.size) throw Error('存档镜像大小不匹配');
    const disk = await prepareDisk(new Uint8Array(await file.arrayBuffer()), meta, lang);
    if (!confirm('覆盖当前语言版本的本地存档？')) return;
    await stored(lang, 'readwrite', disk); status('存档已导入');
  } catch (error) { report(error); }
  finally { event.target.value = ''; }
});
document.addEventListener('visibilitychange', () => {
  clearEscape();
  if (closed || closing) return;
  if(online&&netplay){controls.release();netplay.command(document.hidden?'hidden':'visible');return;}
  if (document.hidden) {
    controls.release(); visibilityPaused = emulator?.state === 'running';
    if (visibilityPaused) emulator.pause();
    save();
  } else if (visibilityPaused) { visibilityPaused = false; if (pauseSeat === null) emulator?.run(); }
  reflectState();
});
window.addEventListener('blur', clearEscape);
window.addEventListener('beforeunload', event => {
  if (emulator && dirty !== saved) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { netplay?.close(); localBgm?.dispose(); });
