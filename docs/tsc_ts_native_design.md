# tsc-ts compiled by garnet

## Goal

Compile vercel-labs/tsc-ts (a TypeScript port of tsgo 7.0.2, built natively
by scriptc) with garnet and run it single-threaded on the compiler project
of TypeScript 6.0.3. Then the two AOT compilers can be compared on the same
source. Today's comparison (docs/TODO.md, "Reference: other native TypeScript
compilers") mixes compiler designs: garnet's 4.06 s runs the JS-era 6.0.3
sources, tsc-ts's 1.09 s (one thread) runs tsgo's design, and only garnet's
1.2x against V8 on the same code says anything about code generation. tsc-ts
is also a second large program written for a static subset (classes, typed
arrays, few dynamic features), the kind of input garnet's type-driven
lowering is for.

Pinned input: vercel-labs/tsc-ts c002e8e (246 files, 11 MB of TypeScript);
scriptc 0.4.0 builds it in 50 s.

## What garnet lacks (exporter probe)

`exporter.js --project` over `src/main.ts` (target ES2024, the repository's
settings) exports 10,959 functions and stops at 148 constructs:

| construct | sites |
|---|---|
| typed arrays: `new Int32Array` 45, `Uint8Array` 36, `Float64Array` 11, `Uint32Array` 10 (and `Uint16Array` views) | 102 |
| imports of `node:fs`, `node:path`, `node:os`, `node:perf_hooks`, `node:worker_threads`, `node:child_process`, `@scriptc/threads` | 21 |
| threads: `new SharedArrayBuffer` 9, `new Worker`, `new URL`, `import.meta` | 12 |
| `new TextEncoder` 5, `new TextDecoder` 6 | 11 |
| `Number.prototype.toExponential` | 1 |

The source also uses `Atomics` (load 27, store 15, compareExchange 4, add 4,
or 1), `subarray` 11, `fill` 6, `copyWithin` 1, and the global `process`
(env, argv, exit, stdout/stderr writes, cwd, platform, execPath, hrtime,
memoryUsage).

## Plan (slices)

1. **Typed arrays** (`docs/typed_arrays_design.md`): ArrayBuffer and
   SharedArrayBuffer (one buffer, no other thread can see it), the element
   views Int8/Uint8/Int16/Uint16/Int32/Uint32/Float32/Float64 with
   construction from a length, an array-like or a buffer with offset and
   length, element coercion, `length`/`byteLength`/`byteOffset`/`buffer`,
   `subarray`, `set`, `fill`, `copyWithin`, `slice`, iteration, `join`;
   then in-line element access for receivers typed as a view; `Atomics` with
   single-thread semantics. The existing Uint16Array (tsv storage, no
   buffer) becomes a view.
2. **Text and number formatting**: TextEncoder/TextDecoder (UTF-8),
   `toExponential`.
3. **Host**: `benchmarks/tsc_ts_native/`: TypeScript shims for the seven
   modules (tsconfig `paths`; `publish` returns its argument, `Worker`
   throws, `isMainThread` is true), a C host registering the file system
   and `process` as globals (as the TypeScript 6.0.3 host registers
   `__garnetSystem`), and a build script.
4. **Bring-up**: `--singleThreaded` on small projects, then the 6.0.3
   compiler project; outputs against tsc-ts's own Node build and scriptc's
   binary; every bug a conformance fixture.
5. **Measure** against scriptc's binary on one thread, profile, and feed the
   pattern work.

Each slice keeps the usual gates; the typed arrays need GC stress (buffers
are payloads, views alias them) and the stack check if any view is
stack-allocated.
