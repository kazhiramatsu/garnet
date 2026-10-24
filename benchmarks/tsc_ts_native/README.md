# tsc-ts compiled by garnet

[vercel-labs/tsc-ts](https://github.com/vercel-labs/tsc-ts) is a TypeScript
port of tsgo (TypeScript 7), built natively by scriptc. This directory builds
the same source with garnet (`docs/tsc_ts_native_design.md`), so the two
AOT compilers can be compared on one program.

- `garnet/main.ts`: the entry, tsc-ts's `src/main.ts` with one thread (it
  spawns workers from its own URL, `new Worker(new URL(import.meta.url))`,
  which garnet does not build). The compiler's sources are unmodified.
- `garnet/node_*.ts`, `garnet/scriptc_*.ts`: the Node and scriptc modules
  tsc-ts imports (`node:fs`, `node:path`, `node:os`, `node:perf_hooks`,
  `node:worker_threads`, `node:child_process`, `@scriptc/threads`,
  `@scriptc/types`), mapped by `tsconfig.json`'s `paths`: synchronous file
  calls, POSIX `dirname`, one available CPU (so the checkers default to
  one), no workers or child processes, `publish` as the identity.
- `garnet/prelude.ts`, `garnet/globals.d.ts`: `process` and `Buffer` (the
  parts tsc-ts uses), imported first by the entry.
- `host.c`: the primitives the shims stand on, registered as the global
  `__garnetHost` (file system, arguments, environment, clocks, exit, the
  UTF-8 length and UTF-16LE writes `Buffer` needs).

Build (the checkout is copied, not changed; `exporter/exporter.js` and
`analyzer/target/release/tsaot` must be built):

```sh
TSAOT_NATIVE_CC='cc -O2 -gline-tables-only -fno-omit-frame-pointer' \
  bash scripts/build_tsc_ts_native.sh /path/to/tsc-ts build/tsc_ts_native
```

Build it optimized as above: at -O0 the transformer's visitor recursion
overflows the 8 MB main thread stack on large projects.

The build is profile-guided (`docs/pgo_design.md`): an instrumented build
compiles the TypeScript compiler project (`build/typescript_603`, with the
lib directory from `TSC_TS_LIB_DIR` or the checkout's `@scriptc` package)
once, and the profile, written to `<work>/default.pgo` and recorded in
`build.json`, guides the final build. `TSAOT_PGO=off` builds plain,
`TSAOT_PGO=<file>` applies a given profile, `TSAOT_PGO_TRAIN='<cmd>'` trains
with another command (the instrumented executable is `$TSAOT_PGO_BIN`).

The generated C is built as parallel units (`docs/build_split_design.md`):
the giant run-once functions (the module initializer, the large `create*`
factories) are units of their own compiled at -O0, the rest at
`TSAOT_NATIVE_CC` with ThinLTO, and each unit's object is cached by content
in `build/unit-cache`, so a rebuild compiles only the units that changed.
`TSAOT_NATIVE_UNITS=0` builds one C file instead (more than twice as long);
there `TSAOT_NATIVE_COLD_O0=1` marks the same functions `optnone`.

Run with the lib files of scriptc's TypeScript package (`TSC_TS_LIB_DIR`),
for example on the TypeScript 6.0.3 compiler project. Checker threads are
forked processes (`docs/fork_workers_design.md`): `--checkers N` forks N-1
checkers, and without `--checkers` tsc-ts picks its default from
`availableParallelism()`, so one-thread measurements pass `--singleThreaded`
(or `--checkers 1`):

```sh
TSC_TS_LIB_DIR=/path/to/tsc-ts/node_modules/@scriptc/cli-darwin-arm64/dist/lib/typescript/lib \
  build/tsc_ts_native/tsc-ts -p src/compiler/tsconfig.json --singleThreaded ...
```
