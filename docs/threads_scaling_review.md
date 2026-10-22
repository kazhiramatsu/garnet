# Threads: what beating scriptc takes, a decision review

Session 352. Kaz asked for this review before committing to the threads
plan (`docs/threads_design.md`): the goal is to beat scriptc's tsc-ts, and
the time should fall linearly with the number of checkers. Kaz also asked
to reconsider thread-local storage, which the first accessor experiment
had rejected.

All numbers: Apple M5 (four performance and six efficiency cores, 32 GB),
the TypeScript 6.0.3 compiler project (`-p src/compiler/tsconfig.json`, no
declarations or source maps, as `scripts/build_tsc_ts_native.sh`'s
benchmark runs it), medians of three runs or of eight A/B pairs, outputs
compared byte for byte (identical everywhere).

## Questions for the reviewer

1. Can the plan (milestone A, isolated workers, then B, published graphs)
   reach the goal? Is the projection below sound, and what does it miss?
2. Which accessor for per-isolate state: the stack-aligned block, or
   thread-local storage read directly (section "The accessor")? Is the
   direct read acceptable for production on Darwin?
3. Is single-thread performance a prerequisite, and should it come first?
4. Is there a concurrency design for garnet that could scale better than
   scriptc on this workload, given that tsc-ts's sources stay unmodified?

## Where garnet and scriptc stand

### One thread

tsc-ts's `--extendedDiagnostics`, one checker:

| phase | garnet | scriptc | garnet / scriptc |
|---|---|---|---|
| parse | 0.26 s | 0.10 s | 2.6x |
| bind | 0.10 s | 0.027 s | 3.7x |
| check | 0.82 s | 0.57 s | 1.44x |
| emit | 0.54 s | 0.395 s | 1.37x |
| total | 1.73 s | 1.10 s (wall 1.05 s) | 1.65x |

Peak memory: garnet 737 MB, scriptc 403 MB.

### Scaling with checkers

| checkers | scriptc, shared graphs | tsc-ts on Node (the Node path) |
|---|---|---|
| 1 | 1.05 s, 403 MB | 3.27 s, 821 MB |
| 2 | 0.56 s (x1.88), 434 MB | 2.75 s (x1.19), 1.3 GB |
| 4 | 0.43 s (x2.44), 472 MB | 3.05 s (x1.07), 2.2 GB |
| 6 | 0.46 s (x2.28), 484 MB | 3.52 s (x0.93), 3.0 GB |
| 8 | 0.47 s (x2.23), 509 MB | 4.20 s (x0.78), 4.0 GB |

scriptc's phases by checker count: at two checkers parse 0.044 s and the
rest (bind, check and emit on the checkers) 0.51 s; at four 0.043 s and
0.38 s; at eight 0.045 s and 0.41 s. So scriptc parses in parallel (2.3x)
and its divisible work (bind, check, emit: 0.99 s on one thread) scales
1.94x at two checkers and 2.6x at four, then stops: beyond four the
efficiency cores add nothing measurable.

The Node path (every worker rebuilds its own program, results come back
as cloned plain objects) scales badly on Node because each worker starts
cold and JIT-compiles tsc-ts again while V8's helper threads compete for
the cores (user time 6.6 s at one checker, 18.8 s at four). garnet's
native workers would not pay that. scriptc cannot run the Node path: built
with `sharesPublishedGraphs` forced false, its typed message decoding
rejects the plain results ("expected CheckerResult at $.result").

How garnet's code behaves under concurrency, measured with whole
one-thread compiles running side by side:

| copies at once | each copy | parse and bind | check and emit |
|---|---|---|---|
| 1 | 1.75 s | 0.36 s | 1.38 s |
| 2 | 1.83 s | 0.37 s | 1.45 s |
| 4 | 1.99 s | 0.40 s | 1.60 s |
| 6 | 2.42 s | 0.46 s | 1.95 s |

Concurrency alone costs 4% at two, 14% at four, 38% at six (the efficiency
cores).

## What beating scriptc takes

Projected for garnet at today's single-thread speed (`P`: parse and bind,
`W`: check and emit, `s`: the concurrency slowdown above):

- **A, isolated workers** (Node's model, tsc-ts's Node path): main parses
  and binds, then its workers rebuild the program while main starts
  checking; `T = P + P s + (W - P) s / N`. With the divisible work scaling
  as scriptc's instead (its duplicated cross-file checking included), the
  last term becomes `(W - P) / speedup`.
- **B, published graphs** (scriptc's model, tsc-ts's shared path): parallel
  parse (scriptc's 2.3x), then bind, check and emit on the checkers scaling
  as scriptc's (1.94x at two, 2.6x at four).

| checkers | scriptc (measured) | garnet A | garnet B | garnet B, single-thread parity |
|---|---|---|---|---|
| 1 | 1.05 s | 1.73 s | 1.73 s | ~1.05 s |
| 2 | 0.56 s | 1.27-1.28 s | ~0.87 s | ~0.56 s |
| 4 | 0.43 s | 1.06-1.19 s | ~0.67 s | ~0.43 s |

Conclusions:

- A alone gives about 1.5x at four checkers (for four times the memory:
  each checker holds its own program) and cannot approach scriptc.
- B gives about 2.6x, but garnet stays 1.6x behind scriptc at every
  checker count, because the single-thread gap carries through: with the
  same parallel structure, the times scale together.
- Beating scriptc therefore needs both B and a single thread at least as
  fast as scriptc's; every percent of single-thread time is a percent of
  the parallel time. The largest gaps are parse (2.6x) and bind (3.7x),
  which B parallelizes but does not remove, then check (1.44x) and emit
  (1.37x).

## Linear scaling

scriptc itself scales its divisible work 2.6x on four performance cores
(65% efficiency) and not at all beyond them. The limits:

- **The hardware.** Four performance cores; the efficiency cores add
  little to this workload (scriptc flat from four to eight, garnet copies
  38% slower at six). Linear scaling beyond four checkers is not available
  on this machine for any implementation.
- **The workload.** Each checker type-checks what it needs of other files
  for itself (tsc-ts's design, the same in scriptc and on Node), and the
  schedule balances files, not work. garnet runs tsc-ts unmodified, so this
  part of the curve is fixed by tsc-ts.
- **The runtime**, which garnet controls: serial phases (A's repeated parse
  and bind; B's publication), per-thread overheads (allocation, collection:
  garnet's isolates collect independently, with no shared pauses), memory
  traffic (A multiplies the program by N; B shares it), contention on
  shared tables (none in A; B's published graphs are read-only).

So the reachable goal is scriptc's curve or better up to four checkers:
B removes the serial and memory costs A adds; garnet's per-isolate heaps
and collectors might scale at least as well as scriptc's reference
counting (published graphs are immortal in both).

## The accessor: thread-local storage reconsidered

Every per-isolate variable (the runtime's 307 mutable symbols, the
program's 16,561 site caches, `GLOBALS`, `CLASS_PROTO`, `OBJECT_PROTO`) is
reached through `TS_ISO()`. The experiment (`TS_ISO_MODE` in `ts_rt.h`,
`TSAOT_ISOLATE=1` in the emitter) moved the generated code's state and
the ten runtime variables `ts_rt.h` exposes; the rest of the runtime kept
its globals. A/B against the plain build, eight pairs each:

| `TS_ISO()` | tsc-ts wall | cycles | instructions | compiler wall | cycles | instructions |
|---|---|---|---|---|---|---|
| 1: `__thread` pointer (Darwin's TLV thunk) | 1.059 | 1.059 | 1.093 | 1.060 | 1.055 | 1.088 |
| 2: stack-aligned isolate block | 1.014 | 1.011 | 1.001 | 0.985 | 0.984 | 0.993 |
| 3: thread-specific data read directly, first version | 1.039 | 1.039 | 1.051 | 1.027 | 1.026 | 1.047 |
| 3: the same as one pure asm, the key a constant | 1.011 | 1.017 | 1.027 | 0.989 | 0.996 | 1.020 |
| 3 against 2 | 1.000 | 1.000 | 1.026 | 1.003 | 1.010 | 1.027 |

- **1** pays Darwin's TLV thunk once per function and reloads the pointer
  after every call (a mutable variable): 6% before the runtime's own state
  moves, so more after.
- **2** masks the stack pointer: two instructions, no load. The isolate
  runs on a stack aligned to its size (64 MiB in the experiment) whose
  lowest pages hold the isolate block; the runtime's `main` starts the
  program's on such a stack.
- **3** reads the thread's slot array from `tpidrro_el0` and a pthread
  key's slot (the technique Go's runtime uses for its thread pointer on
  darwin/arm64): `mrs`, `and`, `ldr`. Written as plain C, the key and the
  slot are loads the compiler repeats after every call (3-4%); as one asm
  without memory operands and with the key declared `const` to the
  generated code, the compiler computes the isolate once per function,
  like 2's mask. Cycles then match 2; 2.6% more instructions.

| | 2: stack-aligned block | 3: thread-specific data, direct |
|---|---|---|
| cost (cycles) | baseline | same |
| instructions | baseline | +2.6% |
| stack | fixed size per isolate, aligned (address space reserved twice) | any |
| threads that may run JavaScript | only runtime-created, on aligned stacks | any thread with its slot set |
| main | runs on a second thread (a trampoline) | runs where it is |
| signal handlers, debuggers, profilers, ASan | no runtime calls off the stack; otherwise fine | fine |
| future stackful coroutines or fibers | each stack aligned, the block copied or pointed to | nothing |
| portability | any OS | Darwin: relies on the slot array layout (stable for years, not documented); Linux: the standard initial-exec TLS (`mrs tpidr_el0` and an offset) |

So thread-local storage, read directly, costs what the stack-aligned block
costs and keeps none of its constraints. Its risk is the undocumented TSD
layout on Darwin; `TS_ISO()` is one inline function, so the block remains
a build-time fallback if a Darwin release ever changed it.

## Options

1. **Single-thread performance** (parse, bind, check, emit against
   scriptc's), the one lever that moves garnet's whole curve, threads or
   not. Needed in every path that beats scriptc.
2. **A1, isolates on one thread** (behavior-invariant): the runtime's 307
   mutable symbols and the program's state behind `TS_ISO()`. Needed by A
   and B alike.
3. **A2-A4** (workers, messages, atomics, tsc-ts's Node path): about 1.5x
   on its own; every piece is reused by B.
4. **B** (published graphs): where scriptc's scaling comes from; the open
   design items in `docs/threads_design.md` (an allocation-free commit,
   payload ownership, writes on read paths, immortal liveness, store
   guards, prototypes) must be settled first.

Proposed: decide the accessor (3, thread-specific data read directly,
the block as fallback); take single-thread performance as the primary
track toward the goal; build A1 as the shared foundation; finish B's
design before A2-A4, so the work goes where the scaling is.

## Appendix: methods

- Node and scriptc scaling: `scale.py` (rounds interleaved over the checker
  counts, every output compared with one checker's on Node), the Node
  build `packages/tsc-ts/dist-node/tsc-ts/src/main.js` and scriptc's
  `packages/tsc-ts/dist/tsc` of the tsc-ts checkout, `TSC_TS_LIB_DIR` set to
  scriptc's TypeScript lib files.
- garnet's concurrency: `concurrent.py` (N whole compiles started at once,
  their `--extendedDiagnostics` phases averaged).
- Accessors: the units builds of `build_tsc_ts_native.sh` and
  `build_typescript_native.sh` with `TSAOT_ISOLATE=1` and `-DTS_ISO_MODE=n`
  in `TSAOT_HOST_CC` and `TSAOT_NATIVE_CC`; A/B by paired ABBA runs
  (eight pairs, outputs identical).
- The projections use the measured phase times and speedups; they leave
  out worker startup (module initialization per isolate) and publication's
  cost, neither measured yet.
