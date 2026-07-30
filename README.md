# garnet — an AOT TypeScript→C compiler that exploits static analysis

garnet compiles a typed subset of TypeScript ahead-of-time to C (and then to a
native binary), using **type + escape + devirtualization analysis** to erase work
that V8 must do at runtime. On typed integer kernels it beats warmed V8; on
startup it wins by ~18x. It is *not* a general JS engine — dynamic/`any` code
falls back to a small NaN-boxing runtime (`ts_rt`) and is not the fast path.

> **Naming:** the project is **garnet**; its cargo binary and internal identifiers
> are still `tsaot` (the former name) — e.g. `analyzer/target/release/tsaot`.
> The source-level rename is deferred, so the commands below invoke `tsaot`.

## Pipeline
```
TypeScript source
  └─ exporter/         (classic `typescript` compiler API)  →  Escape IR (JSON)
       └─ analyzer/    (Rust)
            ├─ devirt        Method calls → Direct / Set / Unknown  (+ vtable slots)
            ├─ call_graph    Tarjan SCC ordering
            ├─ interproc     Andersen-style points-to + connection-graph escape
            ├─ codegen       per-site strategy: Stack / FrameArena / CallerArena / Heap
            └─ emit_c        → C, choosing per value:
                               int64 (integer-specialized) / double (unboxed) /
                               tsv (dynamic) / typed struct (specialized class)
  └─ runtime/ts_rt.c   NaN-boxing values, object model, operators, mark/sweep GC
  └─ gcc -O2           → native binary
```

## Layout
```
analyzer/    Rust crate (escape analysis, devirt, codegen, C emitter). `cargo build --release`.
exporter/    TS→IR exporter (Node + TypeScript). `npm install` then build via tsc.
runtime/     ts_rt: the lightweight JS runtime the emitted C links against.
benchmarks/  kernels (.ts + reference .js) + manifest.tsv (expected output + time budget).
tests/       analyzer unit-test suites + e2e/runtime checks + sample TS programs.
scripts/     ci.sh (full gate) + run_runtime_tests / run_unit_tests / run_benchmarks.
docs/        design notes per component + ci_procedure.md + bench_results.md.
```

## Quick start

Prerequisites: **Node.js** (with npm), **Rust** (cargo), and a **C compiler**
(`cc` / `gcc` / clang). Native application builds compile and statically link
the repository-owned mimalloc source by default; no system mimalloc installation
or target archiver is required. Set `TSAOT_USE_MIMALLOC=0` to build with the libc
allocator instead.

```bash
# 1. build everything in one shot: exporter deps + tsc, analyzer (cargo), runtime object
bash scripts/setup.sh

# 2. smoke-test the toolchain end to end
printf 'console.log("hello, garnet " + [1,2,3].reduce((a,b)=>a+b,0));\n' > /tmp/hello.ts
./garnet -o /tmp/hello.c /tmp/hello.ts   # exporter → analyzer → cc
/tmp/hello                               # → hello, garnet 6

# 3. (optional) run the full CI gate: build + runtime tests + unit tests + benchmarks
bash scripts/ci.sh
```

## Compile one TS file

The `./garnet` driver runs the whole pipeline (exporter → analyzer → cc) in one step:
```bash
./garnet foo.ts              # emit foo.c and build the native `foo` (then run ./foo)
./garnet -c foo.ts           # emit the C only (skip compile/link)
./garnet -S foo.ts           # write the generated C to stdout
./garnet --untyped foo.ts    # compile everything as `any` (JS semantics, no type-driven opt)
```
Key env vars: `TSAOT_CC` (default `cc -O2`),
`TSAOT_ANALYZER=rust|ts|native`, and `TSAOT_USE_MIMALLOC=0` to opt out of the
default statically linked allocator; see `./garnet --help`.

### Production optimization defaults

Normal `./garnet` builds use the measured production configuration:

| Feature | Default | Diagnostic fallback |
|---|---|---|
| Rust typed analyzer and AOT specialization | on | `--untyped` |
| Four-way property PICs | on | `TSAOT_PROP_PIC=0` |
| Batched GC root frames | on | `TSAOT_FRAME_ROOTS=0` |
| [Escape/lifetime-guided pretenuring](docs/pretenuring_design.md) for proven retained allocations | on | `TSAOT_PRETENURE=0` |
| Generational moving minor GC and bump nursery | on | `TSAOT_DISABLE_MOVING_MINOR=1` or `TSAOT_GC_NURSERY=0` at application runtime |
| [Adaptive one-minor aging grace](docs/adaptive_aging_design.md) | on | `TSAOT_GC_AGE_THRESHOLD=1` for immediate promotion |
| Movable Promise and coroutine cells | on | `TSAOT_GC_MOVE_PROMISE=0` or `TSAOT_GC_MOVE_CORO=0` at application runtime |
| Statically linked mimalloc | on | `TSAOT_USE_MIMALLOC=0` at build time |

GC aging defaults to threshold 2 with runtime feedback. Survivor residency no
longer shortens the next fresh-allocation interval, and cohorts whose aged bytes
overwhelmingly promote temporarily fall back to immediate promotion. Set
`TSAOT_GC_AGING_ADAPTIVE=0` for the fixed threshold policy or
`TSAOT_GC_AGE_THRESHOLD=1` for the legacy immediate-promotion policy.
`TSAOT_GC_ZAP` and `--rt-stats` likewise remain diagnostic-only to avoid adding
work to production hot paths.

Under the hood it is a three-stage pipeline you can also drive by hand:
```bash
cd exporter
node exporter.js ../benchmarks/int_kernel.ts /tmp/p.json /tmp/l.json
../analyzer/target/release/tsaot /tmp/p.json emit > /tmp/out.c
gcc -O2 /tmp/out.c ../runtime/ts_rt.c -I../runtime -o /tmp/out && /tmp/out
```
`tsaot <program.json> escape` and `... report` print the escape result and the
codegen strategy report respectively.

## Current standing vs V8 (see docs/bench_results.md)
| workload | AOT | V8 (warmed) | verdict |
|---|---|---|---|
| integer loop | 378 ms | 519 ms | **AOT wins 1.37x** |
| float loop | 247 ms | 244 ms | tie |
| object loop | ~990 ms | 365 ms | V8 wins 2.7x (needs inlining + SROA) |
| startup | ~1.3 ms | ~22 ms | **AOT wins ~18x** |

## Status
End-to-end working: classes (prefix-layout structs, vtables, devirt, accessors,
parameter properties, super), closures, literals/arithmetic/control-flow, and the
three-layer C emitter (int64 / double / tsv / typed-struct). The CI gate enforces
correctness + performance budgets so further optimization (next: method inlining
+ scalar replacement of aggregates to close the object-kernel gap) proceeds
without regressions.
