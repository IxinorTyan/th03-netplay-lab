import {FrameQueue,TICK_MS} from './frame-queue.js';
export class Lockstep {
  constructor({network,step,hash,onError,onState,capture,restore,confirm,rollbackEnabled=false,directionPrediction=3}){
    Object.assign(this,{network,step,hash,onError,onState,capture,restore,confirm,rollbackEnabled});
    this.queue=new FrameQueue(network.localSeat,{rollbackEnabled,directionPrediction});this.hashes=new Map();this.remoteHashes=new Map();this.pendingHashes=new Map();
    this.costs={simulate:0,steps:0,capture:0,captures:0,restore:0,restores:0,hash:0,confirm:0,replays:0};
    this.running=false;this.applying=false;this.last=0;this.budget=0;this.lastProgress=performance.now();this.replayUntil=null;
    this.timer=null;this.wakeTimer=null;this.wakePending=false;this.wakeToken=0;this.frameHandle=null;this.pumping=false;
    this.wakeChannel=typeof MessageChannel==='function'?new MessageChannel():null;
    if(this.wakeChannel)this.wakeChannel.port1.onmessage=event=>{
      if(event.data!==this.wakeToken||!this.wakePending||!this.running)return;
      this.wakePending=false;this.wakeTimer=null;this.pump(performance.now());
    };
    network.onPacket=packet=>{try{
      if(packet.type==='frame')this.queue.receive(packet.frame,packet.input);
      else if(packet.type==='rollback'){
        if(!this.rollbackEnabled||this.network.localSeat===0)throw Error('无效回滚启用通知');
        this.queue.arm(packet.frame);
      }else if(packet.type==='check'){
        if(!Number.isSafeInteger(packet.frame)||packet.frame<0||packet.frame>this.queue.frame+120||typeof packet.hash!=='string'||packet.hash.length>128)throw Error('校验消息无效');
        this.remoteHashes.set(packet.frame,packet.hash);this.compare(packet.frame);
      }
    }catch(error){this.fail(error);}finally{this.wake();}};
  }
  compare(frame){
    if(!this.hashes.has(frame)||!this.remoteHashes.has(frame))return;
    if(this.hashes.get(frame)!==this.remoteHashes.get(frame))this.onState?.(`双方校验不同（第 ${frame} 帧），已继续回滚同步`);
    this.hashes.delete(frame);this.remoteHashes.delete(frame);
  }
  confirmFrames(){
    const prefix=Math.min(this.queue.frame,this.queue.confirmed);this.confirm?.(prefix);
    for(const [frame,hash] of this.pendingHashes)if(frame<=prefix){
      this.hashes.set(frame,hash);this.network.sendPacket({type:'check',frame,hash});this.compare(frame);this.pendingHashes.delete(frame);
    }
  }
  start(){
    this.running=true;this.last=performance.now();this.lastProgress=this.last;
    if(this.rollbackEnabled&&this.network.localSeat===0){
      const frame=this.queue.frame+120;
      this.queue.arm(frame);this.network.sendPacket({type:'rollback',frame});
    }
    this.schedule();
  }
  schedule(){
    if(!this.running||this.frameHandle!==null)return;
    const run=now=>{this.frameHandle=null;if(this.running)this.pump(now);};
    if(typeof requestAnimationFrame==='function')this.frameHandle=requestAnimationFrame(run);
    else this.timer=setTimeout(()=>{this.timer=null;run(performance.now());},Math.max(1,TICK_MS));
  }
  wake(delay=0){
    if(!this.running)return;
    const deadline=performance.now()+Math.max(0,delay);
    if(this.wakePending&&this.wakeAt<=deadline)return;
    this.wakePending=true;this.wakeAt=deadline;const token=++this.wakeToken;
    clearTimeout(this.wakeTimer);this.wakeTimer=null;
    if(delay===0&&this.wakeChannel)this.wakeChannel.port2.postMessage(token);
    else this.wakeTimer=setTimeout(()=>{
      if(token!==this.wakeToken||!this.wakePending||!this.running)return;
      this.wakePending=false;this.wakeTimer=null;this.pump(performance.now());
    },Math.max(0,delay));
  }
  pump(now=performance.now()){
    if(!this.running||this.pumping)return;
    this.pumping=true;
    try{
      this.budget=Math.min(TICK_MS*4,this.budget+Math.max(0,now-this.last));this.last=now;
      const started=performance.now();let steps=0;
      const timed=(kind,fn)=>{const at=performance.now();const result=fn();this.costs[kind]+=performance.now()-at;return result;};
      const simulate=replay=>{
        const pair=this.queue.peek();if(!pair)return false;
        const frame=this.queue.frame;
        if(this.queue.active&&frame>=this.queue.confirmed){timed('capture',()=>this.capture?.(frame));this.costs.captures++;}
        this.applying=true;try{timed('simulate',()=>this.step(pair,frame,replay));}finally{this.applying=false;}
        this.queue.commit(pair);this.costs.steps++;
        if(this.queue.frame%120===0)this.pendingHashes.set(this.queue.frame,timed('hash',()=>this.hash()));
        timed('confirm',()=>this.confirmFrames());this.queue.prune();
        steps++;this.lastProgress=performance.now();return true;
      };
      if(this.queue.dirty!==null){
        // Send the frontier input before restoring history, as in TH04.
        if(this.budget>=TICK_MS&&(this.replayUntil===null||this.queue.frame>=this.replayUntil)&&this.queue.needsCapture()){
          const packet=this.queue.capture(this.network.capture());if(packet)this.network.sendPacket(packet);
        }
        const from=this.queue.dirty;
        this.replayUntil=Math.max(this.replayUntil??0,this.queue.frame);
        const restored=timed('restore',()=>this.restore?.(from)??from);this.queue.rewind(restored);this.costs.restores++;
        for(const at of this.pendingHashes.keys())if(at>restored)this.pendingHashes.delete(at);
      }
      timed('confirm',()=>this.confirmFrames());
      // Replay repairs historical frames; it must not consume the real-time
      // budget for new frames. Limit each JS task to TH04's 4 steps / 6 ms.
      while(this.replayUntil!==null&&this.queue.frame<this.replayUntil&&steps<4&&(steps===0||performance.now()-started<6)){
        if(!simulate(this.queue.frame+1<this.replayUntil))break;
        this.costs.replays++;
      }
      if(this.replayUntil!==null&&this.queue.frame>=this.replayUntil)this.replayUntil=null;
      while(this.replayUntil===null&&this.budget>=TICK_MS&&steps<4&&(steps===0||performance.now()-started<6)){
        if(this.queue.needsCapture()){
          const packet=this.queue.capture(this.network.capture());if(packet)this.network.sendPacket(packet);
        }
        if(!simulate(false))break;
        this.budget-=TICK_MS;
      }
      const after=performance.now(),wait=after-this.lastProgress;
      if(wait>15000&&this.queue.waitReason==='window')throw Error('联机延迟超过回滚窗口，请双方检查网络连接');
      if(wait>600)this.onState?.(`等待另一端第 ${this.queue.frame} 帧输入`);
      else if(steps&&this.queue.frame%120===0)this.onState?.(`帧同步运行中 · ${this.queue.frame}`);
      this.schedule();
      if(this.replayUntil!==null)this.wake(steps?0:16);
      else this.wake(Math.max(1,TICK_MS-this.budget-(after-this.last)));
    }catch(error){this.fail(error);}finally{this.pumping=false;}
  }
  fail(error){if(this.failed)return;this.failed=true;this.stop();this.onError(error);}
  stop(){this.running=false;clearTimeout(this.timer);clearTimeout(this.wakeTimer);this.timer=null;this.wakeTimer=null;this.wakePending=false;this.wakeToken++;if(this.frameHandle!==null&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(this.frameHandle);this.frameHandle=null;}
}
