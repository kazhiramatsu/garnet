# Parallel parsing on forked workers (F4): the shape of the problem

Session 352. With the single-thread slices of `docs/single_thread_vs_scriptc.md`
in, tsc-ts with four forked checkers compiles the TypeScript compiler
project in 0.77 s (was 0.94 s); scriptc takes 0.43 s. The timeline
(`TSC_TS_TIMELINE=1`, a loaded run, so the absolute numbers are high):

| phase (main, serial) | when |
|---|---|
| process start to `main` | 24 ms |
| the loader walks (parses) all 249 files | 26 -> 214 ms |
| the checker is created (every file bound, the globals merged), the program published | 214 -> 305 ms |
| four checkers forked; `checker.ts` checked and emitted by one of them | 305 -> 1069 ms |

Everything before the fork is serial: parsing 190 ms, binding and
publication 90 ms. scriptc's tsc-ts parses and binds ahead on parse
threads (`parallel-parse.ts`: the main thread hands out chunks of files,
the threads parse and bind them and send back the bound `SourceFile`
graphs, published by reference through `@scriptc/threads`; node and symbol
ids come from a shared `Atomics` counter). Garnet's build leaves
`parallelParse.spawn` unset. Parallel parsing and binding would take about
220 ms off the critical path: the other files' parse (140 ms) and most of
the binding (the loader's and the checker's), leaving `checker.ts`'s own
parse, bind, check and emit.

## Why a fork cannot do it as it is

The fork model (`docs/fork_workers_design.md`) shares memory one way: a
child sees the parent's heap as it was at the fork and sends back plain
data (the codec refuses functions, Maps, class instances). A parse child
must send back a bound `SourceFile` graph: class instances (nodes,
symbols, tokens), strings, arrays, Maps, and plain objects. Two routes:

- **A shared region at a fixed address.** The parent reserves a region
  (a file-backed `mmap(MAP_SHARED | MAP_FIXED)`), the child allocates
  everything it creates while parsing into it (a bump allocator beside the
  cage: cells in one part, payloads in another), and sends back the
  references; the addresses are the same in the parent. When parsing is
  done the parent maps the same file private at the same address
  (copy-on-write) before forking the checkers, which then write into their
  own copies as they do today. The collector treats a region cell as a
  heap cell that is never freed: marked and scanned (its fields may hold
  references into the parent's heap once the checker writes them), the
  write barrier remembering it as an old cell, a full collection scanning
  the region.
- **The process-local tables.** This is the crux. An object's shape is an
  id into the process's shape table, assigned in order of first use; the
  inline caches compare shape ids; a dynamic property name is an interned
  key id, also assigned in order of first use. A child's ids diverge from
  the parent's as soon as it creates a shape or interns a key the parent
  has not, and two children diverge from each other. A region object with
  such an id would be read by the parent through the wrong shape or the
  wrong key: silent corruption. The parse phase alone creates 16,967 of
  the compile's 16,982 shapes and 5,785 dynamic property additions
  (`TSAOT_RT_STATS`, `--listFilesOnly`), so "no new shapes in a parse
  child" is not a fallback that would ever hold. The tables themselves
  would have to be shared: a shape table and an intern table in shared
  memory, ids allocated atomically, the transition lookups synchronized
  (a lock in shared memory on the slow path of creating a transition; the
  common path reads the shared table). Class descriptors, prototypes and
  literal layouts are created at startup in the parent in a fixed order
  and are the same in every process already.

So F4 is: shared shape and intern tables (with their lookups), the region
allocator and mapping flip, the collector's treatment of region cells, a
child's inbound messages (`LoadMessage`) and outbound references, and the
shim's `parallelParse.spawn`. Several days, with the soundness of the
shared tables to prove under the GC stress gates in parent and children.

## What to do first

Both configurations share the serial prefix: the parse and bind of
every file in the main process (280 ms here) and the parse, bind, check
and emit of `checker.ts`. Making parsing and binding faster on one thread
shortens the critical path in both, needs no new machinery, and is where
garnet is still about 2x scriptc per phase. The parse-only profile
(`--listFilesOnly`) orders that work. F4 comes after it, with the shared
tables designed first.

## Decision (Kaz, 2026-10-23): standard APIs only

Parallelism in garnet follows the Web and Node APIs (`worker_threads`,
`SharedArrayBuffer`, `Atomics`, structured clone), not scriptc's
`@scriptc/threads` `publish`, which shares object graphs by reference and
which tsc-ts's parallel parse is written against. The checkers' parallelism
(F3) stays within the standard surface (workers with plain-data messages,
a shared counter) and is what garnet generalizes: the inbound message
channel, `new Worker(file)` with Node's start-fresh semantics, `terminate`,
`MessageChannel`. F4 is not pursued: a parse thread that returns bound
graphs by reference is scriptc's feature, and the part of the gap it
explains (the serial parse and bind before the fork) is accepted. The
one-thread speed of parsing and binding is the lever that remains.
