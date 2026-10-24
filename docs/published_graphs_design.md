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

A diagnostic mode, `TSAOT_PUBLISH_PROTECT=1`, maps a worker's region
read-only in the parent once the worker has exited; a write faults and
aborts naming the address. Strings cache their hash lazily and the mode
would see those as writes, so it is a tool, not a gate.

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
(the serial path goes). The expected result: parse and bind on N children,
about 0.05 s instead of 0.16 s, and a four-checker compile of about 0.41 s
against scriptc's 0.415 s; the checkers' own time is already slightly
below scriptc's.

## Gates

- `tests/conformance/exhaustive/modules/published_graphs.ts`: publish
  freezes plain objects, arrays, class instances (declared and dynamic
  writes), captured variables and collections; `isPublished`; the rejected
  kinds throw before anything is frozen; a published graph's identity is
  the argument's.
- Runtime tests (C): a shared region fork, a published graph read by the
  parent by reference, shape descriptors installed, a pre-fork cell frozen
  in both, the parent's young collections during the worker's life and a
  full one after it, region exhaustion's abort, a new intern's abort.
- tsc-ts: outputs identical to one checker's at 1, 2, 4 and 8 checkers with
  parse workers; the project with two injected errors; GC stress in the
  parse workers and in the parent during the parse phase
  (`TSAOT_GC_YOUNG_THRESHOLD=1`); `TSAOT_PUBLISH_PROTECT=1` run clean of
  anything but string hashes.
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
