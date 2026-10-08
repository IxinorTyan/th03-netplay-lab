import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createNativeSnapshots} from '../web/netplay/native-snapshots.js';

const heap=new Uint8Array(328*65536),disk=new Uint8Array(8192);
const node={mode:0,contents:disk},stream={node,position:0};
const fs={root:node,streams:[stream],nameTable:[],isDir:()=>false};
const memfs={stream_ops:{write(stream,buffer,offset,length,position){
  stream.node.contents.set(buffer.subarray(offset,offset+length),position);return length;
}}};
let tick=0,bridge=0,openFrame=null,replaying=false;
const host={capture:()=>({tick}),restore:saved=>{tick=saved.tick;}};
const globals={__rollback_g0:new WebAssembly.Global({value:'i32',mutable:true},0),
  __rollback_g1:new WebAssembly.Global({value:'i32',mutable:true},0)};
const module={HEAPU8:heap};
const snapshots=createNativeSnapshots({module,fs,memfs,tty:{ttys:{}},host,exports:()=>globals,
  readBridge:()=>({bridge}),writeBridge:saved=>{bridge=saved.bridge;}});
Object.assign(module,{
  netCapture:frame=>snapshots.capture(frame),netRestore:frame=>snapshots.restore(frame),
  netConfirm:prefix=>snapshots.confirm(prefix),netInfo:()=>({tick}),
  netBeginFrame(frame,replay){assert.equal(openFrame,null);openFrame=frame;replaying=replay;},
  netEndFrame(){snapshots.seal();openFrame=null;replaying=false;},
});
const context=vm.createContext({emulator:{module,run(){},pause(){},step(){tick++;}},
  nativePause:{update:()=>({phase:1}),result(){},capture:()=>({}),restore(){}},
  nativeMusic:{read:()=>[],capture:()=>({}),restore(){}},
  confirmedMusic:{stage(){},rewind(){},confirm(){}},
  presentationDue:()=>false,presentFrame(){},performance,
  controls:{applyFrame(){heap[0]++;bridge++;globals.__rollback_g0.value++;
    memfs.stream_ops.write(stream,new Uint8Array([heap[0]]),0,1,0);
  },capture:()=>({}),restore(){}},
  syncSnapshots:new Map(),hiddenSeats:new Set(),pauseSeat:null,pauseSelection:0,
  visibilityPaused:false,syncReplaying:false,syncFrame:0,nativeState:null,
  $:()=>({hidden:false}),window:{},refreshPauseMenu(){}});
const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
vm.runInContext(source.slice(source.indexOf('function stepSynchronized('),source.indexOf('function syncHash(')),context);
const inputs=[{actions:[],commands:[],touch:0},{actions:[],commands:[],touch:0}];

// Exercise the actual application callbacks, including paused and replay steps.
context.captureSynchronized(0);
assert.throws(()=>snapshots.capture(1),/上一回滚帧尚未结束/,'Missing end-frame reproduces the original failure');
context.stepSynchronized(inputs,0);
context.pauseSeat=0;
context.captureSynchronized(1);context.stepSynchronized(inputs,1,true);
assert.equal(openFrame,null);assert.equal(replaying,false);assert.equal(tick,1);
context.restoreSynchronized(0);
assert.equal(heap[0],0);assert.equal(disk[0],0);assert.equal(bridge,0);
assert.equal(globals.__rollback_g0.value,0);assert.equal(tick,0);
assert.equal(context.syncSnapshots.size,0,'Restored checkpoint must be captured again');
context.captureSynchronized(0);context.stepSynchronized(inputs,0);
context.confirmSynchronized(1);

// Fill the entire prediction window, restore an odd frame and replay it.
for(let frame=1;frame<=12;frame++){
  context.captureSynchronized(frame);context.stepSynchronized(inputs,frame);
}
assert.equal(snapshots.info().snapshots,12);
context.restoreSynchronized(3);
assert.equal(heap[0],3);assert.equal(disk[0],3);assert.equal(tick,3);
for(let frame=3;frame<=12;frame++){
  context.captureSynchronized(frame);context.stepSynchronized(inputs,frame,true);
}
assert.equal(heap[0],13);assert.equal(disk[0],13);
context.confirmSynchronized(13);
for(let frame=13;frame<100;frame++){
  context.captureSynchronized(frame);context.stepSynchronized(inputs,frame);
  context.confirmSynchronized(frame+1);
}
assert.equal(snapshots.info().snapshots,0);assert.equal(context.syncSnapshots.size,0);

context.captureSynchronized(100);
context.controls.applyFrame=()=>{throw Error('test failure');};
assert.throws(()=>context.stepSynchronized(inputs,100,true),/test failure/);
assert.equal(openFrame,null);assert.equal(replaying,false);assert.equal(context.syncReplaying,false);
context.captureSynchronized(101);
module.netEndFrame();context.confirmSynchronized(102);
console.log('PASS: native snapshot lifecycle, paused frames, odd-frame rollback, disk undo, checkpoint recapture, window reuse and error cleanup');
