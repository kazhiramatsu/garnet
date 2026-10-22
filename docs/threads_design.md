# Threads: worker isolates and published graphs

Session 352. Status: design (no code yet). Runtime (`ts_rt.c`), emitter
(`emit_c.rs`), module shims (`benchmarks/tsc_ts_native/garnet`).

## Why

tsc-ts (`docs/tsc_ts_native_design.md`) parallelizes parsing and binding
(`compiler/parallel-parse.ts`) and checking and emitting
(`compiler/parallel-check.ts`) on worker threads, sharing the bound program
between them by reference through `@scriptc/threads`. On the TypeScript
6.0.3 compiler project, scriptc's binary takes 1.02 s on one thread and
0.48 s on its threads; garnet runs it single-threaded in 1.75 s (Session
352, interleaved). The same parallel fraction would bring garnet to about
0.8 s. The code that would run is the code tsc-ts already has.

## The contract

garnet implements the API tsc-ts is written against, with the semantics
`@scriptc/threads` documents, so a program behaves the same under Node.js
(the V8 oracle) and natively:

- `node:worker_threads`: workers with their own JavaScript heap and realm,
  `postMessage` and `workerData` by structured clone (the subset tsc-ts
  uses: see "What tsc-ts uses").
- `@scriptc/threads`: `publish(value)` makes `value` and everything it
  reaches immutable and immortal, and `postMessage` / `workerData` deliver
  a published graph by reference (`sharesPublishedGraphs` is true).
  Publishable: primitives other than symbols, plain objects, arrays, class
  instances, Maps and Sets; anything else reached throws a TypeError before
  anything changes. Writes into a published graph throw the frozen-object
  TypeErrors; published Maps and Sets reject their mutators.
- `SharedArrayBuffer` and `Atomics`: real shared memory between isolates.

## What tsc-ts uses

(Survey of tsc-ts's source; paths under `packages/tsc-ts/src/compiler`.)

- **Workers**: one constructor form, `new Worker(new URL(import.meta.url),
  { workerData })` (`main.ts`), so a worker re-runs the program's entry with
  every module initializer in a fresh isolate and dispatches on
  `workerData.kind`. `isMainThread`, `workerData`, `parentPort`
  (`postMessage`, `on('message')`, `close`), and on a `Worker`
  `postMessage`, `on('message')`, `on('error')`. Never: `terminate`, exit
  events, `MessageChannel`, transfer lists, `resourceLimits`. Only the main
  thread spawns. `node:os` `availableParallelism()` and `totalmem()`.
- **Parse threads** (`parallel-parse.ts`, `parse-thread.ts`): main hands out
  chunks of files (`LoadMessage`, cloned); a thread parses and binds them,
  publishes the batch (`PreparedBatch`: the bound `SourceFile`s and their
  resolutions) and posts it; main adopts the files into its program by
  reference and sends more; at the end main posts `stop` and the thread
  exits. Published cells therefore outlive the isolate that allocated them.
- **Checker threads** (`parallel-check.ts`, `thread-entry.ts`): main
  publishes the whole program (`shareWithCheckers`: lazy values computed,
  caches switched to per-thread tables, merged globals, emit indexes) and
  passes it in `workerData`; each thread builds its own checker over it,
  pulls files from a shared schedule in a `SharedArrayBuffer`
  (compare-and-swap cursor, two busy-wait spin locks, work stealing), emits
  the files it checks, and posts one packed result (`Int32Array`s and
  strings, cloned) when it ends, so nothing on its heap stays reachable.
- **Shared memory**: nine `SharedArrayBuffer`s (id counters, the schedule,
  incremental-build verdicts); `Atomics` `add`, `compareExchange`, `or`,
  `load`, `store`; never `wait` or `notify`. Node and symbol ids come in
  chunks from a shared counter, so published ids stay unique.
- **Blocking**: none on main (its event loop must deliver the workers'
  `message` and `error` events); the checkers spin.
- **Per-isolate module state** tsc-ts relies on: id counters, per-thread
  caches over shared objects (file system, resolution, package.json, string
  lengths: a cache inside a published string must not be written in place),
  scratch buffers, the checker's tables, the global `process`.
- **garnet's shims today** (`benchmarks/tsc_ts_native/garnet`): `Worker`
  throws, `isMainThread` is true, `publish` is the identity,
  `sharesPublishedGraphs` is false and `availableParallelism()` is 1, so
  tsc-ts takes its single-threaded path (`--checkers N` crashes). The host's
  `g_last_errno` (`host.c`) would have to become per thread, and worker
  threads need large stacks (an -O0 build already overflows 8 MB).

## Two runtime models

1. **Isolates with their own heaps, published graphs immortal** (scriptc's
   model). Each worker is an isolate: its own heap, collector, roots,
   exception state and realm. A published graph is frozen and its cells
   marked immortal: the publishing isolate's collector neither sweeps nor
   traces them (everything they reach is published too), and other
   isolates read them in place (cells never move). Collections stay
   single-threaded and per isolate, so the collector needs no change beyond
   the immortal state. A published graph is never freed: right for a
   compiler (the program lives to the end), a leak for a server that
   publishes per request.
2. **One shared heap, many mutators** (Dart's isolate groups). Isolates
   share one heap and collector; immutable objects are sent by reference
   and stay collectable. A collection stops every isolate and can mark on
   every core (garnet's collector is single-threaded today, which is what
   keeps its pauses above V8's). It needs thread-local allocation buffers,
   safepoints for all mutators, per-thread remembered sets and a parallel
   marker.

Model 1 first: it is the smaller step and what tsc-ts needs; model 2 stays
open as the follow-up that also parallelizes collection.

## The isolate block

Model 1 needs every isolate's state reached cheaply from any code: the
runtime's 255 live file-scope variables (Session 352 survey of `ts_rt.c`,
plus 36 function-local statics, the regexp adapter's, JSON's and the
host's), and the generated code's mutable statics (tsc-ts: 16,561 site
inline caches of 80 bytes, `GLOBALS[6219]`, `CLASS_PROTO[812]`). Measured
on this machine, one frame push and pop through the state:

| access | ns |
|---|---|
| a plain global (today) | 0.44 |
| a `__thread` variable or a `__thread` pointer to a struct (Darwin's TLV thunk, `blr`) | 1.05-1.13 |
| the isolate block at the base of a stack aligned to its size (`mov x, sp; and x, x, #mask`) | 0.44 |

So each thread that runs JavaScript (the main isolate included) runs on a
stack region aligned to its size (say 256 MB, reserved, committed as it
grows), with its isolate block at the region's lowest pages behind a guard
page: `ts_iso()` is the stack pointer masked, no call, no extra load.
garnet's coroutines and exceptions never switch stacks (state machines,
`setjmp`/`longjmp` on the same stack), and C callbacks run on the caller's
stack. A threaded build starts its main isolate on such a thread and the
process's first thread only joins it.

The build is chosen per program: the compiler knows whether the program
imports `node:worker_threads` (whole program), and only then emits the
threaded forms (`TSAOT_THREADS`): a state accessor that is a plain global
otherwise, so a single-threaded program's C and runtime stay as they are.

## State, by category

From the survey (`ts_rt.c` lines in the survey's notes):

- **Per isolate**: the heap and collector (pacing, cage cursors, work lists,
  young log, survivors, remembered set, mark stacks), the roots
  (`g_roots`, `g_static_roots`, `g_ts_frame_top`), the allocation-site
  feedback, exceptions (`g_handlers`, `g_exception`), the event loop and
  its queues, the prototypes and builtin singletons (34 names, created at
  setup or lazily), the class registry, every cache holding a prototype's
  identity and its epochs (location, addition, absent, class-field caches),
  the symbol registry and `g_sym_value`, `g_ts_cur_env`, the JSON chunk
  pool, `g_inspect_color`, the regexp caches, `Math.random`'s state, the
  host's `g_last_errno`; in the generated code the site caches, `GLOBALS`,
  `CLASS_PROTO`, `OBJECT_PROTO`, the lazily interned key ids. Moving the
  site caches into the isolate block also removes the worst race: a site
  cache entry is a 12-byte record written non-atomically, and the inline
  hit path trusts its slot without a bounds check.
- **Shared, read-mostly**: the shape tables and the field intern table
  (their ids are baked into the generated code, the site caches and every
  object, so isolates must agree), the symbol id counter, the class-index
  and size-class tables, the configuration, the static string literals and
  the constant tables. Appends take a process mutex; rows live in chunks
  that never move (no `realloc` under a reader), the transition hash table
  is replaced but the old one never freed, and an id is published with a
  release store before any object carries it. One-time initializations
  (`fn_keys_init`, `ts_wksym_init`, the regexp keys, `gc_config_init`) run
  at startup, before any worker.
- **Process-wide flags**: `g_has_proxies`, `g_typed_slow`,
  `g_class_relinked` only go from 0 to 1; they stay global (one isolate's
  Proxy slows the others' guarded accesses, which is correct).

## Heaps and published graphs

One cage for the process; its blocks are owned by isolates (the block table
records the owner, the free-block list is shared under a lock), and a
collection visits its own isolate's roots and blocks only.

A published cell's gen byte says IMMORTAL. The marker stops at it without
marking (everything a published cell reaches is published), sweeps keep it,
and no barrier fires on it (it is frozen), so no collector of any isolate
writes a published cell's header. An isolate that exits (tsc-ts's parse
threads, once main has their files) runs a last collection with no roots,
keeps its blocks that hold immortal cells (owned by the process from then
on, never swept) and frees the rest.

`publish(value)` walks the graph twice: first to validate (a function, a
symbol, an accessor or another unpublishable cell throws the TypeError and
nothing has changed), then to freeze every cell and mark it immortal
(young cells take their old bit). Strings are flattened first (a view's
parent is published with it); the lazy caches inside strings (hashes) are
not written once a string is published. Writes into a published graph throw
the frozen-object TypeErrors: the generic paths already test the integrity
flags; the emitter guards the struct stores of the classes a program can
publish (the classes reachable from `publish` arguments, found by the class
extractor like the closed-receivers proof); Map, Set and array mutators test
the immortal gen.

Prototypes: a published class instance keeps its class index. In another
isolate, `instanceof`, receiver guards and dispatch tables work by that
index already; the dynamic paths read a published sized instance's
prototype through `obj_proto(o)`, which takes the receiving isolate's own
`CLASS_PROTO` for its class, so every isolate has its own prototypes (as
realms do) and no thread ever reads another isolate's prototype objects
(which their isolate may still write: lazily created method values and
prototypes).

## Workers and messages

- `new Worker(url, { workerData })` starts an OS thread on an aligned stack
  with a fresh isolate that runs the program's module initialization, then
  the entry's code sees `isMainThread` false and its `workerData`.
- Each isolate has an inbox (mutex and condition variable). `postMessage`
  serializes its value on the sender's thread (the structured clone: plain
  objects, arrays, strings, numbers, booleans, `null`, `undefined`; class
  instances as plain objects, as Node delivers them; typed arrays copied;
  a `SharedArrayBuffer` by reference to its backing store; a published
  graph by reference) and the receiver deserializes it on its own thread.
  The event loop waits on the inbox when it has nothing else to do and
  dispatches `message` events; an uncaught exception in a worker becomes an
  `error` event on its `Worker` (not a process abort).
- `SharedArrayBuffer` backing stores live outside the cage, reference
  counted across isolates; `Atomics` operations are C11 atomics on them.
  `Atomics.wait` / `notify` (unused by tsc-ts) come later.
- `availableParallelism()` reads `hw.activecpu`; `process.exit` from any
  isolate ends the process.

## Slices

1. **The isolate block, one thread** (behavior-invariant): per-isolate state
   behind an accessor that is today's global in single-threaded builds and
   the masked stack pointer under `TSAOT_THREADS`; the main isolate on an
   aligned stack. Gates as for any runtime change; A/B of a threaded build
   of tsc-ts, still on one thread, against the plain one (expected neutral).
2. **Shared tables made concurrent**: chunked shape and intern rows, the
   append mutex, startup-time initialization. ThreadSanitizer runs
   (`scripts/tsan_one.sh`) from here on.
3. **Workers and messages**: threads, inboxes, the structured clone, the
   event loop's waiting, `error` events, `availableParallelism`; worker
   fixtures checked against Node (the same programs run under the V8
   oracle), GC stress in several isolates at once.
4. **`SharedArrayBuffer` and `Atomics`.**
5. **`publish`**: the walk, the immortal gen, the store guards, the
   prototypes; tsc-ts's shims switched to the real modules
   (`sharesPublishedGraphs` true); tsc-ts measured on its threads against
   one thread and against scriptc's threads.
6. Later, if collection shows up: model 2 (one shared heap, parallel
   marking).

## Open questions

- The stack region size (tsc-ts's -O0 build overflows 8 MB; a stack
  overflow is still undetected, so the guard page turns it into a crash
  instead of a write into the isolate block).
- Per-isolate memory: each worker carries its own prototypes, site caches
  (1.3 MB for tsc-ts) and heap headroom.
- Programs that publish per request (servers) leak under model 1.
