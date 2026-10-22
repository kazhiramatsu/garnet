# Native TypeScript compiler workload

`driver.ts` runs the upstream TypeScript 6.0.3 command line through its public
`System` interface. `host.c` supplies synchronous file I/O, directory enumeration,
arguments and process exit. The compiler algorithms are the upstream source;
there is no Node/V8 execution fallback. Default library files remain external
data, located with `GARNET_TSC_LIB_DIR`.

First install the upstream checkout's dependencies and build its `built/local`
compiler and libraries using TypeScript's normal build. Then, from Garnet:

```sh
bash scripts/build_typescript_native.sh /path/to/TypeScript-6.0.3 build/ts-native
```

The script creates an isolated source copy and leaves the supplied checkout
unchanged. `exporter/exporter.js` and `analyzer/target/release/tsaot` must already
be built. `TSAOT_NATIVE_CC` controls generated C optimization; the default is
`cc -O0 -g -fno-omit-frame-pointer` for correctness bring-up, while the runtime
uses `-O2`. Do not interpret an O0 timing as an optimized native comparison.
`TSAOT_NATIVE_STATS=1` instruments both generated C and the runtime. Compiler
flags and the source/library paths are recorded in `build.json`.

The generated C is built as parallel units (`docs/build_split_design.md`):
the huge module initializer and the large `create*` factories are units of
their own compiled at O0, the other functions with `TSAOT_NATIVE_CC` and
ThinLTO, and each unit's object is cached by content in `build/unit-cache`,
so a rebuild compiles only the units that changed. An optimized build:

```sh
TSAOT_NATIVE_CC='cc -O2 -gline-tables-only -fno-omit-frame-pointer' \
  bash scripts/build_typescript_native.sh /path/to/TypeScript-6.0.3 build/ts-native-o2
```

Each O0 unit is recorded in the metadata. Report this mixed optimization
setting when quoting timings; it is not a fully O2 executable.
`TSAOT_NATIVE_UNITS=0` builds one C file instead; there the experimental
`TSAOT_NATIVE_COLD_O0=1` option leaves the same functions at O0.

For the compiler source project, use identical options for both executables:

```sh
python3 scripts/bench_typescript_native.py \
  --native build/ts-native/tsc-native \
  --node-tsc /path/to/TypeScript-6.0.3/built/local/tsc.js \
  --cwd build/ts-native/source --work build/ts-native/results --runs 3 -- \
  -p src/compiler/tsconfig.json --composite false --incremental false \
  --declaration false --declarationMap false --emitDeclarationOnly false \
  --isolatedDeclarations false --sourceMap false
```

The runner checks a deliberate type error's diagnostic/exit code and positive
interface, optional-method and enum-narrowing cases before measuring. It then compares the valid program's stdout and SHA-256 manifest of
all emitted files against Node. A mismatch, failure or timeout stops the run
without reporting a speedup. After one warmup per executable, launches alternate
in AB/BA order. Results include wall/CPU time and per-process peak RSS. Startup,
type checking and emission are included; building Garnet, IR and C is excluded.
`--noEmit` can be supplied for a separately identified check-only workload.

Normal automatic GC remains enabled. The scripts do not force collections or
change collection thresholds. The host's optional `getMemoryUsage` reports peak
RSS rather than Node heap usage, so use the runner's RSS figures for comparison.
Watch mode and the Node module API are outside this synchronous benchmark host.

Pass `--baseline-native /path/to/previous/tsc-native` to compare a saved native
baseline in the same alternating run. Every executable must pass the same
validation and output comparison; `runtime_speedup` compares the native pair.
Build and test jobs should finish before collecting the final timed samples.

The runtime uses paired `ts_setjmp`/`ts_longjmp` helpers. On Darwin they omit
signal-mask save/restore, which JavaScript exceptions do not use. Embedders
needing that behavior can compile with `-DTSAOT_PRESERVE_SIGNAL_MASK=1`.
`TSAOT_FAST_EXCEPTIONS=0` emits the older `setjmp` spelling for the frozen
emitter oracle. Vendored mimalloc is built in release mode; use
`TSAOT_MIMALLOC_DEBUG=1` to retain its upstream debug checks. These settings do
not disable Garnet's runtime assertions or automatic GC.

GC/allocation profiling uses `TSAOT_NATIVE_STATS=1`. Runtime summaries include
allocation counts/bytes by cell kind, scanned array/map elements, mark edges,
root slots and remembered cells. `small_props` counts fresh four-slot property
buffers and reuse from the bounded free list. These counters compile out of
production builds. Runtime-only relinks do not instrument the generated C's
inline frame/PIC counters; do not interpret them as whole-program totals.

Array and Map indexed writes retain a dirty span of 64-entry cards through
nursery aging. Generic writes, reordering, compaction and indices outside the
compact range use a complete scan. The metadata occupies existing alignment
padding on the measured arm64 build. Four-slot property buffers are recycled
up to 65,536 buffers (6 MiB); larger buffers retain the allocator's normal path.
Neither change alters GC thresholds or forces a collection.
