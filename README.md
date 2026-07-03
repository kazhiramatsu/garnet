# tsaot — an AOT TypeScript→C compiler that exploits static analysis

tsaot compiles a typed subset of TypeScript ahead-of-time to C (and then to a
native binary), using **type + escape + devirtualization analysis** to erase work
that V8 must do at runtime. On typed integer kernels it beats warmed V8; on
startup it wins by ~18x. It is *not* a general JS engine — dynamic/`any` code
falls back to a small NaN-boxing runtime (`ts_rt`) and is not the fast path.

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
```bash
# build analyzer
cd analyzer && cargo build --release && cd ..
# build exporter
cd exporter && npm install && cd ..
# run the full CI gate (build + runtime tests + unit tests + benchmarks)
bash scripts/ci.sh
```

## Compile one TS file by hand
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
