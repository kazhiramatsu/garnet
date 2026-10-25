# Published graphs: `garnet:shared` (design)

Session 352, after the profile-guided build. Kaz's direction: scriptc's
`publish` is not JavaScript; garnet gives the same programs a module of its
own whose semantics are plain JavaScript, with the sharing as an
implementation of posting such a graph. Treated as a garnet-specific module,
not as a compiler feature.

## Why

Against scriptc's native tsc-ts, garnet's trained build is faster on one
thread (1.00 s against 1.01 s) and 23% slower with four checkers (0.53 s
against 0.43 s). The phase times say where (`--extendedDiagnostics`, the
TypeScript compiler project):

| four checkers | scriptc | garnet |
|---|---|---|
| parse | 0.042 s (ten parse threads, binding inside them) | 0.124 s (one thread) |
| bind | 0.000 s | 0.036 s (one thread) |
| check (c0's critical path) | 0.371 s | 0.357 s |
| total | 0.415 s | 0.519 s |

The checkers are already at parity; the gap is the serial parse and bind,
0.160 s against 0.042 s. tsc-ts's parse threads return bound source files
to the main thread by *publishing* them: scriptc's `@scriptc/threads`
`publish(graph)` makes an object graph immutable and visible to every
thread by reference, a write throwing. JavaScript has no shared object
graphs (workers copy by structured clone, only `SharedArrayBuffer` bytes
are shared), and garnet's fork prototype (`docs/fork_workers_design.md`)
shares only one way, parent to child, so its parse stayed on the main
thread.

## Semantics: `publish` is a deep freeze

`garnet:shared` exports:

- `publish<T>(graph: T): T` makes every object reachable from `graph`
  immutable and returns `graph`: plain objects and arrays as
  `Object.freeze` does (property writes, additions and deletions throw in
  strict code, and TS/ESM is always strict); class instances the same, their
  declared fields included; functions, with the variables they capture
  frozen; Maps and Sets, whose `set`, `add`, `delete` and `clear` throw.
  Strings, numbers and the other primitives are already immutable. A graph
  that holds an `ArrayBuffer`, a typed array, a `WeakMap`, `WeakSet`,
  `Promise`, `Proxy` or generator object is rejected with a `TypeError`
  naming the kind (their state lives outside the heap or is inherently
  mutable; a later version may copy buffers).
- `isPublished(value): boolean`.
- `sharesGraphs: boolean`: whether posting a published graph to a worker
  shares it (true in garnet; false in the Node polyfill).

Everything above is expressible in JavaScript: the Node polyfill is a
recursive `Object.freeze` plus a guard on the collection methods. A program
behaves the same under both, with one stated divergence: a published graph
posted to a worker arrives published (immutable) in garnet, while Node's
structured clone would deliver a mutable copy; a receiver that writes to it
throws in garnet and not in Node. The write is contrary to what `publish`
declares, and scriptc throws as well.

Sharing is not part of the semantics. When the receiver shares memory with
the sender (a forked worker today, an isolate later), `postMessage` of a
published graph passes a reference; elsewhere it copies. Identity across
threads is not observable in JavaScript, and a frozen graph cannot be told
from its copy, so the choice is the implementation's.

`@scriptc/threads` for tsc-ts becomes a re-export of `garnet:shared`
(`publish`, `sharesPublishedGraphs = sharesGraphs`): the same kind of
host-provided module as the `node:fs` shims, with nothing scriptc-specific
in the compiler.

## The module

- `lib/garnet/shared.ts`, shipped with garnet, typed, importable by any
  program as `garnet:shared`. The exporter resolves the `garnet:` scheme to
  `lib/garnet/<name>.ts` (a built-in path mapping; a project's own `paths`
  may still override it, as tsc-ts's tsconfig maps the Node shims).
- The module calls the runtime through the global `__garnet` (`publish`,
  `isPublished`, `sharesGraphs`), a plain object the runtime registers in
  `ts_setup_globals` (host-independent). Under Node the global is absent and
  the module runs its own deep freeze.
- The V8 oracle of the conformance and difftest harnesses runs node with a
  resolve hook (`scripts/garnet_scheme_loader.mjs`) that maps `garnet:` to
  the transpiled module, so a fixture can import it.

## Enforcement: a write to a published object throws

Immutability is only as good as the write paths that honor it. Today:

| receiver | dynamic write path | typed direct store |
|---|---|---|
| plain object, array | integrity bits (`shape >> 29`), throws | n/a (through the runtime) |
| class instance (sized) | **does not check** | **does not check** |
| Map, Set contents | n/a in JS (`Object.freeze` leaves them mutable) | n/a |

The class-instance row is a silent miscompile that predates this design
(probe: `Object.freeze(p); p.x = 2` succeeds in garnet, V8 throws
`TypeError`; the dynamic path through `any` succeeds too). Slice P1 fixes
it: the sized store paths test the integrity bits, and the typed direct
store `hobj->f = v` gets the same test under a knob (`TSAOT_FROZEN_STORES=0`
keeps the unchecked store), its cost measured on tsc-ts; the collections
get a header flag `TS_HDR_PUBLISHED` tested in `set`/`add`/`delete`/`clear`
(one test of a byte the kind check already loads). Captured variables live
in typed cells (sized), so the class-instance fix covers them.

A check mode, `TSAOT_PUBLISH_PROTECT=1`, maps a worker's region read-only
in every process that only reads it: in the parent once the worker has
exited, in a plain worker (a checker) at its fork; a write faults, and with
`TSAOT_CRASH_TRACE=1` the fault names the address and the writer. Nothing
writes there since P5 (a string in a region does not cache its hash, a
published collection iterates without storing an order, the collectors
never mark a region cell), so a clean run is a gate.

### P1 as built

The dynamic store paths (`ts_set_pic`, `ts_set_sized_pic_try`, `ts_set`) all
tested the frozen bit already; the typed direct store `hobj->f = v` was the
one unchecked path (the probe's `any` store had been specialized into a typed
store by the exporter). It now reads the receiver's shape word, which sits
beside the class word the store untags anyway, and takes the slow path on the
frozen bit (`ts_store_frozen`): the slow path throws
`ts_throw_frozen_field` (the strict TypeError, naming the class) or routes
the foreign receiver through `ts_set` as before. One test per store cost the
trained tsc-ts compile +1.8% instructions and +0.7% cycles, so the emitter
omits the test for a store whose receiver an earlier direct store of the same
straight-line run has tested, when nothing between them could run user code
(the only way an instance becomes frozen) or redefine the receiver
(`frozen_elision_for`: constants, copies, typed direct loads and numeric
arithmetic keep the run; a nested body, a call, a dynamic access or anything
else ends it). A constructor's field initialization pays one test instead of
one per field: 16,173 static tests in tsc-ts became 9,424, but the compile
still paid +1.4% instructions (the hot stores are single stores in the
checker and binder). What makes the test free is the whole program: an
instance can only become frozen through `Object.freeze`, `seal`,
`preventExtensions` or `Reflect.preventExtensions`, a dynamic call named
like one of them on an untyped receiver, or `Object`, `Reflect`,
`globalThis` or `__garnet` taken as a value (a call the emitter cannot see);
`may_freeze_instances_init` scans every function for them (a freezer whose
argument is an object or array literal of the same function does not count),
and a program without one gets no tests at all. tsc-ts has none: its trained
compile is unchanged (instructions 1.0002, cycles 0.9995, outputs identical).
Fixture `classes/frozen_instances_dynamic` freezes an instance through
`Object` taken as an `any` value and checks the tests are still there.

Found on the way and fixed: the read-only message named every receiver
`#<Object>`; V8 names the class. A class's prototype gets its `constructor`
property lazily (when the program observes the class value), so the
runtime cannot always find the name through the prototype chain; the
emitter now registers the program's class names by class id
(`CLASS_NAME_TAB`, `ts_register_class_names`, `TSAOT_CLASS_NAMES=0` for the
parity oracle) and the messages and `console.log`'s prefix read it for a
sized instance on its allocation class's chain. Fixture
`classes/frozen_instances` (declared fields of every kind, a subclass, a
store through `any`, sealed and non-extensible instances, a hot loop over
mixed instances).

### P2 as built

- `lib/garnet/shared.ts` is the garnet binding (`__garnet.publish`,
  `isPublished`, `sharesGraphs`), `lib/garnet/shared_node.ts` the Node
  polyfill with the same exports (a deep `Object.freeze` over own keys,
  entries and elements; `set`/`add`/`delete`/`clear` of a published Map or
  Set replaced by throwing own properties; the rejected kinds thrown before
  anything is frozen; a `WeakSet` answering `isPublished`). The exporter
  maps `garnet:*` to `lib/garnet/*.ts` through TypeScript's `paths` (an
  absolute pattern beside the exporter; a project's own `paths` are merged
  over it), so the module is an ordinary part of the whole program. The
  oracle's node runs `--import scripts/garnet_scheme_loader.mjs` when the
  transpiled fixture mentions the scheme: its hooks resolve `garnet:<name>`
  to `lib/garnet/<name>_node.ts` when that exists, else `<name>.ts`, and
  transpile on the fly.
- The runtime creates the `__garnet` object when it creates `globalThis`
  (`ts_garnet_global_init`, no emitter change). `ts_publish` walks the graph
  with a worklist over own properties (slots or dictionary entries, the
  sidecar of a sized instance), struct fields of class instances (the class
  registry's non-numeric offsets), array elements (dense or the sparse
  table), Map keys and values, Set elements, a function's captured cells and
  `prototype`, an accessor's getter and setter; not the prototype chain, as
  a deep `Object.freeze` does not. The first pass collects and checks kinds
  (`ArrayBuffer`, typed arrays, `Promise`, generators, `Proxy`, weak
  collections throw `Cannot publish a ...`); the second sets the integrity
  bit of `Object.freeze` on every property bag and `TS_HDR_PUBLISHED` on
  every cell, then bumps the property-addition epoch once. `ts_map_set`,
  `ts_map_delete`, `ts_map_clear`, `ts_set_add`, `ts_set_delete` and
  `ts_set_clear` test the flag after their kind check (`Cannot modify a
  published Map`); the collections have no inline mutator fast path to
  guard. `isPublished` is the flag (a primitive is published).
- A program that imports the module takes `__garnet` as a value, so the
  whole-program fact of P1 keeps the typed stores' frozen test for it.
- Fixture `modules/published_graphs` (the graph of P2's walk, every write
  kind, reads after publishing, the rejected kinds with nothing frozen after
  a rejection, a shared node and a cycle, publishing again, primitives).
  The tsc-ts shim `@scriptc/threads` keeps its identity `publish` until P5,
  where the main thread's `publish(program)` is measured with the parse
  workers (a full-graph freeze on the critical path is a cost to measure,
  not to pay blind).
- Cost: the trained tsc-ts compile, which does not import the module,
  against the build before P1: instructions 1.0007, cycles 1.0016, outputs
  identical (the collections' flag test and the global's creation; the
  trained builds' own variation is 0.01% in instructions and 0.2% in
  cycles).

### P3 as built

- `ts_worker_fork_shared(data)`: the parent takes a run of blocks from the
  cage frontier (`TSAOT_SHARED_REGION_MB`, default 512), maps it
  `MAP_SHARED | MAP_ANON | MAP_FIXED` at its cage address and marks the run
  `GC_BLK_REGION`: the collector's conservative scan ignores a word into it
  (no cell block), nothing allocates there, nothing sweeps it. The child
  abandons every size class's cursor and block list, the free-block list,
  the large lists and the dirty-block log (the parent's blocks are the
  parent's), and `gc_block_take` and `gc_cage_frontier_take` serve from the
  region only (`gc_region_take`; exhaustion aborts naming the knob). A new
  property name interned in a shared worker aborts loudly (v1).
- Shape ids: at the first shared fork the parent's next id becomes the
  partition base with a headroom of `TSAOT_SHARED_SHAPES` (65,536) ids; the
  k-th worker gets the k-th range above it. A worker past its range aborts;
  the parent past its headroom aborts while workers live and jumps past
  their ranges once they are gone (`shape_limit_reached`). A worker logs
  every shape it creates (`shape_log_push`) and ships the log with its next
  frame; the parent installs them at the worker's ids
  (`shape_install_at`: the edge only when it has no transition for the
  keys, the descriptor always).
- `publish` in a shared worker promotes every cell it reaches
  (`gc_cell_promote`: old, the old bit, not remembered) and sets its mark to
  1: immortal in the worker, and opaque to the parent's markers, whose
  per-edge filter takes mark 1 as already marked, so the parent never
  scans a region cell and never needs its block metadata. A pre-fork cell
  the graph reached is recorded and shipped with the next frame; the parent
  freezes it, flags it published and roots it for good (the region refers
  to it and the parent's marker will not look).
- The codec: a published cell inside the worker's region encodes as
  `MSG_SHARED` with its address (a function cell too); the parent's decoder
  accepts the tag only for a frame from a shared worker, checks the address
  lies in that worker's region at a cell boundary and names a published
  cell of a valid kind, and returns it in place. A shared worker's frame
  starts with `MSG_FRAME_SHARED`, the shape log and the frozen pre-fork
  cells, then the message; a plain worker's frames are unchanged.
- The parent runs young collections only while a shared worker lives (the
  full threshold saved and restored when the last one exits);
  `TSAOT_PUBLISH_PROTECT=1` maps the region read-only in the parent when
  the worker exits (a diagnostic: string hashes are cached lazily).
- The tsc-ts host's `forkWorker(data, shared)` and the shim fork a parse
  thread (`workerData.kind === 'parse'`) as a shared worker; nothing starts
  one yet (P5).
- Runtime tests: a shared worker publishes a graph with a nested array and
  object, a Map, a string, a function cell, an object of a shape the parent
  never made and a pre-fork cell, and posts it wrapped and bare: the two
  frames name one cell, every part reads in place, the Map reads, the new
  shape's keys read, the pre-fork cell is the parent's own and frozen
  there, writes and `Map.set` throw in the parent, and the graph survives
  the parent's young and full collections; a worker past its region and
  one interning a new name die loudly into the error handler.

### P4 as built

- A second pipe at every fork: the parent keeps its write end in the watch
  (`out_fd`), the child its read end (`g_parent_fd`). `ts_worker_send(id,
  value)` encodes with the plain codec (the parent is never in region mode)
  and writes a frame to a live worker; a worker that has exited throws.
  `ts_worker_on_parent_message(fn)` registers the worker's listener and
  opens the port; `ts_worker_parent_close()` closes it. The event loop
  counts an open port as pending work and polls the parent's descriptor
  beside the workers' (`ts_watch_poll`); a frame is decoded and delivered
  to the listener (`parent_read`), an end of file closes the port. A plain
  worker's loop is unchanged when it registers no listener.
- The host's `sendToWorker`, `onParentMessage` and `closeParentPort`; the
  shim's `Worker.postMessage` posts, `parentPort.on('message')` listens,
  `parentPort.close()` closes, as a tsc-ts parse thread expects (it loads
  the chunks the main thread posts until `stop`, then closes its port).
- Runtime tests: a worker doubles three numbers posted to it and ends on
  the stop message, the replies arriving in order; posting to the exited
  worker throws.

### P5 as built: tsc-ts parses on shared workers

- The shim `@scriptc/threads` re-exports `garnet:shared`'s `publish` and
  sets `sharesPublishedGraphs`; `main.ts` starts the threads as the Node
  build does (`startThreads`: checkers, parse threads, reference threads).
  A parse thread is a shared worker (`workerData.kind === 'parse'`); it
  loads the chunks the main thread posts, publishes each batch and posts
  it, the main thread reading the bound files in place; `publish(program)`
  on the main thread before the checkers are forked walks only the
  program's own cells (a published cell stops the walk) and freezes them;
  the checkers, forked afterwards, see every published cell at its address.
- Bringing it up found three ways a reader or the worker's collector broke
  the invariant behind the design, *a published cell is never written by
  anyone and never freed under its readers*. Each was silent (type
  diagnostics one checker does not report, the outputs still identical),
  each is a runtime test now that fails on the code before it:
  1. *A reader's lazy cache stored into a shared cell.* A Map or Set
     iterated for the first time allocated its iteration order and stored
     the pointer in the cell: one checker stored its own malloc'd pointer
     into the region, the other read garbage order ids and saw a subset of
     an interface's members (`Property 'multiLine' does not exist on type
     'ObjectLiteralExpression'`). A published collection never changes, so
     its order is the dense index + 1: `identity_order`, one table per
     process, nothing stored (`mapset_cursor_view`, `ts_map_iterator`).
     The 372 diagnostics that survived with young collections off were
     this.
  2. *The collector marking region cells.* A young collection reached
     region cells the walk had not promoted (strings, below) and wrote
     their mark and generation into shared memory; `TSAOT_PUBLISH_PROTECT=1`
     in the checkers caught it (SIGBUS in `gc_scan_cell`). The per-edge
     filter and the conservative stack scan now return at a cell in a
     `REGION` block when shared regions exist: one predictable branch,
     0.2% instructions and no cycles on the one-checker compile.
  3. *Strings and prototypes left young.* The walk skipped strings as
     immutable, but a young string referenced only from the old published
     cells is freed by the worker's next young collection and its cell
     reused, so the readers saw other identifiers (`Cannot find module
     './_namespaces/ts.js'`, members missing). In region mode the walk now
     promotes the strings it reaches, a view's text and a symbol's
     description; the prototypes the graph reaches (and what they reach,
     within the region) are kept the same way, immortal and opaque but not
     frozen, as a deep freeze leaves prototypes alone (a pre-fork prototype
     is the parent's own).
- Also from the first crashes of this slice: a published cell's payloads get
  the old bit (`publish_mark_payloads`), a young collection runs before a
  shared fork, the walk uses the mark byte rather than a hash set, a payload
  grown on a region cell is malloc'd in the reader, a region string never
  caches its hash, shape id ranges are monotonic across successive workers
  (an installed id with another layout aborts), `MSG_SHARED` boxes a string
  as a string, and the crash trace (`TSAOT_CRASH_TRACE=1`).
- Measurements (the compiler project, trained builds, quiet machine):
  four checkers 0.47 s wall against scriptc's 0.44 s (1.068; 1.23 before
  the parse workers), peak RSS 322 MB against 454 MB; by tsc-ts's clock
  parse 0.124 s, check 0.361 s, total 0.500 s. Outputs identical to one
  checker's at 1, 2, 4 and 8 checkers; GC stress in the parse workers, the
  parent and the checkers identical; `TSAOT_PUBLISH_PROTECT=1` clean. One
  checker (no parse workers), P5 against P2: instructions 1.017, cycles
  1.008, wall 1.010; of this the four shared-region tests on hot paths
  (the marker's two, `gc_owned_alloc`, the hash cache) are 0.3%
  instructions and no cycles, tsc-ts's own shared code path 0.1%; the rest
  is not in any changed hot path: a build without every added test is
  still 1.5% instructions and 0.6% cycles above P2 with a text 1.1% larger
  (`startThreads` links the parse and reference thread code, and the
  whole-program facts move with the program).
- What remains of the gap: the ten parse threads start over 25 ms (a
  shared fork maps a region and runs a young collection) while the main
  thread reads the config in 7 ms, the last thread starting at 30 ms;
  fewer parse threads, a cheaper shared fork or forking before the heap
  grows are the next step.

### P6 as built: the parse tail

The four-checker gap after P5 (0.47 s against scriptc's 0.44 s) is the parse
phase alone: by tsc-ts's clock garnet parses in 0.090-0.097 s against
0.043-0.050 s and checks in 0.342 s against 0.364 s (quiet machine). The
timelines (`TSC_TS_TIMELINE=1`) of both show the same critical path: the
parse thread that takes `checker.ts` (3.15 MB) ends the phase, in both the
last thread to start, and the checker that gets it ends the check phase
110-120 ms after the others. On that path garnet lost: the thread's start
(@33 ms against @2.6), the read (7.0 ms against 0.4), the bind (12 against
7) and the publish (23 ms against 5.6); the parse itself matched (32
against 31).

- *The read.* `checker.ts` holds one non-ASCII character, so the decoder
  left its all-ASCII path and went through a UTF-16 buffer, a second scan
  and a copy: 6 ms of the 7. A large input with some non-ASCII is now
  decoded straight into its storage, one-byte when every code point fits
  (only C2/C3 leads), UTF-16 otherwise, the capacity `len` units and the
  length set after: 1.9 ms. V8-diffed on large mixed, Latin-1, BMP, astral,
  invalid, truncated and BOM inputs.
- *The publish.* 489k cells, 1.19M references: the walk 22 ms and a second
  pass over the cells (freeze, flag, promote) 5 ms. The walk is now one pass
  that reads a header only when the cell is visited and freezes, flags,
  promotes and logs the cell as it visits it; a rejection undoes what was
  done (the previous frozen bit travels in the done list's pointer tags; a
  cell promoted in region mode stays old, which is only memory): 20 ms
  breadth first. Depth first (a stack, the cells just pushed prefetched) the
  walk follows the allocation order, a cell's children sitting right after
  it: 16.7 ms; 34 ns per cell remain, cache misses on a 60 MB region. On a
  cache-friendly synthetic graph of 400k objects every form takes the same
  4.5 ms.
- *Collections in the parse workers*, tried and reverted: a worker without
  young collections (everything old at birth, the walk with nothing to
  promote) published `checker.ts`'s batch in the same 23.7 ms and parsed it
  no faster (39 ms against 32 in one noisy sample); the workers reclaim
  little (regions of 13-61 MB with collections, 16-64 MB without), so the
  collections cost little too. The default stays.
- *The start.* `TSAOT_FORK_TRACE=1` prints each fork's cost: the parent's
  young collection 0.2-0.5 ms, fork() 0.2-0.6 ms (40 MB resident), the child
  at its entry within a millisecond; the ten spawns take 8 ms of the main
  thread, inside its config read (@6.6 to @14.5), and a child's first
  TypeScript mark comes 3-18 ms after its entry: ten workers and the main
  thread on 4 performance and 6 efficiency cores, the early workers already
  on the libraries. The root files are queued when the config read ends
  (@16.9 against @2.7), and `checker.ts` goes to the first worker that
  asks, the last one started (@34). Fewer parse threads do not help
  (`TSAOT_CPUS=4/6/8/10`: parse 0.105/0.095/0.095/0.091 s). Open: a cheaper
  spawn loop (the young collection once per batch, forks of 0.3 ms), and
  the main thread's own 5 ms before `main` runs against scriptc's 1.3.
- *The shape of the phase.* With `TSAOT_PROF_PC` now profiling the forked
  workers too (each writes `<file>.<pid>`), the ten parse workers spend 76%
  of their samples in `poll` and the main thread 47% of its parse-phase
  samples there: the phase is latency-bound, a chain of dependent steps on
  one worker with idle hardware around it, not throughput-bound. The main
  thread turns chunks around as fast as scriptc's (the gaps between
  consecutive receipts have the same distribution), so the remaining gap is
  the chain itself (the start, the bind, the publish) and not the plumbing.
  The check phase, 75% of the compile and already ahead of scriptc's, is
  where the race is decided; the per-checker profiles are the tool for it.
- *At the default checker count* (ten on this machine, both compilers) the
  timelines after P9 read: scriptc parse done @49.7, checkers spawned @51.8,
  nine checkers done by @214 and the main thread's own checker, which takes
  `checker.ts`, done @488.6; garnet parse done @101.8, spawned @115.0, nine
  done by @267 and the main's checker @498.0. The main's checker is the
  critical path for both, garnet's taking 383 ms of work to scriptc's 437, so
  the compile's end is the parse phase's end plus that: the parse phase is
  the whole remaining gap, and winning it by 50 ms would put garnet 10%
  ahead at the default.
- Knobs: `TSAOT_CPUS=N` (the host's `availableParallelism`),
  `TSAOT_FORK_TRACE=1`, `TSAOT_PROF_PC=<file>` in forked workers.

## Sharing by fork: regions

The fork prototype shares the parent's heap with its children by
copy-on-write. A parse worker's output must be visible to the parent, so a
shared worker allocates into a **region** the parent set up before the
fork:

1. **Reservation.** `forkWorker(data, { shared: true })` takes a run of
   blocks from the cage frontier (`TSAOT_SHARED_REGION_MB`, default 512),
   maps it `MAP_SHARED | MAP_ANON | MAP_FIXED`, read-write, and marks its
   block table entries `REGION`: the parent's collector never allocates
   there, never sweeps or scans those blocks, and ignores a conservative
   pointer into them. The region is immortal in the parent (freed at exit):
   a published program lives as long as the compile, and nothing in the
   region is ever collected by the parent, so no block metadata, mark bit or
   allocation bitmap needs to be shared or merged.
2. **The child in region mode.** After the fork the child resets every
   size-class cursor and takes blocks from the region only (exhaustion
   aborts loudly, naming the knob). Its young collections run as today over
   its private metadata; it never runs a full one (as the prototype).
   Objects allocated before the fork stay the parent's: a write to one goes
   to the child's private page, as in the prototype and as a scriptc parse
   thread's write to its own module state.
3. **Shape ids.** The child creates shapes (a literal site's first
   execution, a dynamic property on an instance). At the fork each worker
   receives a disjoint id range above the parent's next id plus a headroom
   for the parent; with every message the child ships the descriptors
   created since the last one (id, parent id, key, flags) and the parent
   installs them at those ids before decoding the message (its own
   transition for the same keys, if any, keeps its own id: two ids for one
   layout cost cache misses, not correctness). Class words are static.
   Interning a *new* property name in a shared worker aborts loudly in this
   version (the parent could not map the id); tsc-ts's parse and bind are
   expected not to, and the abort says so if they do.
4. **`publish` in the child** walks the graph from the root with the
   collector's visitor: each cell gets the integrity bit (or the published
   flag for a collection), the generation `OLD` so the child's young
   collections never reclaim it, and a pre-fork cell reached (outside the
   region) is recorded. Nothing is copied. The rejected kinds throw before
   anything is marked (a first pass checks, a second marks).
5. **`postMessage` in the child** writes one frame: the new shape
   descriptors, the addresses of the pre-fork cells the graph reached, and
   the message, in which a published cell inside the region is encoded as a
   reference (`MSG_SHARED`, its address) rather than by value. Anything
   else encodes as today.
6. **The parent on receipt** installs the shapes, freezes the pre-fork
   cells and roots them permanently (the region refers to them for the
   rest of the run), decodes references after checking each lies in that
   worker's region, and delivers the message. While a shared worker lives
   the parent runs young collections only (a full one is deferred; a
   published object is `OLD` and never points at a young object of the
   parent, so the young collections need nothing new).
7. **Later forks** (the checkers) inherit the shared mapping: they read
   the published program at the same addresses.
8. **Messages to a worker.** Parse threads receive their work from the
   main thread (`LoadMessage`, `stop`). A second pipe carries frames from
   the parent to the child; the child's event loop watches it and delivers
   to `parentPort.on('message')`. Plain data only, as today.

### Limits, stated

- A region is never reclaimed (until exit). A long-running program that
  publishes repeatedly grows; the compiler does not.
- The typed-store check (P1) is what makes a published class instance
  immutable in the parent too; before P1 a typed write in the parent would
  silently change a shared object.
- Buffers, weak collections, promises, proxies and generators are rejected
  in a published graph.
- Posting a published graph to a Node worker (the polyfill) copies; a
  receiver that writes to it diverges loudly from garnet, as stated above.

## tsc-ts

`parallelParse.spawn` forks shared workers through the shim; `publish` is
`garnet:shared`'s; `main.ts` calls `startThreads` as the Node build does
(the serial path goes). The expected result was parse and bind on N
children, about 0.05 s instead of 0.16 s, and a four-checker compile of
about 0.41 s against scriptc's 0.415 s. Measured ("P5 as built"): parse
0.124 s by tsc-ts's clock and 0.47 s against scriptc's 0.44 s; the parse
threads' start, not their work, is what remains.

## Gates

- `tests/conformance/exhaustive/modules/published_graphs.ts`: publish
  freezes plain objects, arrays, class instances (declared and dynamic
  writes), captured variables and collections; `isPublished`; the rejected
  kinds throw before anything is frozen; a published graph's identity is
  the argument's.
- Runtime tests (C): a shared region fork, a published graph read by the
  parent by reference, shape descriptors installed, a pre-fork cell frozen
  in both, the parent's young collections during the worker's life and a
  full one after it, region exhaustion's abort, a new intern's abort; a
  worker's young strings (views of its own text among them) and a
  prototype it made surviving its collections after the publish; a
  published Map and Set iterated by another process first and then here,
  in the identity order, nothing stored in the shared cells.
- tsc-ts: outputs identical to one checker's at 1, 2, 4 and 8 checkers with
  parse workers; GC stress in the parse workers, the parent and the
  checkers (`TSAOT_GC_YOUNG_THRESHOLD=1`) identical; `TSAOT_PUBLISH_PROTECT=1`
  (the regions read-only in the parent after the workers and in the
  checkers from their fork) clean; no young collections at all
  (`TSAOT_GC_YOUNG_THRESHOLD` huge) clean, which separates a reader's write
  from a collector's.
- Every existing gate unchanged (the runtime changes are behind the shared
  flag and the published bits).
- Performance: P1's check on tsc-ts's one-checker compile (instructions,
  cycles) within the trained builds' 0.2% noise, or a cheaper form is
  found before it ships on by default; P5's four-checker time against
  scriptc, interleaved.

## Slices

- **P1** freeze enforcement for class instances (dynamic and typed stores,
  knob, cost measured) and the collections' published flag.
- **P2** `lib/garnet/shared.ts`, the exporter's `garnet:` scheme, the
  runtime's `__garnet`, the oracle's resolve hook, the fixture; the
  `@scriptc/threads` shim re-exports it.
- **P3** the runtime: regions, region mode, shape id ranges and
  descriptors, the publish walk, `MSG_SHARED`, the parent's deferral and
  permanent roots, the protect mode; C tests.
- **P4** frames from the parent to a child; the shim's
  `Worker.postMessage` and `parentPort.on('message')`.
- **P5** tsc-ts on parse workers; the measurements; `docs/TODO.md`.
- Later: isolates in one process reuse the API (regions become heaps
  visible to every isolate; `__garnet.sharesGraphs` stays true).

## The serial parse, for reference

The one-thread parse and bind (0.16 s; scriptc 0.12 s) profiled at 20 µs
(`TSAOT_PROF_PC`, the trained no-LTO build): generated code 49%, runtime
34%, system libraries 16%, of which `bzero` 7% (4.4% zeroing new class
instances in `ts_new_sized_impl`, 1% zeroing cell runs), file `open` 2.3%
and `read` 0.6%, `memcmp` in `startsWith` 1%, `memchr` in `indexOf` 1%,
`stat` 0.8%. Among the instruction classes, loads from runtime structures
and globals 26% and number conversions 3.3%. The serial parse is a separate
line of work (the zeroing of large instances first); this design removes
it from the critical path instead.
