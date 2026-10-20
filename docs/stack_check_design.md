# Stack check: a dynamic net under the stack strategies

Session 350, build `x54`. Runtime (`ts_rt.c`, `ts_rt.h`), emitter
(`emit_c.rs`), driver (`garnet --stack-check`). Off by default: the
emitter changes nothing unless `TSAOT_STACK_CHECK=1`, the runtime compiles
the checks only under `-DTSAOT_STACK_CHECK`.

## Why

The escape analysis decides which allocations live in the C frame: class
instances and scope records (`Stack`, a struct in the frame) and closures
(`Stack`, a `ts_func` and its environment array in the frame). A hole in
the analysis is a use after return, and it is silent: the frame's memory
is reused, the program reads whatever the next call left there. Session
350 found such holes by writing attack fixtures (`x48`: stores through a
parameter's contents; `x53`: four more in one probing session), which
covers the paths someone thought of. The remaining paths need a net that
checks every program the gates already run.

## Mechanism

**Quarantine.** In check mode every `Stack` allocation of the emitted code
goes to a quarantine region instead of the C frame:
`ts_sc_alloc(size, site, fn)` returns zeroed memory from a bump region
that is never reused, preceded by a small record (magic, site, function
name, activation, dead flag). The object keeps `gen = TS_GEN_NONHEAP` and
the stack-tagged reference, so the collector treats it exactly as a frame
cell (marks it, scans it, never moves it); the plausibility test of a
stack-tagged pointer also accepts the quarantine range.

**Activations.** A function body with a `Stack` site declares, in check
mode, `ts_sc_act _sc_act __attribute__((cleanup(ts_sc_leave))) =
ts_sc_enter();`: a fresh activation id that becomes current. Every
quarantine allocation records the current activation and is pushed on a
side stack. `ts_sc_leave` runs on every return path (the cleanup
attribute), marks the activation's records dead (on top of the side
stack: inner activations have left already) and restores the previous
activation. The shadow frames are not used for this: they are pushed
lazily and coalesced, while the cleanup attribute is exact.

**Exceptions.** A `ts_throw` longjmps past the cleanups of the activations
it unwinds. `ts_eh_push` (and the coroutine variant) records the current
activation in the handler; `ts_throw` marks dead every record of a later
activation (they are the top of the side stack) and restores the
handler's activation before the jump.

**Death.** A dead class instance's fields (after its object header) and a
dead closure's whole environment array become `0xDB` bytes (a double,
never a heap reference): a program that reads a dead object through a
dangling reference sees garbage instead of the value the frame happened to
keep. The headers stay valid (a function keeps its code and environment
pointer), so the collector can still reach and identify the object.

**Detection.** A stack-tagged pointer into the quarantine resolves through
the record: a live cell is a non-heap cell as before, a dead one is NULL
(the collector does not scan it) and is reported, unless a minor
collection is running: a minor collection also scans the old cells of the
remembered set, which may be unreachable and legitimately hold a cell of a
returned frame (a heap array the cell was stored in, dead too). A full
collection marks only from the roots, and a program that touches a dead
cell through the runtime is using a dangling reference, so both report:
`[stack-check] site N (fn): a stack object is reachable after its frame
returned`, then abort (`TSAOT_STACK_CHECK_CONTINUE=1`: report each site
once and keep running; a summary at exit). An `atexit` full collection
reports what is still reachable at the end, and
`TSAOT_STACK_CHECK_FULL_EVERY=N` adds a full collection after every N
minor ones, so a dangling reference dropped before the next scheduled
full collection is still seen. Objects of activations that never returned
(`process.exit` deep in a call) are live, not reported.

## What it covers and what it does not

- Covers every `Stack` object kind the emitter has today (class instances,
  scope records, closures and their environments), on the normal and the
  coroutine emission paths, and the per-iteration slot of the parity mode.
- A dangling reference that no full collection reaches (dropped before
  the next one, or held only in a C local) is caught only by the poison;
  `TSAOT_STACK_CHECK_FULL_EVERY=1` with `TSAOT_GC_YOUNG_THRESHOLD=1` makes
  nearly every allocation a full collection.
- SROA'd objects have no allocation and are not checked; their bugs show
  as wrong values (V8 diff).
- Arena strategies (`FrameArena`, `CallerArena`) are annotations that
  allocate on the heap today; when they get a real arena they must go
  through the same quarantine.

## Use

- `garnet --stack-check foo.ts` (sets `TSAOT_STACK_CHECK=1` for the
  emitter and `-DTSAOT_STACK_CHECK` for the C compiler; the cached runtime
  object gets its own name).
- Conformance: `TSAOT_STACK_CHECK=1 TSAOT_CC="gcc -O2 -DTSAOT_STACK_CHECK"
  scripts/gate.sh conf all`, also with `TSAOT_GC_YOUNG_THRESHOLD=1`.
- The compiler: build `scripts/build_typescript_native.sh` with
  `TSAOT_STACK_CHECK=1` and the flag in `TSAOT_NATIVE_CC`, run one compile
  with `TSAOT_STACK_CHECK_CONTINUE=1`.

## Results (`x54`)

- Validation: `alias_handback_lifetimes` compiled by analyzers with one of
  the `x53` fixes removed is reported at 8, 8 and 2 sites (handed-back
  phantoms, closure creation, compact nests), with the fixes at none; the
  runtime test `ts_sc_test.c` covers a dead cell held by a global, a cell
  nobody holds, an unwound activation and the catching activation's cell.
- The conformance suite in check mode: 462/462 and zero reports, also
  under `TSAOT_GC_YOUNG_THRESHOLD=1`.
- The compiler built in check mode (`x54sc`: 3,208 quarantine allocation
  sites, 955 activations): a full compile of `src/compiler` reports
  nothing, diagnostics and the 78 emitted files identical to Node; also
  with a full collection every 20 and every 2 minor ones
  (`TSAOT_STACK_CHECK_FULL_EVERY`, 6 s and 21 s). The quarantine holds
  about 750 MB per compile (maximum resident 0.75 -> 1.49 GB).
- The default runtime's machine code is identical to the previous one;
  the default emission is unchanged (parity).

## Gates

Default output byte-identical (parity, the conformance suite unchanged).
A fixture of known holes, compiled by an analyzer with one of the `x53`
fixes removed, must be reported by the check; the check mode itself must
pass the conformance suite, the bundler fixtures and a compile of the
compiler with zero reports, or each report is a hole to fix.
