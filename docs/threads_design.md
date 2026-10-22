# Threads: isolated workers first, published graphs later

Session 352. Status: design v3, after three reviews by Codex (gpt-6.1-sol,
xhigh effort; every claim that could be checked against the code was
checked); the accessor measured (the stack-aligned block, below). Runtime (`ts_rt.c`, `ts_rt.h`), emitter
(`emit_c.rs`), exporter (`class_extract.ts`), regexp adapter, tsc-ts host
and shims (`benchmarks/tsc_ts_native`).

## Why

tsc-ts (`docs/tsc_ts_native_design.md`) can check and emit on several
threads. On the TypeScript 6.0.3 compiler project garnet's tsc-ts takes
1.73 s on one thread (`--extendedDiagnostics`: parse 0.260 s, bind 0.098 s,
check 0.825 s, emit 0.534 s; peak memory 812 MB); scriptc's binary takes
1.02 s on one thread and 0.48 s on its threads, which share the bound
program through `@scriptc/threads`.

## Two milestones

- **A, isolated workers** (Node's model): `node:worker_threads` with
  structured-clone messages, `SharedArrayBuffer` and `Atomics`, every worker
  an independent isolate. tsc-ts runs its existing Node path
  (`sharesPublishedGraphs` false, `--checkers N`).
- **B, published graphs** (scriptc's model), later: `@scriptc/threads`'
  `publish`, so workers share the parsed and bound program instead of
  rebuilding it, and parse threads become possible.

A comes first (the third review agreed): it removes every
publication-specific problem the first two reviews found, and it builds
what B needs anyway (isolates, workers, messages, atomics).

## What tsc-ts's Node path does

(Verified against tsc-ts's source; paths under `packages/tsc-ts/src`.)

- `--checkers N` selects N checkers in all (default one when graphs are not
  shared; capped at 256, `compiler/parallel-check.ts`). Main is checker 0
  and starts N-1 workers, each `new Worker(new URL(import.meta.url),
  { workerData })` (`main.ts`): a worker re-runs the program's entry, every
  module initializer included, and dispatches on `workerData.kind`
  (`compiler/thread-entry.ts`).
- Main parses and binds its program first, then schedules and starts the
  workers, then checks while they start. A worker rebuilds the program from
  the command line (`drivers/node-system.ts`, `executeCommandLine`), binds
  every file (`compiler/program-checker.ts`), and does not recurse into the
  parallel compiler.
- Every checker claims files from a schedule in a `SharedArrayBuffer`
  (`Atomics.compareExchange` cursor, two spin locks, work stealing, groups
  of files sharing costly declarations) and emits each file right after
  checking it, writing it itself (under `noEmitOnError` workers hold the
  text for main). Checkers therefore write output files concurrently
  through their own `SystemWriter`s.
- A worker posts one result when it ends: cloned objects (results are
  packed only when graphs are shared), which main revives into diagnostics
  and emit results against its own program.
- Needed from the platform: cloning of primitives, strings, arrays and
  class instances' own enumerable fields (they arrive as plain objects);
  `Int32Array` views on `SharedArrayBuffer`s; `Atomics` `add`,
  `compareExchange`, `or`, `load`, `store`; `parentPort` (`postMessage`,
  `on('message')`, `close`); on a `Worker`, `postMessage`, `on('message')`,
  `on('error')`; `node:os` `availableParallelism()` and `totalmem()`. Not
  needed: transfer lists, `MessageChannel`, `structuredClone`,
  `terminate`, `Atomics.wait`/`notify`.
- garnet's shims today (`benchmarks/tsc_ts_native/garnet`): `Worker`
  throws, `isMainThread` is true, `availableParallelism()` is 1, and the
  entry (`garnet/main.ts`) always runs the main path; it needs the
  `isMainThread` branch.

**Estimate.** Main's parse and bind (P = 0.36 s) precede the workers', which
precede their checking; with the divisible check and emit work W = 1.36 s,
an idealized T = P + P + (W - P) / N is 0.97 s at four checkers and 0.85 s
at eight (about 1.8-2x), before duplicated lazy cross-file checking, worker
startup (module initialization per isolate), bandwidth, cache and allocator
contention. Memory: N parsed and bound programs plus each checker's
caches; 812 MB per checker as a stress budget (3.3 GB at four, 6.5 GB at
eight). B removes the repeated P and the copies.

**Measured proxies** (Session 352, Apple M5: four performance and six
efficiency cores; the TypeScript 6.0.3 compiler project; medians of three,
outputs identical to one checker's):

| checkers | Node, the Node path | scriptc, shared graphs (B) | garnet copies at once |
|---|---|---|---|
| 1 | 3.27 s, 821 MB | 1.05 s, 403 MB | 1.75 s each |
| 2 | 2.75 s (x1.19), 1.3 GB | 0.56 s (x1.88), 434 MB | 1.83 s each |
| 4 | 3.05 s (x1.07), 2.2 GB | 0.43 s (x2.44), 472 MB | 1.99 s each |
| 6 | 3.52 s (x0.93), 3.0 GB | 0.46 s (x2.28), 484 MB | 2.42 s each |
| 8 | 4.20 s (x0.78), 4.0 GB | 0.47 s (x2.23), 509 MB | |

Node's Node path barely scales: every worker starts cold and JIT-compiles
tsc-ts again, with V8's helper threads competing for the cores (user time
6.6 s at one checker, 18.8 s at four), costs garnet's native workers do not
pay. scriptc runs only the shared path natively (built with
`sharesPublishedGraphs` forced false, its typed message decoding rejects
the Node path's plain results: "expected CheckerResult at $.result"). The
last column runs whole one-thread compiles of garnet's tsc-ts side by side:
concurrency alone costs 4% at two, 14% at four, 38% at six (the efficiency
cores). With garnet's phases (parse and bind P = 0.36 s, check and emit
1.38 s) and that slowdown s, T = P + P s + (W - P) s / N gives 1.27 s at
two checkers and 1.06 s at four (1.65x); with scriptc's effective
parallelism for the divisible work instead (duplicated cross-file checking
included), 1.28 s and 1.19 s (1.47x). So A should bring about 1.5x at four
checkers for about four times the memory; B's sharing is where scriptc's
2.4x comes from.

## Milestone A: isolated workers

### Per isolate: everything mutable

Each worker is a complete runtime instance on its own OS thread. Per
isolate (from the survey of the runtime and the generated code; the third
review added the generated storage, function-local statics and the
adapters):

- the heap and collector: pacing, the cage and its block table, cursors,
  work lists, young log, survivors, remembered set, mark stacks;
- roots: `g_roots`, `g_static_roots`, `g_ts_frame_top`, the registered
  stack range;
- exceptions (`g_handlers`, `g_exception`), the event loop, the inbox;
- the object model's tables: shapes and transitions, the field intern
  table, symbols (`g_next_sym_id`, `g_sym_value`, the registry), the class
  registry and every cache keyed by a prototype, with their epochs. No
  object ever crosses isolates, so ids may diverge between them;
- prototypes and builtin singletons, with the `rooted` flag of each lazy
  slot (function-local statics move with their slots);
- in the generated code: the site inline caches (16,561 in tsc-ts, 80
  bytes each), `GLOBALS`, `CLASS_PROTO`, `OBJECT_PROTO`, the literal
  layouts' lazily computed shapes, the lazily interned key ids;
- the regexp adapter's pattern lists, literal caches, interned keys and
  inline caches; JSON's chunk pool; `g_inspect_color`; `Math.random`'s
  state (an isolate PRNG instead of libc `rand`); the host's `g_last_errno`
  and clock and argument state; lazy environment caches such as
  `g0_fates_on`; the allocation-site feedback; `g_typed_slow`,
  `g_has_proxies`, `g_closed_receivers`, `g_class_relinked`.

### Shared

- Code and constant tables (`FN_TABLE`, `FN_ARITY`, `CLASS_INDEX_TAB`,
  vtables, `CLASS_FIELDS_N`, `FIELD_NAME_N`).
- Flat static string literals (`TS_STRLIT_N`), only when verified flat
  leaves and fully initialized (hashes) before the first worker starts.
  Today the collector writes the mark byte of every NONHEAP cell it reaches
  (`gc_mark_visit_slow`) and clears it afterwards: it must skip these
  cells without touching their headers. NONHEAP cells in general are not
  skipped: stack cells hold heap references. The runtime's `typeof` cells
  are written at startup and become process-initialized.
- `SharedArrayBuffer` backing stores and the inboxes.
- Process resources: the working directory, the environment, file
  descriptors, stdio (records may interleave), mimalloc (already
  thread-aware; its storage must outlive queued buffers), curl's global
  initialization (once; easy and multi handles stay per isolate).

### Reaching isolate state

Two candidates, the isolate pointer loaded once per function that needs it
and kept in a local: `benchmarks/threads/isolate_access.c` measures one
frame push and pop at 0.45 ns through a plain global (today), 1.1 ns
through a `__thread` pointer (Darwin's TLV thunk), 0.45 ns through an
isolate block at the base of a stack aligned to its size (the stack pointer
masked). v3 planned thread-local storage first, with the stack-aligned
block as the fallback (its policies: no JavaScript on alternate signal
stacks or foreign threads, guard pages and stack probing, ASan's fake
stacks, debuggers and profilers); the whole-program measurement chose the
block.

**Measured: the stack-aligned block** (Session 352, the accessor
experiment: `TS_ISO_MODE` in the runtime, `TSAOT_ISOLATE=1` in the
emitter). The generated code's per-isolate state, the site caches (16,561
in tsc-ts, moved into one table per isolate), `GLOBALS`, `CLASS_PROTO` and
`OBJECT_PROTO`, and the ten runtime variables it reads through `ts_rt.h`
(the frame stack's top, the environment register, the shape and probe
tables, four guard flags) were reached through `TS_ISO()`; the rest of the
runtime kept its globals. A/B against the plain builds (units, ThinLTO),
eight pairs each, outputs identical:

| `TS_ISO()` | tsc-ts wall | cycles | instructions | compiler wall | cycles | instructions |
|---|---|---|---|---|---|---|
| a thread-local isolate pointer | 1.059 | 1.059 | 1.093 | 1.060 | 1.055 | 1.088 |
| the stack-aligned isolate block | 1.014 | 1.011 | 1.001 | 0.985 | 0.984 | 0.993 |

The thread-local form costs 6% before the runtime's own state moves (a
lower bound: every runtime function touching isolate state would add a
TLV access); the stack-aligned block costs nothing measurable. A uses the
stack-aligned block: every isolate, main's included, runs on a stack
aligned to its size (64 MiB in the experiment) whose lowest pages hold the
isolate block, a guard page between it and the stack; the runtime's `main`
starts the program's on such a stack (`ts_iso_user_main`). Its policies
become rules of A: no JavaScript or runtime call on another stack (signal
handlers stay out of the runtime, no foreign threads call in), stack
probing for frames larger than the guard page (Darwin probes them with
`___chkstk_darwin`), ASan's fake stacks leave the stack pointer on the real
stack.

The threaded forms are selected per program at build time when it can
construct a `Worker` (tsc-ts's entry imports `node:worker_threads`, so it
always builds threaded); a program without workers keeps today's C and
runtime. All translation units of a program get the same selection.

### Initialization

**Process** setup runs once, before any worker: constant tables, the
static string literals' hashes, the `typeof` cells, curl's global
initialization, the configuration. **Isolate** setup runs per isolate: the
field table (`ts_init_fields` resets tables and also initializes the
`typeof` strings: split), the class index's reverse table (rebuilt by
class registration), well-known symbols (they allocate rooted cells), the
prototypes and builtin singletons, the module initialization.

### The collector

Unchanged per isolate, with two fixes: the proximity test for stack cells
(`gc_direct_stack_plausible`, 128 MB from the collector's frame) becomes a
test against the isolate's registered stack range (worker stacks are
large; ASan's fake stacks need their own registration), and the shared
static literals are skipped as above. Each isolate's cage reserves 64 GiB
of address space plus about 544 MiB of metadata (not resident; reservation
falls back to smaller sizes): an exiting worker must unmap its cage and
release its external resources, which no path does today, and isolate
teardown must be separated from process-wide `atexit` callbacks.

### Workers and messages

- `new Worker(url, { workerData })` starts an OS thread with a large stack
  (tsc-ts's -O0 build overflows 8 MB) running a fresh isolate.
- `postMessage` serializes synchronously on the sender's thread into an
  owned buffer: cycles and aliases preserved; primitives, strings
  (lossless), arrays, plain objects and class instances (their own
  enumerable fields, delivered as plain objects), typed arrays copied with
  their offsets, a `SharedArrayBuffer` as a counted reference to its
  backing store. Property names travel as strings and are interned by the
  receiver. No sender-heap reference is ever queued. Messages are FIFO per
  sender; the receiver decodes on its own thread with its temporaries
  rooted; a port buffers messages until a `message` listener is attached.
- Decoded values are foreign receivers: plain objects where the code reads
  class-typed parameters (tsc-ts's revival does). The closed-receivers proof
  (`docs/closed_receivers_design.md`) treats a received message or
  `workerData` as a source of foreign receivers, so such programs keep their
  receiver guards.
- Lifetime: main's event loop stays alive while a started worker is alive
  and delivers its `message` and `error` events; a worker whose entry
  returns with nothing referenced (no listener) ends naturally after its
  last post is queued, as tsc-ts's checkers do. An outer exception
  boundary turns an uncaught exception in a worker's initialization or
  event dispatch into an `error` event on its `Worker` (today an uncaught
  exception aborts the process); early errors are buffered until a
  listener is attached. `process.exit` in a worker ends that worker; on
  main it ends the process.

### SharedArrayBuffer and Atomics

`Atomics` operations on `Int32Array` views become real, sequentially
consistent atomic operations (`compareExchange` a compare-and-swap; today
they are plain read-modify-write sequences): tsc-ts's scheduler needs them
from the first parallel run. Backing stores live outside the cage with an
atomic reference count held by every `SharedArrayBuffer` cell, every queued
message and every `workerData` that carries one, released on failed
construction or decode and on discarded queues; finalization drops a count
instead of freeing. General shared-memory correctness (ordinary element
reads and writes on shared views as relaxed atomics, mixed widths,
overlapping `set` with snapshot semantics, byte consumers such as
`TextEncoder.encodeInto`) needs a shared-access path through the emitted
and runtime element accesses; until then ordinary accesses to shared
memory are documented as unsupported races (tsc-ts only reads schedule
words that a message or an atomic operation published).

### Slices of A

1. **Isolates on one thread** (behavior-invariant): every item under "Per
   isolate" behind the isolate pointer (the stack-aligned block), the process and
   isolate setup split, registered stack ranges, the shared literals
   skipped by the collector. Gates: everything as for a runtime change, an
   A/B of the threaded build against the plain one on tsc-ts (the
   whole-program cost of the accessor), then two isolates run one after the
   other in one process, then two isolates allocating and collecting at
   once (shared literals untouched), under ThreadSanitizer.
2. **Workers and messages**: threads, the structured clone, inboxes, the
   event loop's waiting and lifetime rules, `error` events, worker
   `process.exit`, cage teardown. Gates: deterministic worker fixtures
   checked against Node (handshakes, not sleeps): class instances round
   trip as plain objects, cycles and aliases, typed-array offsets,
   initialization errors, a sender that exits before delivery; GC stress in
   several isolates at once; ThreadSanitizer.
3. **`SharedArrayBuffer` and `Atomics`** (Int32 first): scheduler-style
   contention (compare-and-swap cursors, spin locks), visibility through
   messages, finalization with queued references.
4. **tsc-ts on its threads**: the entry's dispatch, the host's per-thread
   state and concurrent output writes (directory creation races);
   diagnostics and emitted files compared at N = 1, 2, 4, 8 (also
   `noEmitOnError`, failures, recycling); wall time and RSS measured
   against one thread and against scriptc.

Gates from slice 1 on: a ThreadSanitizer build (`-fsanitize=thread`: the
Rust-emitted C, the runtime, the host and the adapters) as a new gate
(`scripts/tsan_one.sh` is the TypeScript-analyzer debug script, not this),
ASan as a separate run, and the existing gates for every single-threaded
program.

## Milestone B: published graphs (later)

After A is measured. v2 of this design (Session 352) worked out
publication in place: a validate, prepare and commit transaction; a new
IMMORTAL generation that no collector marks, sweeps or remembers; payloads
relocated into process-owned immortal storage; precomputed metadata so
that no read writes a published cell; prototype descriptors (a class
index, a builtin id or null) read by every prototype consumer; store
guards on the classes a program may publish; `publish` arguments escaping
globally. The second review left these open, to resolve before B starts:

- **Transaction**: commit must not allocate (payload destinations and
  ownership records reserved in prepare, which allocates: flattening,
  iteration orders); rooted staging; cleanup on failure; already-immortal
  subgraphs terminal in all three phases (tsc-ts republishes received
  programs).
- **Payload ownership**: `gc_owned_alloc`, `gc_owned_realloc` and
  `gc_owned_free` treat unknown generations as young and outside-cage
  storage with `realloc`/`free`: reject growth of published owners; large
  payload runs, `prop_index`, sparse tables, the hole-filled `[len, cap)`
  region (inline reads bound by capacity); retained cell blocks owned by
  the process.
- **Writes on read paths**: sparse arrays densify on read; array length
  assignment, prototype setters, repeated seal and preventExtensions;
  mutators that call back into JavaScript (`sort`) and resume storing after
  a callback published the receiver.
- **IMMORTAL liveness**: weak values as well as keys (an unmarked immortal
  value would keep the ephemeron loop running forever); the full audit of
  generation tests, both sweep forms, accounting and debug liveness;
  process-level recognition of foreign immortal cells; barrier tests kept
  strict.
- **Store guards**: a sound closure over subclasses, aliases, `{}`,
  `object`, `unknown`, type parameters, recursion and analysis failures, or
  guards on every class; literal-slot stores; `publish` as an intrinsic the
  escape analysis sees before summaries are computed.
- **Prototypes**: the consumer inventory beyond `o->proto` reads and
  `class_reg_for` (`class_field_lookup` and its cache, location caches,
  generated receiver guards and `instanceof` shortcuts, JSON, inspect and
  spread enumeration, for-in); class identity distinct from the current
  prototype; Error objects are ordinary objects too.
- **Shared tables**: the acquire operation for every reader (directories,
  literal layouts, field-name arrays and counts, shape descriptors).
- **Capabilities**: publication tracked separately from workers.

## Review history

- Round 1 (v1): sixteen findings, six blocking: payloads of immortal cells
  lost at full collections, the IMMORTAL generation's reach, prototype
  substitution, reads that write, escape and store guards, shared-table
  concurrency. Answered by v2.
- Round 2 (v2): five findings settled; publication still not a
  failure-free transaction, payload ownership, writes on read paths,
  IMMORTAL liveness, store-guard closure. Listed under milestone B.
- Round 3: milestone A first; its blocking items (shared static literals
  written by the collector, isolation of generated and function-local
  statics, real atomics for the scheduler) and the corrected estimate are
  above.
