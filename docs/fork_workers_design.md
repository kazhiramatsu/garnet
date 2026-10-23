# Workers by fork: a prototype of shared checkers

Session 352, design. The threads review (`docs/threads_scaling_review.md`)
projects garnet's tsc-ts on scriptc's model (B, published graphs shared
by every checker) at about 0.71 s on the TypeScript compiler project,
against scriptc's 0.43 s, and shows that the number is bounded by one
file's parse, check and emit on one thread. Before the runtime's state
moves into isolates (A1, 307 variables) and before B's publication
machinery is built, this prototype measures that projection with the
operating system doing the sharing: the main process parses, binds and
"publishes" the program, then **forks** its checkers. A child sees the
parent's heap by copy-on-write, so tsc-ts's shared path
(`sharesPublishedGraphs` true) runs without isolates, without a
transaction, without store guards. What the prototype builds, the message
codec, shared `SharedArrayBuffer` stores, real `Atomics`, the event loop's
descriptor watches and the worker shims, is what the threaded design needs
too.

## What tsc-ts's shared path needs, and how fork gives it

(From `packages/tsc-ts/src/compiler`; verified in Session 352.)

- **Checker threads receive the program by reference** (`CheckerThreadData.program`,
  `thread-entry.ts`). In a forked child the `workerData` object is at the
  same address: nothing is copied or decoded. The child calls
  `publish(program)` (the shim's identity) and `new CheckedProgram(program)`;
  every file is already bound (`bindSourceFile` returns on `file.isBound`,
  `binder.ts:310`).
- **The schedule is a `SharedArrayBuffer`** of `Int32`s created by the main
  thread before it spawns (`newSchedule`, `parallel-check.ts:778`), read and
  written with `Atomics.load`, `store`, `add`, `or`, `compareExchange` (two
  spin locks, a work-stealing cursor). Its backing store must therefore be
  shared memory: `mmap(MAP_SHARED | MAP_ANON)`, which survives `fork`
  shared, and the operations real atomics.
- **Results are plain data.** With shared graphs tsc-ts packs each
  checker's result (`packsResults`, `parallel-check.ts:125`): a
  `PackedResult` of numbers, booleans, `string[]`, `number[]` and two
  `Int32Array`s, which the main thread unpacks (`unpackResult`) against its
  own program. So `postMessage` needs a structured clone of primitives,
  strings, arrays, plain objects and typed arrays, no class instances. (The
  Node path's `{ result: CheckerResult }` would need instances: scriptc's
  binary rejects them, "expected CheckerResult at $.result".)
- **Checkers write their own output files** (`outputWriterOfThread`,
  `drivers/node-system.ts:250`) through the host's file calls; `mkdir`
  tolerates `EEXIST` (`host.c:162`). Processes do this as well as threads.
- **The main thread waits in its event loop** for `message` and `error`
  events of each `Worker` (`parallel-check.ts:1815`), and ends the process
  from the completion callback (`main.ts`: "Watch mode and `--checkers`
  keep running until their callbacks exit"). No `terminate`, no `exit`
  event, no `Atomics.wait`.
- **Parse threads** (`parallelParse.spawn`, set by `startThreads` when
  graphs are shared) return parsed batches to the main thread: sharing
  through `fork` runs one way, parent to child, so the prototype does not
  start them (below). Parsing stays on the main thread: 0.36 s instead of
  the projected 0.14 s, to subtract when comparing with the projection.
- **Memory retirement** (`retires`, `parallel-check.ts:1002`) reads the
  process's resident set and `totalmem()`: a child's own numbers, fine.

## Design

### Runtime (`runtime/ts_rt.c`)

1. **Shared stores.** `ta_new_buffer(length, shared)` allocates a shared
   buffer's bytes with `mmap(MAP_SHARED | MAP_ANON)`, rounded to pages, and
   the finalizer unmaps them (`calloc`/`free` today, `ts_rt.c:13320`,
   `:5459`). Only `SharedArrayBuffer` changes; `ArrayBuffer` keeps its
   bytes.
2. **Atomics.** `ts_atomics_load`, `store`, `rmw`, `compare_exchange`
   (`ts_rt.c:13978-14030`) become `__atomic` operations on the element,
   sequentially consistent, for the integer element kinds; the observable
   single-thread semantics (coercions, the returned old value) do not
   change, so the conformance fixtures stay as they are.
3. **The message codec**: `ts_message_encode(tsv) -> bytes` and
   `ts_message_decode(bytes) -> tsv`. Tags for undefined, null, booleans,
   numbers, strings (code units, lossless), arrays (dense; a hole is
   undefined), plain objects (own enumerable string keys in order, names
   as strings, interned by the receiver with `ts_intern_field`), typed
   arrays (element kind and a copy of the viewed bytes; a view on a shared
   store is copied too in this version), and back references for aliases
   and cycles (a table of visited cells). Anything else, a function, a
   symbol, an accessor, a class instance (the header's class word), a Map
   or Set, a Promise, throws a `TypeError` naming the kind: a message the
   codec cannot carry is a loud failure, never a plain object delivered in
   silence. Decoding roots its temporaries; a malformed frame aborts.
4. **Forking a worker.** `ts_worker_fork(tsv worker_data) -> id`: flush
   stdio, open a pipe, `fork`. The child closes the read end, records that
   it is a worker (`workerData`, the write end), raises the full
   collection's threshold so that only young collections run
   (`g_full_threshold_bytes`: a full collection would mark every pre-fork
   cell and copy their pages), calls the registered entry function with
   `ts_call` under an exception handler, drains its event loop, flushes
   and `_exit`s (0, or 1 after an uncaught exception, whose message it
   writes to stderr). The parent closes the write end and registers a
   watch `{pid, fd, buffer, onmessage, onerror}`, its function values
   rooted.
5. **The event loop** (`ts_run_event_loop`, `ts_rt.c:17299`) keeps running
   while a watch is open and, when no microtask or I/O task is ready,
   `poll`s the watched descriptors; a complete frame (a 4-byte length and
   the bytes) is decoded and delivered through `ts_call(onmessage)`; end of
   file reaps the child (`waitpid`) and, if it exited without a result and
   with a nonzero status, delivers `onerror`. Watches are GC roots.
6. **The child's posting**: `ts_worker_post(tsv) ` encodes and writes one
   frame to the pipe (blocking writes; results are small).

### Host (`benchmarks/tsc_ts_native/host.c`)

New `__garnetHost` primitives over the runtime's functions:
`setWorkerEntry(fn)`, `forkWorker(workerData) -> id`,
`onWorkerMessage(id, fn)`, `onWorkerError(id, fn)`, `isWorker()`,
`workerData()`, `postMessage(value)` (the child), `cpus()`
(`sysctl hw.ncpu`; `availableParallelism`), and `exit` in a child becomes
`_exit` after flushing. The host stays tsc-ts's; a general
`node:worker_threads` for every program is the threaded design's.

### Shims (`benchmarks/tsc_ts_native/garnet`)

- `node_worker_threads.ts`: `isMainThread`, `workerData` and `parentPort`
  become live bindings (`export let`), set by the entry the host calls in a
  child; `Worker` forks through the host and routes `on('message')` and
  `on('error')`; `parentPort.postMessage` posts through the host; `close`
  is a no-op.
- `scriptc_threads.ts`: `sharesPublishedGraphs` true; `publish` stays the
  identity (the graph is shared by the fork and never written by a
  checker; see "Limits").
- `node_os.ts`: `availableParallelism()` from the host.
- `main.ts`: registers the worker entry (`runThread(workerData, drivers)`)
  and sets `parallelCheck.writer` and `parallelCheck.spawn` itself instead
  of calling `startThreads`, which would also install `parallelParse.spawn`
  (parse threads, not in this prototype).

### Scripts

`scripts/build_tsc_ts_native.sh` builds as today (the host and the shims
are part of it). A measurement script runs `--checkers 1, 2, 4, 8` three
times each with the outputs compared against one checker's, peak memory,
and tsc-ts's own timeline (`TSC_TS_TIMELINE=1`) for the checkers' spans:
c0's `checker.ts` span is garnet's critical path, the number the
single-thread work has to move.

## Limits, stated

- **Sharing runs one way.** A child's results are copied back through the
  pipe; parse threads cannot return their batches. Parallel parsing
  through `fork` needs the parse children to allocate into a region mapped
  shared at the same address in parent and children before the fork
  (region-based publication, the shape B's publication must take anyway),
  a possible follow-up (F4) if the checker side measures as projected.
- **A child may write pre-fork cells.** scriptc's published graphs throw on
  a write; here a write succeeds into the child's private copy of the page
  and is invisible to the parent. tsc-ts's checkers do not write the
  program (they keep thread-local tables; a write would throw in scriptc),
  and the diagnostics and outputs are compared with one checker's, which
  would show a dependence on such a write. A diagnostic mode
  (`TSAOT_FORK_PROTECT=1`) can `mprotect` the pre-fork cage pages
  read-only in the child so that any write to them faults loudly; it also
  catches the child's legitimate writes to its own copies of pre-fork
  objects (module-level caches, the remembered flags its young collections
  set), so it is a tool for finding writes, not a gate.
- **Children run young collections only.** Their heaps grow for the
  lifetime of the check (under a second, a few hundred megabytes); a full
  collection would mark the whole pre-fork heap and copy its pages. Peak
  memory is measured with this in mind.
- **No Windows.** `fork` is POSIX; macOS forks a single-threaded process
  with plain C and mimalloc without trouble (the runtime creates no
  threads; `curl` is not initialized by tsc-ts).
- **Module state is inherited, not re-run.** A Node worker starts with
  fresh module state and re-runs every module initializer; a child
  inherits the parent's. tsc-ts's checker entry sets what it needs from
  `workerData` (`reserveNodeIds`, `reserveSymbolIds`, the thread-local
  tables); anything else it assumed fresh would show in the comparison.

## Gates

- Outputs byte-identical to one checker's at 2, 4 and 8 checkers (78
  files); the same on a copy of the project with an injected type error
  (diagnostics identical, `noEmitOnError` both ways).
- GC stress in the children (`TSAOT_GC_YOUNG_THRESHOLD=1`, protect mode)
  with identical outputs.
- The codec: a fixture of messages (cycles, aliases, holes, typed arrays
  with offsets, the rejected kinds) round-tripped through a worker and
  compared with Node's `structuredClone` where Node accepts it, and
  rejected loudly where the codec does not carry it.
- Atomics: the existing conformance fixtures unchanged (single-thread
  semantics), plus a scheduler-style contention fixture (two children
  taking a shared counter with `compareExchange`, every index taken once).
- The existing gates for every single-threaded program (the runtime
  changes are behind `shared` and the worker calls).
- ASan build of the runtime and the host for one threaded run.

## What it answers, what it does not

It gives garnet's time on scriptc's model with serial parsing, the
checkers' spans per file, and the memory of N children against scriptc's
one process; subtracting the serial parse's 0.22 s gives the projection's
0.71 s to compare with. If the checkers measure as projected, the plan's
remaining questions are the critical path's single-thread speed and how to
share parsing (regions); if they measure worse, the difference is the
runtime's concurrency behavior (collectors, allocator, memory traffic) to
chase before any isolate work. It does not measure the threaded design's
accessor cost or publication; both stay as measured and designed.

## Slices

- **F1**: shared `SharedArrayBuffer` stores and real `Atomics`
  (runtime). Gates: conformance unchanged, the contention fixture through
  two forked plain C processes of a runtime test.
- **F2**: the codec, `ts_worker_fork`, the watches in the event loop, the
  host primitives. Gates: the codec fixture, a worker fixture program
  (hello, cycles, an uncaught throw in the child, a child exiting early).
- **F3**: the shims and tsc-ts on forked checkers; the measurements above;
  the review document updated with the measured B-shaped time.
- **F4** (if F3 measures as projected): parse children allocating into a
  shared region at a fixed address, the first form of region-based
  publication.

## F1-F3 as built and measured

Session 352. F1: a `SharedArrayBuffer`'s bytes are `mmap(MAP_SHARED |
MAP_ANON)` pages (`ta_new_buffer`, unmapped by the finalizer); `Atomics` on
the integer kinds are `__atomic` operations on the element's bytes
(`atomics_*_bits` in `ts_rt.c`). Runtime tests: a child's store is seen
through a shared buffer and not through an `ArrayBuffer`; four processes
claim 20,000 schedule indices with `compareExchange`, every index once;
the element conversions. F2: the codec (`msg_encode`, `msg_decode`), the
watches and `ts_worker_fork` in `ts_rt.c` ("Workers by fork"), the host's
`setWorkerEntry`, `forkWorker`, `onWorkerMessage`, `onWorkerError`,
`isWorker`, `workerData`, `postMessage`, `cpus`; `exit` in a child is
`_exit`. Runtime tests: a plain graph round-trips (a cycle, an alias, a
hole, a wide string, an `Int32Array`); a function, a Map and an object
holding a function are rejected; a forked child's two frames arrive in
order; an uncaught exception in the child reaches the error handler. F3:
the shims as designed; `main.ts` sets `parallelCheck.writer` and `spawn`
itself.

tsc-ts on the compiler project, medians of three on a quiet machine (a
first set of numbers, taken while the GC stress gate ran, was 5-20% slower
and misread as concurrency costs), outputs identical to one checker's and
to the Node reference at every count:

| checkers | wall | process-tree peak RSS (sampled) | parent's peak |
|---|---|---|---|
| 1 | 1.73 s | 727 MB | 705 MB |
| 2 | 1.14 s (x1.52) | 1135 MB | 388 MB |
| 3 | 0.94 s (x1.84) | | |
| 4 | 0.94 s (x1.84) | 1366 MB | 388 MB |
| 8 | 1.02 s (x1.70) | 1714 MB | 388 MB |

The timeline at four checkers: startup 23 ms, parse to 282 ms, bind to
395 ms, publication 1 ms, checkers spawned at 400 ms; c1-c3 finish in
375-378 ms with 20-31 files each (CPU 351 ms user, 25 ms system); c0
finishes at 982 ms with `checker.ts` alone: check 357 ms, emit 225 ms
(564 ms, CPU 539 ms user). scriptc's four checkers on the same run: c1-c3
251-254 ms, c0 392 ms (check 217, emit 159). So on a child garnet's
critical path is 1.44x scriptc's and the other checkers' work 1.49x, the
single-thread ratios (check 1.57x, emit 1.41x); concurrency costs both the
same (scriptc's c0 goes from 375 to 426 ms from four to eight checkers,
garnet's from 564 to 631). The children's CPU, 1.59 s, is 20% more than
one thread's check and emit (1.33 s); scriptc's 1.11 s is 12% more than
its one thread's. Under GC stress (a young collection every 64 allocations
in parent and children) the outputs are identical; on a copy of the
project with two injected type errors, one and four checkers report the
same diagnostics, the same as scriptc's.

Against the projection (0.71 s with parallel parsing): with serial parsing
the floor is 0.40 s + 0.58 s = 0.98 s (measured 0.94-0.98); the serial
parse and bind cost 0.26 s more than the projected parallel parse, and the
critical path, `checker.ts` on a child, is within 3% of the projected
564 ms. So garnet's B-shaped time on this runtime is the projected 0.7 s
once parsing is parallel (F4), and the floor is one thread's parse, check
and emit of `checker.ts`: 1.44-1.65x scriptc's today. Memory: 1.37 GB of
resident set across the processes at four checkers, against scriptc's
472 MB and the 3.2 GB four separate programs would take.

Not done: F4 (parse children), the ASan run, the contention fixture of the
codec against Node's `structuredClone`.
