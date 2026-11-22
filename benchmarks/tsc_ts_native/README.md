# tsc-ts compiled by garnet

[vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts) is a TypeScript
port of tsgo (TypeScript 7), built natively by scriptc. This directory builds
the same source with garnet (`docs/tsc_ts_native_design.md`), so the two
AOT compilers can be compared on one program.

- `garnet/main.ts`: tsc-ts's `src/main.ts` for this build, a Node program: it
  branches on `isMainThread` and starts its checker, parse and reference
  threads with `new Worker(new URL(import.meta.url), { workerData, shared })`
  (`shared: true` for the parse threads: garnet's option, a worker forked into
  a region the main thread reads; Node ignores it). A checker thread gets
  `resourceLimits: { maxYoungGenerationSizeMb: 128 }`: a checker's heap ends
  with it, and with a young budget its run fits in it never collects
  (docs/fork_workers_design.md, the Session 367 update).
- `patches/`: changes to the compiler's sources, applied to the build's copy
  of them (`patches/README.md`): each makes the compiler faster and changes
  nothing it reports. `TSAOT_TSC_TS_PATCHES=0` builds the sources unmodified,
  the program scriptc builds.
- `garnet/scriptc_*.ts`: the `@scriptc/threads` and `@scriptc/types` modules
  (mapped by `tsconfig.json`'s `paths`): `publish` from `garnet:shared`. The
  Node modules (`node:fs`, `node:path`, `node:os`, `node:perf_hooks`,
  `node:child_process`, `node:worker_threads`) are garnet's Node library
  (`lib/node`), and `process`/`Buffer`/`URL` the prelude the exporter generates
  for the program (docs/node_compat_design.md). Measure with `TSAOT_CPUS=1`:
  the library reports the machine's CPUs otherwise, and tsc-ts starts as many
  parse threads.
