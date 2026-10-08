import {readNetworkMode,networkParams,describeNetwork} from './netplay/network-mode.js';
const $ = id => document.getElementById(id), protocol = 'th03-lan/1';
let session = null, timer = null, busy = false, state = null, runtime = null;
const query = new URLSearchParams(location.search);
let connection=readNetworkMode();
$('mode').value=connection.mode;$('ice').value=connection.ice;
function renderConnection(){
  const isPublic=connection.network==='public';
  document.title=`东方梦时空 · ${isPublic?'公网':'局域网'}联机`;
  $('page-title').textContent=`${isPublic?'公网':'局域网'}联机`;
  document.querySelectorAll('[data-network]').forEach(link=>{
    if(link.dataset.network===connection.network)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  });
  $('mode-description').textContent=isPublic?'双方打开同一个公网网址，再创建或加入房间。':'双方连接同一个局域网，打开房主电脑提供的网址。';
  $('ice-option').hidden=!isPublic||connection.mode!=='rtc';
  $('connection-help').textContent=connection.mode==='relay'?'通过网页所在服务器转发输入；支持 HTTPS / WSS 和公网隧道。':
    !isPublic?'局域网内直接连接，不需要 STUN 或 TURN。':
    connection.ice==='relay'?'仅使用 TURN，用于打洞失败的网络；需要服务器已配置 TURN。':
    '使用 STUN 打洞，配置 TURN 后可自动中继；未配置 TURN 时仅尝试直连。失败可结束房间后切换 TCP。';
}
renderConnection();
$('mode').onchange=$('ice').onchange=()=>{
  if(session)return;
  connection={...connection,mode:$('mode').value,ice:$('ice').value};
  const params=networkParams(connection);if($('room').value)params.set('room',$('room').value);
  history.replaceState(null,'',`lan.html?${params}`);renderConnection();
};
if (/^\d{4}$/.test(query.get('room') || '')) $('room').value = query.get('room');
function status(value, error = false) { $('lan-status').textContent = value; $('lan-status').dataset.error = String(error); }
async function api(path, data = {}, method = 'POST') {
  const payload = {protocol, ...(session || {}), ...data};
  const url = method === 'GET' ? `/api/${path}?${new URLSearchParams(payload)}` : `/api/${path}`;
  const response = await fetch(url, {method, cache: 'no-store',
    headers: method === 'POST' ? {'Content-Type': 'application/json'} : undefined,
    body: method === 'POST' ? JSON.stringify(payload) : undefined});
  const value = await response.json();
  if (!response.ok) throw Error(value.error || `请求失败 (${response.status})`);
  return value;
}
function render(value) {
  if (!session) return;
  state = value;
  document.body.dataset.view=state.started?'playing':'room';
  $('entry').hidden = true; $('lobby').hidden = false; $('mode').disabled = true; $('mode').value = state.mode;
  connection={network:state.network||'lan',mode:state.mode,ice:state.ice||'all'};
  $('ice').value=connection.ice;$('ice').disabled=true;renderConnection();
  $('room-info').textContent = `房间 ${session.room}`;
  $('seat-help').textContent=`${describeNetwork(connection)} · 你是 ${session.role==='host'?'P1 · 左侧':'P2 · 右侧'}。开局后在游戏内选择角色。`;
  for (const role of ['host', 'guest']) {
    const card=$(role+'-seat');card.dataset.local=String(session.role===role);
    card.dataset.present=String(!!state.present[role]);card.dataset.ready=String(!!state.ready[role]);
    $(role + '-state').textContent = !state.present[role] ? '等待加入' : state.started ? '已开始' : state.ready[role] ? '已准备' : '未准备';
    $(role + '-progress').textContent = `${role === 'host' ? 'P1 房主' : 'P2 客机'}：${state.startup[role]?.message || '等待加载'}`;
    $(role + '-progress').dataset.error = String(!!state.startup[role]?.error);
  }
  for (const id of ['language', 'difficulty', 'clock']) $(id).value = String(state.settings[id]);
  $('rollback').checked = state.settings.rollback === true;
  $('focus-enabled').checked = state.settings.focusEnabled !== false;
  $('room-settings').disabled = busy || session.role !== 'host' || state.started;
  $('ready').disabled = busy || state.started;
  $('ready').textContent = state.ready[session.role] ? '取消准备' : '准备';
  $('start').disabled = busy || session.role !== 'host' || state.started || !state.present.guest || !state.ready.host || !state.ready.guest;
  $('startup-progress').hidden = !state.started;
  if (state.started && !runtime) launch();
  if (runtime && (!state.present.host || !state.present.guest)) {
    runtime.remove(); status('另一位玩家已离开，本局已结束', true);
  }
}
function launch() {
  const params = new URLSearchParams({net: state.mode, room: session.room, token: session.token, role: session.role,
    embedded: '1', language: state.settings.language, difficulty: state.settings.difficulty, clock: state.settings.clock,
    rollback: state.settings.rollback ? '1' : '0'});
  runtime = document.createElement('iframe'); runtime.title = '梦时空联机对战';
  runtime.allow = 'autoplay; fullscreen'; runtime.src = `local.html?${params}`;
  $('game').hidden = false; $('game').replaceChildren(runtime);
  requestAnimationFrame(()=>$('game').scrollIntoView({block:'start'}));
  status('正在加载双方游戏');
}
async function enter(kind) {
  if (busy || session) return;
  busy = true; $('create').disabled = $('join').disabled = true;
  try {
    const value = await api(kind, kind === 'create' ? {...connection,mode: $('mode').value,ice:$('ice').value} : {room: $('room').value.trim()});
    session = {room: value.room, token: value.token, role: value.role};
    busy = false; render(value.state);$('connection-settings').open=false;
    status(`你是 ${session.role === 'host' ? 'P1 · 左侧 · 房主' : 'P2 · 右侧 · 客机'}，确认设置后点击准备。`);
    poll();
  } catch (error) { status(error.message, true); }
  finally { busy = false; $('create').disabled = $('join').disabled = false; }
}
async function poll() {
  if (!session) return;
  try { if (!busy) render(await api('state', {}, 'GET')); }
  catch (error) {
    runtime?.remove(); status(error.message, true);
    if (runtime || /房间不存在|房间身份无效/.test(error.message)) return;
  }
  timer = setTimeout(poll, 1000);
}
async function mutate(path, data = {}) {
  if (busy || !session) return;
  busy = true; render(state);
  try { state = await api(path, data); }
  catch (error) { status(error.message, true); }
  finally { busy = false; render(state); }
}
$('create').onclick = () => enter('create'); $('join').onclick = () => enter('join');
$('room').addEventListener('keydown', event => { if (event.key === 'Enter') enter('join'); });
$('ready').onclick = () => mutate('ready'); $('start').onclick = () => mutate('start');
for (const id of ['language', 'difficulty', 'clock', 'rollback', 'focus-enabled']) $(id).onchange = () => mutate('settings', {settings: {
  language: $('language').value, difficulty: Number($('difficulty').value), clock: Number($('clock').value), rollback: $('rollback').checked, focusEnabled: $('focus-enabled').checked}});
$('leave').onclick = async () => {
  clearTimeout(timer); runtime?.remove();
  try { await api('leave'); } catch {}
  location.href = `lan.html?${networkParams(connection)}`;
};
$('share').onclick = async () => {
  const url = new URL('lan.html', location.href); const params=networkParams(connection);params.set('room',session.room);url.search=params;
  try { await navigator.clipboard.writeText(url.href); status('邀请链接已复制'); }
  catch { status(`邀请链接：${url.href}`); }
};
window.addEventListener('message', async event => {
  if (event.origin !== location.origin || event.source !== runtime?.contentWindow || event.data?.protocol !== protocol) return;
  const value = event.data;
  if(value.event==='view'){runtime.classList.toggle('game-immersive',value.immersive===true);return;}
  if(value.event==='connection'){
    $('connection-details').hidden=false;
    $('connection-path').hidden=false;$('connection-path').textContent=`本机连接：${String(value.message).slice(0,240)}`;return;
  }
  if (value.event === 'resize' && Number.isFinite(value.height)) {
    runtime.style.height = `${Math.max(400, Math.min(2200, value.height))}px`; return;
  }
  if (value.event !== 'progress') return;
  try { render(await api('progress', {message: value.message, loaded: value.loaded === true, error: value.error === true})); }
  catch (error) { status(error.message, true); }
  if (value.error) status(value.message, true);
  else if (value.loaded) status('本机游戏已启动');
});
window.addEventListener('pagehide', () => {
  if (session) navigator.sendBeacon('/api/leave', new Blob([JSON.stringify({protocol, ...session})], {type: 'application/json'}));
});
