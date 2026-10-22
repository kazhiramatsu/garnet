# Threads: what beating scriptc takes, a decision review

Session 352. Kaz asked for this review before committing to the threads
plan (`docs/threads_design.md`): the goal is to beat scriptc's tsc-ts, and
the time should fall linearly with the number of checkers. Kaz also asked
to reconsider thread-local storage, which the first accessor experiment
had rejected. A first version of this document was reviewed independently
(Fable 5.1, Session 352); the review's findings are folded in below and
summarized at the end.

All numbers: Apple M5 (four performance and six efficiency cores, 32 GB),
the TypeScript 6.0.3 compiler project (`-p src/compiler/tsconfig.json`, no
declarations or source maps, as `scripts/build_tsc_ts_native.sh`'s
benchmark runs it), medians of three runs or of eight A/B pairs, outputs
compared byte for byte (identical everywhere). Timelines are tsc-ts's own
(`TSC_TS_TIMELINE=1`, milliseconds from the start of the process).

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

tsc-ts's timeline, one checker (`--extendedDiagnostics` agrees):

| phase | garnet | scriptc | garnet / scriptc |
|---|---|---|---|
| startup (to the entry's first statement) | 23.5 ms | 1.5 ms | 15x |
| parse (the loader's walk) | 252 ms | 92 ms | 2.7x |
| bind (to the syntactic diagnostics) | 99 ms | 25 ms | 3.9x |
| check (to the semantic diagnostics) | 804 ms | 513 ms | 1.57x |
| emit and report | 528 ms | 375 ms | 1.41x |
| total | 1.72 s | 1.01 s | 1.7x |

Peak memory: garnet 737 MB, scriptc 403 MB. garnet's startup is the
runtime's setup and the module initializer (`--version`: 20 ms, 334 M
instructions; scriptc's 33-58 M).

### Scaling with checkers

| checkers | scriptc, shared graphs | tsc-ts on Node (the Node path) |
|---|---|---|
| 1 | 1.05 s, 403 MB | 3.27 s, 821 MB |
| 2 | 0.56 s (x1.88), 434 MB | 2.75 s (x1.19), 1.3 GB |
| 4 | 0.43 s (x2.44), 472 MB | 3.05 s (x1.07), 2.2 GB |
| 6 | 0.46 s (x2.28), 484 MB | 3.52 s (x0.93), 3.0 GB |
| 8 | 0.47 s (x2.23), 509 MB | 4.20 s (x0.78), 4.0 GB |

The Node path (every worker rebuilds its own program, results come back
as cloned plain objects) scales badly on Node for two reasons: each worker
rebuilds the program (about 0.9 s of its 3.3 s), and each starts cold and
JIT-compiles tsc-ts again while V8's helper threads compete for the cores
(user time 6.6 s at one checker, 18.8 s at four). garnet's native workers
would pay the first and not the second. scriptc cannot run the Node path:
built with `sharesPublishedGraphs` forced false, its typed message
decoding rejects the plain results ("expected CheckerResult at
$.result").

### What bounds scriptc's time: one file

scriptc's timeline at four checkers (`scale/timeline4.txt`):

- 9-60 ms: parse with **10 threads** (`parseThreads` is
  `max(checkers, availableParallelism)`, `parallel-check.ts:459`), 249
  files in 136 chunks; each parse thread also **binds** its files
  (`p7 chunk ... parse 4.6 bind 1.4`) and publishes each chunk
  (`published 0.0-1.2ms`). The longest chunk is `checker.ts`: 42 ms (parse
  32, bind 7).
- 60-63 ms: the program built, the globals merged (1.4 ms), the program
  **published in 0.07 ms** (`libraries verified` 62.59, `program published`
  62.66): publication costs nothing measurable.
- 63 ms: four checkers spawned; the main thread does not check
  (`mainThreadChecks` is false when graphs are shared).
- c1, c2, c3 finish at 309-312 ms with 19, 27 and 31 files.
- **c0 finishes at 439.6 ms with one file**: `src/compiler/checker.ts`
  (3,151,772 bytes, 64% of the project's text), check 217 ms, emit 159 ms.
  The process exits at 439.7 ms.

At eight checkers the picture is the same: c1-c7 finish at 205-211 ms with
8-15 files each; c0 finishes at 452.9 ms with `checker.ts` alone (check
256 ms, emit 151 ms). So scriptc's time from three checkers on is

    startup + parse(checker.ts) + check(checker.ts) + emit(checker.ts)

about 0.43-0.45 s, and the other threads idle for half of it. The curve is
flat beyond four not because of the efficiency cores (the first version of
this document said so) but because tsc-ts schedules whole files and
cannot split the largest one. tsgo has the same structure. garnet runs
tsc-ts unmodified, so this floor is garnet's too, at garnet's speed.

How garnet's code behaves under concurrency, measured with whole
one-thread compiles running side by side (a proxy for A's N programs in
one process and for memory bandwidth, caches and the collectors):

| copies at once | each copy | parse and bind | check and emit |
|---|---|---|---|
| 1 | 1.75 s | 0.36 s | 1.38 s |
| 2 | 1.83 s | 0.37 s | 1.45 s |
| 4 | 1.99 s | 0.40 s | 1.60 s |
| 6 | 2.42 s | 0.46 s | 1.95 s |

Concurrency alone costs 4% at two, 14% at four, 38% at six (two of the six
on efficiency cores).

## What beating scriptc takes

The model is a floor and a share: the time is the larger of the critical
path (the largest file, on one thread) and the rest of the work divided
among the checkers, after the serial phases.

- **A, isolated workers** (Node's model, tsc-ts's Node path): main parses
  and binds (P = 0.36 s), takes the costliest file first (`checker.ts`,
  0.56 s of check and emit at garnet's speed) while its workers rebuild the
  program (P s, s the concurrency slowdown) and then share the rest:
  main is busy until 0.92 s, the workers until
  0.36 + 0.41 + (1.36 s - 0.56) / 3 = 1.10 s. About 1.1 s at four
  checkers, for four programs in memory (3.2 GB).
- **B, published graphs** (scriptc's model): parse and bind on parse
  threads (floor: `checker.ts`, 42 ms x 2.7 = 115 ms), publication at
  scriptc's cost (nothing), then the checkers; the critical path is
  `checker.ts`: check 217 ms x 1.57 = 340 ms, emit 159 ms x 1.41 = 224 ms.
  With startup (23 ms) and the configuration (5 ms): **about 0.71 s from
  three checkers on, flat.** Two checkers: about 0.9 s (the rest of the
  work no longer fits beside the largest file).

| checkers | scriptc (measured) | garnet A | garnet B | garnet B, critical path 1.8x faster |
|---|---|---|---|---|
| 1 | 1.05 s | 1.72 s | 1.72 s | ~1.0 s |
| 2 | 0.56 s | ~1.27 s | ~0.9 s | ~0.55 s |
| 4 | 0.43 s | ~1.1 s | ~0.71 s | ~0.41 s |
| 8 | 0.47 s | ~1.0 s | ~0.71 s | ~0.41 s |

Conclusions:

- A alone gives about 1.5x at four checkers for four times the memory and
  cannot approach scriptc. Its only lasting value is what B reuses
  (isolates, workers, messages, atomics).
- B gives about 2.4x and reaches the same floor scriptc stands on, 1.6x
  later. From there, nothing but single-thread speed moves the number: the
  parse, check and emit of **one file**, `checker.ts`, 679 ms today against
  scriptc's 376 ms plus its share of a 45 ms parse. Beating scriptc's
  0.43 s needs that critical path at about 0.38 s: **1.8x faster on the
  largest file**, parse 2.7x, check 1.57x and emit 1.41x being the gaps.
  Single-thread parity is not enough: at parity garnet ties, since both
  idle their other threads.
- Startup is 5% of the target (23 ms against 1.5 ms) and is paid again by
  every worker; a heap image of the initialized runtime and modules would
  remove most of it.

## Linear scaling

On this project, linear scaling with checkers is not available to any
implementation beyond three checkers: `checker.ts` is 64% of the source
and tsc-ts checks and emits a file on one thread. scriptc's 2.44x at four
is the floor reached at three. The requirement therefore splits:

- **The critical path**: one file's parse, check and emit on one thread,
  where garnet is 1.4-2.7x behind. This is where the compiler project is
  decided.
- **Parallel efficiency**: measurable only on a project whose files are of
  similar size and whose work divides. A second benchmark is needed for it
  (tsc-ts's own sources, 11 MB in many files, or another large multi-file
  project). There the limits are tsc-ts's duplicated cross-file resolution
  (each checker resolves what its files need, so the sum of the checkers'
  work exceeds one thread's: 1.12 s against 0.99 s at four checkers in
  scriptc's timeline, 13%), the serial phases (A's repeated parse and bind;
  B's publication, which must therefore cost nothing, see below), memory
  traffic and the collectors (per isolate in garnet, independent; shared
  immortal graphs are never marked), and the efficiency cores (garnet's
  copies gain 23% in throughput from four to six, scriptc nothing, so the
  granularity of the schedule may matter there).

Reaching scriptc's curve on such a project needs B; exceeding it would
come from a cheaper publication, independent collectors and finer use of
the efficiency cores, none of which is guaranteed.

## Publication

scriptc publishes each parsed chunk in 0-1.2 ms and the whole program in
0.07 ms, and exposes a `TSC_TS_REGION` switch: its graphs are made
immutable by region, not by a walk. `docs/threads_design.md`'s B design
(a validate, prepare and commit transaction that walks the graph, relocates
payloads and marks every cell immortal) would be a serial walk over 400 MB
on the critical path, tens to hundreds of milliseconds where the whole
budget is 430 ms. B's publication has to be region-based (parse threads
allocate into regions that change owner wholesale) or delegated to the
operating system (the fork alternative below).

## The accessor: thread-local storage reconsidered

Every per-isolate variable (the runtime's 307 mutable symbols, the
program's 16,561 site caches, `GLOBALS`, `CLASS_PROTO`, `OBJECT_PROTO`) is
reached through `TS_ISO()`. The experiment (`TS_ISO_MODE` in `ts_rt.h`,
`TSAOT_ISOLATE=1` in the emitter) moved the generated code's state and
the ten runtime variables `ts_rt.h` exposes; the rest of the runtime kept
its globals, so every row below is a lower bound of the final cost (the
runtime's functions will each compute the isolate once more). A/B against
the plain build, eight pairs each:

| `TS_ISO()` | tsc-ts wall | cycles | instructions | compiler wall | cycles | instructions |
|---|---|---|---|---|---|---|
| 1: `__thread` pointer (Darwin's TLV thunk) | 1.059 | 1.059 | 1.093 | 1.060 | 1.055 | 1.088 |
| 2: stack-aligned isolate block | 1.014 | 1.011 | 1.001 | 0.985 | 0.984 | 0.993 |
| 3: thread-specific data read directly, first version | 1.039 | 1.039 | 1.051 | 1.027 | 1.026 | 1.047 |
| 3: the same as one pure asm, the key a constant | 1.011 | 1.017 | 1.027 | 0.989 | 0.996 | 1.020 |
| 3 against 2 | 1.000 | 1.000 | 1.026 | 1.003 | 1.010 | 1.027 |

- **1** pays Darwin's TLV thunk once per function and reloads the pointer
  after every call (a mutable variable): 6% before the runtime's own state
  moves.
- **2** masks the stack pointer: two instructions, no load. The isolate
  runs on a stack aligned to its size (64 MiB in the experiment) whose
  lowest pages hold the isolate block; the runtime's `main` starts the
  program's on such a stack.
- **3** reads the thread's slot array from `tpidrro_el0` and a pthread
  key's slot (the technique Go's runtime uses for its thread pointer on
  darwin/arm64, and Apple's own libraries for their slots): `mrs`, `and`,
  `ldr`. Written as plain C, the key and the slot are loads the compiler
  repeats after every call (3-4%); as one asm without memory operands and
  with the key `const`, the compiler computes the isolate once per
  function, like 2's mask. Against 2: the same cycles on tsc-ts, 1% more on
  the compiler, 2.6% more instructions on both. Differences of a percent
  or so are code layout here: 2 measured 1.5% *faster* than the plain
  build on the compiler, which no accessor can be.

Two defects of the experiment's version of 3, found in review and fixed
in the committed code: the key was declared `const` to the generated code
and non-`const` to the runtime, incompatible declarations of one object
(undefined behavior in C, and a hazard the moment the runtime joins the
link-time optimization); it is now a word defined in assembly, declared
`const` everywhere, written once by a constructor through the assembler's
name and verified against `pthread_getspecific`. And since the read is a
pure asm the compiler may move above any call, a thread sets its slot
(`ts_iso_enter`) in a function with no `TS_ISO()` use and runs its body in
a function not inlined into it; reading before the constructor would take
slot 0 (`pthread_self`) for the isolate.

| | 2: stack-aligned block | 3: thread-specific data, direct |
|---|---|---|
| cost | baseline | within layout noise; +2.6% instructions |
| stack | fixed size per isolate, aligned (address space reserved twice) | any |
| threads that may run JavaScript | only runtime-created, on aligned stacks | any thread after `ts_iso_enter` |
| main | runs on a second thread (a trampoline) | runs where it is |
| signal handlers, debuggers, profilers, ASan | no runtime calls off the stack; otherwise fine | fine |
| future stackful coroutines or fibers | each stack aligned, the block copied or pointed to | nothing |
| portability | any OS | Darwin arm64: the slot array's layout (libpthread's, not public API, relied on by Go and inlined into Apple's libraries; the constructor verifies it at every start); Linux: `__thread` with the local-exec model costs the same without it |

**Decision: 3**, with 2 kept as the build-time fallback should a Darwin
release change the layout.

## Options and the plan

1. **The critical path, one thread**: `checker.ts`'s parse (2.7x), check
   (1.57x) and emit (1.41x) against scriptc's, and startup (20 ms). The
   one lever that moves the compiler project's number past the floor, and
   it moves every program.
2. **A prototype of B's sharing by `fork`**, before any migration of the
   runtime's state: the main process parses, binds and publishes, then
   forks its checkers; sharing is the operating system's copy-on-write,
   so none of B's machinery is needed (no transaction, payload ownership,
   store guards or prototype descriptors) and no isolates either (no A1,
   no accessor cost). What it needs is reused by every design: `Worker`
   over `fork`, `postMessage` as a structured clone through a pipe (garnet
   can rebuild class instances with their prototypes, which Node cannot),
   `SharedArrayBuffer` on `MAP_SHARED` memory (tsc-ts creates its schedule
   before spawning), real `Atomics`, and cells older than the fork treated
   as immortal by the child's collector (never marked: B's IMMORTAL
   generation without any validation, since everything before the fork is
   immortal by definition; a debug build can `mprotect` those pages and
   make a write loud). Measured: forking a process with 740 MB resident
   takes 0.6-0.8 ms per child, children done in 10-20 ms. Its limit is
   that sharing runs one way, parent to children: parse threads returning
   their chunks need regions mapped shared at the same address in both
   (region-based publication again); Windows has no `fork`. One to two
   weeks for the real B-shaped number of garnet's runtime (the projection
   says 0.71 s), which decides whether the threaded B, with A1's 307
   variables and a publication machinery, is worth building at all.
3. **A1, isolates on one thread**: deferred until 2 has answered.
4. **A2-A4**: workers, messages and atomics are built by 2 in another
   form; tsc-ts on the Node path (A4) is demoted from a milestone to a
   correctness test of them. 1.5x for four times the memory is not a
   target.
5. **B**: its publication redesigned as regions (or `fork`); the other
   open items in `docs/threads_design.md` stand.

So: fix the documents and the accessor (done with this revision), then 2,
with 1 as the standing track alongside, and a second benchmark project for
parallel efficiency.

## Review summary

Findings of the independent review, in the order they changed this
document: the flat curve beyond four checkers is `checker.ts`, not the
efficiency cores; beating scriptc needs 1.8x on the critical path, not
parity; B's publication must be region-based; the first accessor version's
`const` lie and the thread-start hazard; scriptc parses and binds on ten
threads and publishes per chunk; the accessor table's "same cycles" is
within layout noise and a lower bound; startup is 23 ms against 1.5 ms;
the `fork` alternative. The numbers of the first version (A 1.1 s, B
0.7 s) stood.

## Appendix: methods

- Node and scriptc scaling: `scale.py` (rounds interleaved over the checker
  counts, every output compared with one checker's on Node), the Node
  build `packages/tsc-ts/dist-node/tsc-ts/src/main.js` and scriptc's
  `packages/tsc-ts/dist/tsc` of the tsc-ts checkout, `TSC_TS_LIB_DIR` set to
  scriptc's TypeScript lib files.
- Timelines: `TSC_TS_TIMELINE=1` on scriptc's binary at one, four and
  eight checkers and on garnet's at one (`scale/timeline*.txt`).
- garnet's concurrency: `concurrent.py` (N whole compiles started at once,
  their `--extendedDiagnostics` phases averaged).
- Accessors: the units builds of `build_tsc_ts_native.sh` and
  `build_typescript_native.sh` with `TSAOT_ISOLATE=1` and `-DTS_ISO_MODE=n`
  in `TSAOT_HOST_CC` and `TSAOT_NATIVE_CC`; A/B by paired ABBA runs
  (eight pairs, outputs identical).
- `fork`: `review/forktime.c`, a process with 740 MB (and 1.5 GB) resident
  forking four children that touch 1% of the pages.
- The projections use the measured phase times and ratios; they leave out
  worker startup beyond the 23 ms measured and assume scriptc's
  publication cost for B.
