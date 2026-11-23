# Allocation arenas (`garnet:arena`)

Session 367. `arena(work)` runs `work` and returns its result; what `work` allocated is **kept
without being traced**. It is for work whose allocations nearly all outlive it: a parser's tree, a
decoded document, a table built once.

```ts
import { arena } from "garnet:arena";
const file = arena(() => bind(parse(read(name))));
```

Under Node `garnet:arena` is `lib/garnet/arena_node.ts`, which calls `work` and nothing else, so a
program runs under both.

## What it replaces

A generational collector is built for objects that die young. A tree that is all alive when its
builder returns is its worst case: the young collection marks every node from the roots, a
reference at a time, and promotes each. And where the tree is handed to another process (a shared
worker's `publish`, docs/published_graphs_design.md), the publish walks it again, node by node, to
freeze it and to make it old and opaque to the reader's collector.

tsc-ts's parse threads on the TypeScript compiler project (ten shared workers, 249 files, about
1.9 million cells): the publish's walk was **19% of the parse workers' time** (`publish_visit`
15.7%, its payload marks, the old bits), the allocation itself 5%. On one thread, where the parse
is collected, the young collections were 13% of the parse.

## What an arena does

Nothing while `work` runs but hold the collector off. When the outermost arena ends
(`ts_arena_end`):

1. **Every young cell of the process becomes old where it is**, by the runs the size classes
   handed out since the last collection: the mark bit of each cell (the collector's "old"), the
   generation byte in its header, and the mark bit of each payload in the payload runs; the large
   cells from the young log, the large payloads from their list. One pass over memory in address
   order, a few instructions a cell, no marker and no stack of edges.
2. **In a shared worker, the cells allocated inside the arena are published**: frozen (the kinds
   `Object.freeze` freezes), flagged published, and marked, which is what makes a cell opaque to
   the parent's marker. A later `publish` that reaches such a cell stops there, and a post passes
   it by reference, so a graph built in an arena is handed over without being walked.
3. The counters are those after a collection that found everything alive.

Why each part is what it is:

- **Every young cell, not only the arena's.** A cell of the arena may refer to a young cell made
  before the arena. Once the arena's cell is old, that reference is an old-to-young one the write
  barrier never saw, and the next young collection would free its target. Promoting everything
  leaves no young cell to lose. What is garbage among them is old garbage, which a full collection
  frees (a shared worker has none, and frees nothing either way: its region is its parent's to
  release).
- **Nothing is collected inside an arena** (`gc_before_alloc_slow` and the two collection entries
  return while one is open), so the runs logged since the last collection are exactly the young
  cells: the pass needs no bitmap of which slots are cells. An arena's memory is what `work`
  allocates, garbage included, until it ends.
- **The log of runs** (`gc_run`: a run's bounds, its class, its family) is written by the refills
  only, the slow path of an allocation, and only once the process has had its first arena; that
  first arena starts with a young collection, so no young cell predates the log. A program that
  never uses an arena executes one untaken branch in each refill.
- **Where the arena starts inside a run** a class is in, the run is split at the class's cursor:
  the cells before it are promoted and not published.
- **The kinds a publish rejects** (an ArrayBuffer, a typed array, a promise, a generator, a proxy,
  a WeakMap or WeakSet) are promoted and left unpublished, so a publish that reaches one still
  rejects it.

## What it asks of the program

In an ordinary process, nothing a program can observe: an arena is a hint about lifetimes, and
`work`'s objects can be written afterwards as always.

In a shared worker the arena publishes, and two things follow that a `publish` alone does not do:

1. **Everything allocated inside the arena is frozen when it ends**, reachable from what the worker
   posts or not (a `publish` freezes what it reaches). An object made inside and written after is a
   TypeError at the write: loud, and found by running. Keep the worker's own mutable state (caches,
   tables it grows across arenas) made outside.
2. **The arena's cells must not refer to a mutable cell of the worker made outside it.** A publish's
   walk would reach such a cell and freeze it; the arena hands its cells over as they are, so the
   cell stays the worker's, unfrozen, while the parent reads it. This one is silent, so it has a
   check: **`TSAOT_ARENA_CHECK=1`** walks every graph a shared worker publishes again, through the
   arenas' cells too, and aborts where it reaches a cell of the worker that is not published (`=2`
   reports and goes on; with `TSAOT_FORK_TRACE=1` each walk prints what it reached). A plain old
   string is let through: it cannot change. tsc-ts's parse thread had exactly one such reference a
   file (the loader's `ExternalModuleIndicatorOptions`, kept by the file's parse options): the file
   now keeps a copy made inside the arena.

`Object.isFrozen` of an object made inside a shared worker's arena and not reached by a publish is
true under garnet and false under Node: the one difference a program can see (CLAUDE.md, known
remaining items).

A shared worker cannot be started inside an arena (its start runs the young collection that makes
its parent's cells old, which an arena holds off): a TypeError.

## As measured (tsc-ts, the TypeScript 6.0.3 compiler project, type check only)

The parse thread's work on a file (read, parse, bind) in an arena
(`benchmarks/tsc_ts_native/patches`, the hook `ParallelParse.scope`; `TSC_TS_ARENA=0` runs the
same build without), nine alternating runs, medians of the processes' own counters:

| | without | with | |
| --- | ---: | ---: | ---: |
| parse workers, instructions | 2.903 G | 2.562 G | -11.7% |
| parse workers, cycles | 0.831 G | 0.739 G | -11.0% |
| every worker, instructions | 16.207 G | 15.825 G | -2.35% |
| the other files parsed (ms from load, min / median of 15) | 36.4 / 40.7 | 35.0 / 38.0 | |
| exit (ms from load, min / median of 15, a loaded machine) | 240.6 / 246.0 | 238.2 / 244.0 | |

`ts_arena_end` is 3.6% of the parse workers' samples where the publish's walk was 19%. Each worker
runs one more young collection (its first arena's).

## Checked by

- `tests/conformance/exhaustive/gc/arena_plain.ts`: an ordinary process: the arena's values after the
  collections that follow, a cell of the arena that keeps a young cell made before it, maps, sets,
  closures, a large array, nested arenas, a throw, writes afterwards, three hundred small arenas.
  Also run under `TSAOT_GC_YOUNG_THRESHOLD` 500 and 20000, `TSAOT_GC_PROTECT`, `TSAOT_GC_ZAP` and a
  1 MB full threshold.
- `tests/conformance/exhaustive/node/worker_arena.ts`: three shared workers, five trees each built
  in an arena (a nested arena and a dropped tree inside), published and read by the parent; the
  worker's writes after the publish are TypeErrors; its own state outside the arenas stays its own.
  Also under `TSAOT_ARENA_CHECK=1`, `TSAOT_PUBLISH_PROTECT=1` and a young threshold of 300.
- tsc-ts with the hook: the compiler project's reports under three option sets, the skeleton check,
  the protect modes, and the corpus with two checkers, all with `TSAOT_ARENA_CHECK=1`.

## Not done

- An arena in a checker process (the checker of a huge file parses it in full itself) and on one
  thread (`--singleThreaded`, where the young collections of the parse are 13% of it): the hook is
  only set for parse threads.
- The pass still visits every cell once for its generation byte and its stamp; the mark bits could
  be set a word at a time.
- The worker-entry rewrite of the exporter does not accept a top-level interface that names a class
  of the same module (found by the fixture; a class works).
