# NP21 mobile runtime

Install the build-only dependency with `npm install --ignore-scripts` in this
directory (WABT pinned to 1.0.39), then run `python tools/build_lockstep_runtime.py`
from the project root. Deploy the complete generated `web` directory; no Node or
WABT is needed on the web server. Keep both original and mobile WASM files.

The pinned upstream binary is never overwritten. Exact WAT anchors fail closed.
The native invoke bridge eliminates five WASM-to-JS dispatch sites; it preserves
numeric longjmp, JS exception identity and the stack on catchable exceptions.
Uncatchable native WASM traps stop the instance at the JS frame boundary.
Browsers without WebAssembly.JSTag/Exception use the original binary. The module
option `disableMobileOptimization` selects that compatibility path for testing.

TH03's 19-cycle and TH04's 17-cycle idle loops are recognized by exact bytes,
CPU flags, operands, mode and memory mapping. Only complete loops are elided;
the final partial loop and interrupt boundary run in the original interpreter.
Page checks do not mutate the TLB. Diagnostic counters are removed, leaving the
original two mutable WASM globals for rollback snapshots.

Local games additionally yield after at most two native frames, retaining up to
12 pending frames, and upload RGB565 pixels directly to WebGL. Native timing and
audio remain unchanged. Software rendering retains the SDL presentation path.
The original game's simulation rate is approximately 56.4 Hz, not 60 Hz.

Network games retain the original deterministic 60 Hz host clock, frame batching,
software presentation, audio and snapshot logic. Runtime manifests fingerprint
the new binary as well as the compatibility runtime. Both peers must refresh.
