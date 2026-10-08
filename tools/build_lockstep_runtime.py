"""Generate a deterministic host around the pinned, unchanged NP21 WASM."""
import hashlib
import json
from pathlib import Path
from build_rollback_wasm import build as build_rollback_wasm
from optimize_np21_dispatch import optimize_dispatch
from build_frame_runtime import build as build_frame_runtime

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'web/vendor/np2'


def build():
    build_frame_runtime()
    source = (VENDOR / 'np21.js').read_text(encoding='utf-8')
    pinned = json.loads((VENDOR / 'SHA256SUMS.json').read_text())
    if hashlib.sha256(source.encode()).hexdigest() != pinned['np21.js']:
        raise ValueError('Upstream NP21 source changed')
    source = optimize_dispatch(source, VENDOR)
    rollback_wasm = build_rollback_wasm(VENDOR)

    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError(f'NP21 anchor changed: {old[:90]}')
        source = source.replace(old, new, 1)

    replace('var Module=moduleArg;', '''var Module=moduleArg;
const netHost=createDeterministicHost(Module);
const Date=netHost.Date;
Module.netKey=(type,event)=>{const callback=netHost.keys[type];if(!callback)throw Error('SDL keyboard not ready');callback(event);};
Module.netStep=()=>{if(!MainLoop.func||ABORT)throw Error('NP21 loop unavailable');netHost.tick++;netHost.now=netHost.tick*1000/60;MainLoop.func();netHost.advanceAudio();};
Module.netInfo=()=>({tick:netHost.tick,now:netHost.now,audioBlocks:netHost.audio?.produced||0,...netHost.audio?.output.info()});
Module.netFlushAudio=()=>netHost.audio?.output.flush();
let netSnapshots;
Module.netCapture=frame=>{
  if(!Module.SDL2?.ctx||GL.currentContext)throw Error('NP21 回滚要求已初始化的 Canvas 软件渲染');
  if(!netSnapshots)netSnapshots=createNativeSnapshots({module:Module,fs:FS,memfs:MEMFS,tty:TTY,host:netHost,exports:()=>wasmExports,
    readBridge:()=>({events:{...JSEvents,deferredCalls:JSEvents.deferredCalls.slice()},syscalls:{...SYSCALLS},stdin:FS_stdin_getChar_buffer.slice()}),
    writeBridge:s=>{for(const k of Object.keys(JSEvents))if(!(k in s.events))delete JSEvents[k];Object.assign(JSEvents,s.events);for(const k of Object.keys(SYSCALLS))if(!(k in s.syscalls))delete SYSCALLS[k];Object.assign(SYSCALLS,s.syscalls);FS_stdin_getChar_buffer=s.stdin.slice();}});
  netSnapshots.capture(frame);
};
Module.netSeal=()=>netSnapshots?.seal();
Module.netRestore=frame=>{netSnapshots.restore(frame);netHost.discard(frame);};
Module.netBeginFrame=(frame,replay)=>{netHost.replaying=!!replay;netHost.beginFrame(frame);};
Module.netEndFrame=()=>{netSnapshots?.seal();netHost.endFrame();netHost.replaying=false;};
Module.netConfirm=prefix=>{netSnapshots?.confirm(prefix);netHost.confirm(prefix);};
Module.netSnapshotInfo=()=>netSnapshots?.info()||{snapshotBytes:0,snapshots:0};
''')
    replace('var f="np21.wasm"', 'var f="np21-rollback.wasm"')
    replace('new URL("np21.wasm",import.meta.url)', 'new URL("np21-rollback.wasm",import.meta.url)')
    replace('function preRun(){', 'function preRun(){ENV["SDL_RENDER_DRIVER"]="software";')
    replace('var _emscripten_get_now=()=>performance.now();', 'var _emscripten_get_now=()=>netHost.now;')
    replace('var _emscripten_get_device_pixel_ratio=()=>devicePixelRatio;', 'var _emscripten_get_device_pixel_ratio=()=>1;')
    replace('var _emscripten_sample_gamepad_data=()=>{try{if(navigator.getGamepads)return(JSEvents.lastGamepadState=navigator.getGamepads())?0:-1}catch(e){navigator.getGamepads=null}return-1};',
            'var _emscripten_sample_gamepad_data=()=>{JSEvents.lastGamepadState=[];return 0;};')
    replace('HEAP32[width>>2]=screen.width;HEAP32[height>>2]=screen.height',
            'HEAP32[width>>2]=640;HEAP32[height>>2]=400')
    replace('var _emscripten_get_element_css_size=(target,width,height)=>{target=findEventTarget(target);if(!target)return-4;var rect=getBoundingClientRect(target);HEAPF64[width>>3]=rect.width;HEAPF64[height>>3]=rect.height;return 0}',
            'var _emscripten_get_element_css_size=(target,width,height)=>{HEAPF64[width>>3]=640;HEAPF64[height>>3]=400;return 0}')
    replace('var randomFill=view=>(randomFill=initRandomFill())(view);', 'var randomFill=view=>netHost.randomFill(view);')
    replace('var iterFunc=getWasmTableEntry(func);setMainLoop(iterFunc,fps,simulateInfiniteLoop)',
            'var iterFunc=getWasmTableEntry(func);MainLoop.func=iterFunc')
    replace('handlerFunc:keyEventHandlerFunc,useCapture};return JSEvents.registerOrRemoveHandler(eventHandler)',
            'handlerFunc:keyEventHandlerFunc,useCapture};netHost.keys[eventTypeString]=callbackfunc?keyEventHandlerFunc:null;return 0')
    replace('registerOrRemoveHandler(eventHandler){', 'registerOrRemoveHandler(eventHandler){return 0;')
    replace('new AudioContext', 'new AudioContext({sampleRate:44100,latencyHint:"interactive"})')
    replace('new webkitAudioContext', 'new webkitAudioContext({sampleRate:44100,latencyHint:"interactive"})')
    start = source.index('181622:($0,$1,$2,$3)=>{')
    end = source.index('182797:($0,$1)=>{', start)
    source = source[:start] + '181622:($0,$1,$2,$3)=>{netHost.openAudio(Module["SDL2"],$0,$1,()=>dynCall("vi",$2,[$3]))},' + source[end:]
    # Rollback replays are simulation-only. Do not upload each discarded
    # replay frame to Canvas; the next confirmed frame will be presented.
    replace('184897:($0,$1,$2)=>{var w=$0;',
            # Pixel conversion is the dominant mobile presentation cost. The
            # lockstep host may execute several simulation steps in one task;
            # the JS adapter marks only the step selected for presentation.
            '184897:($0,$1,$2)=>{if(netHost.replaying||Module.skipFrameUpload)return;Module.frameUploads=(Module.frameUploads||0)+1;var w=$0;')
    source = 'import {createNativeSnapshots} from "../../netplay/native-snapshots.js";\nimport {createDeterministicHost} from "../../np2-clock.js";\n' + source
    (VENDOR / 'np21-lockstep.js').write_text(source, encoding='utf-8', newline='\n')
    paths = ['vendor/np2/np21-lockstep.js', 'vendor/np2/np2-netplay.js', 'vendor/np2/np21-rollback.wasm', 'np2-clock.js', 'netplay/native-snapshots.js',
             'audio-output.js', 'native/main.exe', 'native/start.com', 'native-patch.json',
             'native/game-jp.bat', 'native/game-cn.bat', 'vendor/np2/font.bmp', 'vendor/np2/font_cn.bmp',
             'netplay.js', 'netplay/udp-config.js', 'lockstep.js', 'frame-queue.js', 'controls.js', 'app.js', 'native-pause.js',
             'player-ui.js', 'touch-input.js', 'touch-layout.js', 'disk.js', 'scores.js', 'sha256.js',
             'frame-limit.js']
    paths += ['local-bgm.js', 'native-music.js', 'native/music.com', 'bgm/manifest.json',
              'vendor/np2/np21-60.js', 'vendor/np2/np2-wasm.js']
    meta = {'protocol': 'th03-rollback/2', 'tickHz': 60, 'epoch': 946684800000,
            'dispatch': 'static-table-cache-v1',
            # TH03 routes commands through PMD with all music parts masked.
            # Unlike TH04, setting snd_active=0 also disables music events.
            'native_sound': {'bgm': 0, 'se': 1, 'schema': 2, 'config_bgm_mode': 1,
                             'mute': 'pmd-parts-0-14', 'se_part': 15},
            'files': {path: hashlib.sha256((ROOT / 'web' / path).read_bytes()).hexdigest() for path in paths}}
    (ROOT / 'web/lockstep-runtime.json').write_text(json.dumps(meta, indent=2) + '\n', encoding='utf-8')
    print('Built deterministic NP21 adapter and TH03 runtime fingerprints')


if __name__ == '__main__':
    build()
