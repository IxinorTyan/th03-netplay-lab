import {packTouch, unpackTouch, ALWAYS_POINT, MAX_INPUT} from './touch-input.js';
import {neutral} from './frame-queue.js';
import {loadRtcConfiguration,hasTurn,describeRtcPath} from './netplay/udp-config.js';
const ACTIONS=['up','down','left','right','shot','attack','focus'], protocol='th03-lan/1';
export class Netplay {
  constructor({room,token,role,mode,onState=()=>{},onError=()=>{}}){this.room=room;this.token=token;this.role=role;this.mode=mode;this.localSeat=role==='host'?0:1;this.onState=onState;this.onError=onError;this.remote=new Set();this.seq=0;this.lastRemote=-1;this.socket=null;this.pc=null;this.rtcPoll=null;this.rtcTimer=null;this.rtcResolve=null;this.rtcReject=null;this.pendingIce=[];this.remoteDescriptionReady=false;}
  async start(){
    try{
      const state=await this.state();
      if(this.closed)throw Error('连接已关闭');
      if(!state.started||state.mode!==this.mode)throw Error('房间尚未开始或模式不一致');
      // Server room policy wins over invite/query values on both devices.
      this.network=state.network||'lan';this.ice=state.ice||'all';
      this.heartbeat=setInterval(()=>this.state().catch(error=>this.fail(error)),5000);
      return await (this.mode==='relay'?this.startRelay():this.startRtc());
    }catch(error){this.close();throw error;}
  }
  async state(){const query=new URLSearchParams({protocol,room:this.room,token:this.token});const response=await fetch(`/api/state?${query}`,{cache:'no-store'});const state=await response.json();if(!response.ok)throw Error(state.error||'房间已结束');if(!state.present.host||!state.present.guest)throw Error('另一位玩家已离开');return state;}
  async waitForPlayers(){const response=await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocol,room:this.room,token:this.token,message:'本机资源已就绪',loaded:true})});if(!response.ok)throw Error('房间准备确认失败');const deadline=performance.now()+60000;while(!this.closed){const state=await this.state();if(state.startup.host?.error||state.startup.guest?.error)throw Error('另一端加载失败，请结束后重新建房');if(state.startup.host?.loaded&&state.startup.guest?.loaded)return;if(performance.now()>deadline)throw Error('等待另一端加载超时');await new Promise(resolve=>setTimeout(resolve,200));}throw Error('连接已关闭');}
  fail(error){if(this.closed)return;this.rtcReject?.(error);this.relayReject?.(error);this.rtcResolve=this.rtcReject=this.relayReject=null;this.close();this.onState(error.message);this.onError(error);}
  get isLockstep(){return true;}
  setLocal(actions,touch=0,options={}){
    this.localActions=[...actions];this.localOptions=options;
    const next=unpackTouch(touch),old=this.localTouch;
    this.localTouch={...next,alwaysPoint:touch>=ALWAYS_POINT,
      x:next.active?Math.max(-8192,Math.min(8191,(old?.active?old.x:0)+next.x)):0,
      y:next.active?Math.max(-8192,Math.min(8191,(old?.active?old.y:0)+next.y)):0};
  }
  command(value){this.commands??=[];if(this.commands.length<16)this.commands.push(value);}
  capture(){const touch=this.localTouch,input={...neutral(),actions:this.localActions||[],touch:touch?packTouch(0,touch):0,
    focusEnabled:this.localOptions?.focusEnabled??true,points:this.localOptions?.points??true,commands:this.commands?.splice(0)||[]};
    if(touch)touch.x=touch.y=0;return input;}
  sendPacket(packet){if(this.channel?.readyState!=='open')throw Error('同步通道未连接');
    if((this.channel.bufferedAmount||this.socket?.bufferedAmount||0)>524288)throw Error('联机发送队列拥塞，请结束后重新建房');
    this.channel.send(JSON.stringify({...packet,sync:'th03-rollback/1'}));}
  async synchronize(identity){
    this.sendPacket({type:'sync-ready',identity});
    const deadline=performance.now()+30000;
    while(!this.closed){
      if(this.peerIdentity){if(JSON.stringify(this.peerIdentity)!==JSON.stringify(identity))throw Error('双方游戏、补丁或同步引擎版本不同，请刷新后重新建房');
        this.synchronized=true;return;}
      if(performance.now()>deadline)throw Error('另一端未进入帧同步，请双方刷新后重新建房');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw Error('同步连接已关闭');
  }
  send(value,touch=0){const message=JSON.stringify({type:'input',seq:this.seq++,actions:[...value],touch});if(this.channel?.readyState==='open')this.channel.send(message);}
  receive(message){
    if(message.sync==='th03-rollback/1'){
      if(message.type==='sync-ready'){this.peerIdentity=message.identity;return;}
      if(message.type==='frame'||message.type==='check'||message.type==='rollback'){this.onPacket?.(message);return;}
      throw Error('未知同步消息');
    }
    if(message.type!=='input'||!Number.isSafeInteger(message.seq)||message.seq<=this.lastRemote||!Array.isArray(message.actions))return;
    const packed=message.touch??0;
    if(!Number.isSafeInteger(packed)||packed<0||packed>MAX_INPUT)return;
    this.lastRemote=message.seq;this.remote=new Set(message.actions.filter(value=>ACTIONS.includes(value)));
    const next=unpackTouch(packed),old=this.remoteTouch;
    this.remoteTouch={...next,alwaysPoint:packed>=ALWAYS_POINT,
      x:next.active?Math.max(-8192,Math.min(8191,(old?.active?old.x:0)+next.x)):0,
      y:next.active?Math.max(-8192,Math.min(8191,(old?.active?old.y:0)+next.y)):0};
  }
  takeTouch(){const touch=this.closed?null:this.remoteTouch;if(!touch)return 0;const value=packTouch(0,touch);touch.x=touch.y=0;return value;}
  startRelay(){
    const url=new URL('/relay',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    url.search=new URLSearchParams({room:this.room,token:this.token,role:this.role,protocol});
    this.onState('正在连接 TCP 服务器转发');this.socket=new WebSocket(url);
    const owner=this;
    this.channel={get readyState(){return owner.socket?.readyState===WebSocket.OPEN?'open':'connecting';},
      get bufferedAmount(){return owner.socket?.bufferedAmount||0;},send(value){owner.socket.send(value);}};
    return new Promise((resolve,reject)=>{
      this.relayReject=reject;
      this.relayTimer=setTimeout(()=>this.fail(Error('TCP 转发连接超时，请检查服务器或隧道')),30000);
      this.socket.onmessage=event=>{
        if(this.closed)return;
        try{
          const value=JSON.parse(event.data);
          if(value.type==='ready'){
            this.relayReject=null;clearTimeout(this.relayTimer);
            this.onState(`TCP 服务器转发 · ${url.protocol==='wss:'?'WSS':'WebSocket'} 已认证`);resolve();
          }else if(['error','peer-left'].includes(value.type))throw Error(value.message||'另一位玩家已断开');
          else this.receive(value);
        }catch(error){this.fail(error);}
      };
      this.socket.onerror=()=>this.fail(Error('TCP 转发连接失败，请检查公网入口、WebSocket 代理及 install-relay.bat 依赖'));
      this.socket.onclose=()=>this.fail(Error('TCP 转发连接已断开，请重新建房'));
    });
  }
  async signal(target,message){if(this.closed)return;const response=await fetch('/api/signal',{method:'POST',headers:{'Content-Type':'application/json'},signal:this.rtcAbort?.signal,body:JSON.stringify({protocol,room:this.room,token:this.token,to:target,message})});if(!response.ok)throw Error(`信令发送失败 (${response.status})`);}
  async startRtc(){
    if(typeof RTCPeerConnection!=='function')throw Error('浏览器不支持 WebRTC，请用现代浏览器或 TCP 服务器转发');
    this.rtcAbort=new AbortController();
    this.onState(this.network==='public'?'正在获取 STUN / TURN 连接配置':'正在连接局域网设备');
    const configTimer=setTimeout(()=>this.rtcAbort.abort(),10000);
    let config;
    try{config=await loadRtcConfiguration(this,this.rtcAbort.signal);}
    catch(error){if(error.name==='AbortError')throw Error('获取连接配置超时或已取消，请检查 TURN 服务');throw error;}
    finally{clearTimeout(configTimer);}
    if(this.closed)throw Error('连接已关闭');
    this.rtcHasTurn=hasTurn(config);
    this.onState(this.network!=='public'?'正在连接局域网设备':this.ice==='relay'?'正在连接 TURN 中继':
      this.rtcHasTurn?'正在尝试 UDP 打洞 / TURN 中继':'正在尝试 UDP 打洞（尚未配置 TURN，失败可改用 TCP）');
    this.pc=new RTCPeerConnection(config);
    this.pc.onicecandidate=e=>{
      if(e.candidate&&!this.closed)this.signal(this.role==='host'?'guest':'host',{type:'ice',candidate:e.candidate.toJSON()}).catch(error=>this.fail(error));
    };
    this.pc.onicecandidateerror=e=>{this.lastIceError=Number.isInteger(e.errorCode)?`（ICE 错误 ${e.errorCode}）`:'';};
    this.pc.onconnectionstatechange=()=>{
      if(this.closed)return;
      const state=this.pc.connectionState;
      if(state==='failed'||state==='closed')this.fail(Error(this.rtcFailure()));
      else if(state==='disconnected'){
        this.onState('网络暂时中断，正在等待恢复');
        this.disconnectTimer??=setTimeout(()=>this.fail(Error(this.rtcFailure())),10000);
      }else if(state==='connected'){
        clearTimeout(this.disconnectTimer);this.disconnectTimer=null;this.refreshPath();
      }
    };
    this.pc.ondatachannel=e=>this.attach(e.channel);
    const connected=new Promise((resolve,reject)=>{this.rtcResolve=resolve;this.rtcReject=reject;});
    this.rtcTimer=setTimeout(()=>this.fail(Error(this.rtcFailure())),45000);
    this.readSignals();
    if(this.role==='host'){
      // Frame packets include incremental touch movement and commands. Retain
      // reliable delivery; dropping frames needs an explicit resend protocol.
      Promise.resolve().then(async()=>{
        this.attach(this.pc.createDataChannel('th03-inputs',{ordered:true}));
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await this.signal('guest',{type:'offer',description:this.pc.localDescription});
      }).catch(error=>this.fail(error));
    }
    return connected;
  }
  rtcFailure(){
    return `WebRTC 连接失败或超时${this.lastIceError||''}。${this.network==='public'&&!this.rtcHasTurn?'当前未配置 TURN；请配置 TURN 或改用 TCP。':'请检查 STUN / TURN 网络，或改用 TCP 服务器转发。'}结束后重新建房再试。`;
  }
  attach(channel){
    if(this.closed){channel.close();return;}
    if(this.channel){channel.close();this.fail(Error('收到重复同步通道'));return;}
    this.channel=channel;
    channel.onopen=()=>{
      if(this.closed)return;
      clearTimeout(this.rtcTimer);this.rtcResolve?.();this.rtcResolve=this.rtcReject=null;
      this.onState('WebRTC 已连接 · 正在确认路径');this.refreshPath();
      this.pathTimer=setInterval(()=>this.refreshPath(),5000);
    };
    channel.onmessage=e=>{try{this.receive(JSON.parse(e.data));}catch(error){this.fail(error);}};
    channel.onerror=()=>this.fail(Error('WebRTC 数据通道错误'));
    channel.onclose=()=>this.fail(Error('WebRTC 数据通道已断开，请重新建房'));
  }
  async refreshPath(){
    if(this.closed||!this.pc||this.pathPending)return;
    this.pathPending=true;
    try{const stats=await this.pc.getStats();if(!this.closed&&this.pc.connectionState==='connected'&&this.channel?.readyState==='open')this.onState(describeRtcPath(stats));}
    catch{}finally{this.pathPending=false;}
  }
  async readSignals(){
    if(this.closed)return;
    try{
      const query=new URLSearchParams({protocol,room:this.room,token:this.token});
      const response=await fetch(`/api/signals?${query}`,{cache:'no-store',signal:this.rtcAbort.signal});
      const value=await response.json();if(!response.ok)throw Error(value.error||'信令读取失败');
      for(const item of value.messages||[]){if(this.closed)return;await this.handleSignal(item.from,item.message);}
    }catch(error){if(!this.closed)this.fail(error);}
    // Continue receiving late trickled candidates after DataChannel opens.
    // Chained timeouts prevent overlapping polls from reordering offer/ICE.
    if(!this.closed)this.rtcPoll=setTimeout(()=>this.readSignals(),this.channel?.readyState==='open'?1000:300);
  }
  async handleSignal(from,message){if(message.type==='offer'&&this.role==='guest'){await this.pc.setRemoteDescription(message.description);this.remoteDescriptionReady=true;for(const candidate of this.pendingIce.splice(0))await this.pc.addIceCandidate(candidate);await this.pc.setLocalDescription(await this.pc.createAnswer());await this.signal('host',{type:'answer',description:this.pc.localDescription});}else if(message.type==='answer'&&this.role==='host'){await this.pc.setRemoteDescription(message.description);this.remoteDescriptionReady=true;for(const candidate of this.pendingIce.splice(0))await this.pc.addIceCandidate(candidate);}else if(message.type==='ice'){if(this.remoteDescriptionReady)await this.pc.addIceCandidate(message.candidate);else this.pendingIce.push(message.candidate);}}
  closeRtc(){clearTimeout(this.rtcPoll);clearTimeout(this.rtcTimer);clearTimeout(this.disconnectTimer);clearInterval(this.pathTimer);this.rtcAbort?.abort();this.rtcPoll=null;this.rtcTimer=null;}
  close(){if(this.closed)return;this.closed=true;this.rtcReject?.(Error('WebRTC 连接已结束'));this.relayReject?.(Error('TCP 连接已结束'));this.rtcResolve=this.rtcReject=this.relayReject=null;this.remote.clear();clearInterval(this.heartbeat);clearTimeout(this.relayTimer);this.closeRtc();this.socket?.close();this.channel?.close?.();this.pc?.close();}
}
