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

## Host as built (slice 3)

`benchmarks/tsc_ts_native/` (its README): TypeScript shims for the eight
modules tsc-ts imports, mapped by the tsconfig's `paths` (synchronous file
calls, POSIX `dirname`, one available CPU so the checkers default to one, no
workers or child processes, `publish` as the identity); `process` and
`Buffer` (the parts tsc-ts uses) in a prelude the entry imports first; and a
C host that registers the primitives as the global `__garnetHost` (file
system, arguments, environment, clocks, exit, the UTF-8 length and UTF-16LE
writes `Buffer` needs) before the module initializer runs. The entry is
tsc-ts's `src/main.ts` with one thread; the compiler's sources are
unmodified. `scripts/build_tsc_ts_native.sh` copies the checkout's sources
next to the shims (the checkout stays unchanged), exports with that
tsconfig (strict, so the strict type profile), emits, adds the host's
initialization to `main`, and compiles with the tsc recipe
(`TSAOT_NATIVE_COLD_O0=1`: -O2, the few giant functions -O0).

## Bring-up as built (slice 4)

Each defect found on the way was a silent wrong value and is a conformance
fixture now:

- the environment's values (`declare var`, `declare global`, `.d.ts`
  globals such as `process`) read a local nothing assigns:
  `toplevel/ambient_globals`;
- a constructor body reading its parameter properties by name read a local
  nothing assigns: `classes/parameter_property_reads`;
- SROA-inlined constructors and methods called with arguments left out read
  an unrelated caller local for each: `classes/inlined_omitted_arguments`;
- a subclass redeclaring an inherited field (its constructor assigns it)
  under the strict profile read the ancestor's boxed slot as a double, and
  the parser printed `var` for `const`: `classes/redeclared_field_slots`,
  and the conformance suite's strict mode (`TSAOT_CONF_STRICT=1`);
- SROA-inlined methods rewrote the field accesses and calls on `this` only
  at the body's top level (one in an if, a ternary, a loop or a try read an
  unrelated caller local in place of the eliminated object), and mapped a
  parameter the body assigns to the caller's argument local (the assignment
  overwrote the caller's variable): tsc-ts's template literal inference
  (`TemplateMatcher`) crashed and reported false errors;
  `classes/inlined_method_blocks`.

garnet's tsc-ts compiles the TypeScript 6.0.3 compiler project (78 files)
without diagnostics, its output byte-identical to scriptc's binary (whose
output differs from tsc 6.0.3's in 22 files and from tsgo's in 7), and
matches scriptc's diagnostics and outputs on small projects (template
literal types included). A build at -O0 overflows the 8 MB main thread stack
in the transformer's visitor recursion (about 200 KB of frames per level);
the optimized build does not. garnet does not detect a stack overflow (V8
throws a RangeError): a follow-up.

## First measurement (slice 5)

The TypeScript 6.0.3 compiler project, five interleaved rounds, medians,
one thread each (`--singleThreaded`; garnet's tsc-ts has one). V8 runs
tsc-ts's own Node build (the `build` script of its package: `tsc` to
ES2024 modules), the same source.

| | emit | `--noEmit` |
|---|---|---|
| node (V8) | 3.18 s (6.65 s CPU with its helper threads) | 2.29 s |
| scriptc's binary | 1.04 s | 0.65 s |
| garnet | 8.30 s (963 MB) | 5.25 s |

All three emit the same 78 files. garnet is 2.3-2.6x slower than V8 on this
source, where it is 1.2x slower on tsc 6.0.3's (the JS-era design), and 8x
slower than scriptc: tsc-ts is the static subset garnet's type-driven
lowering is for, so the gap is the pattern work's next input (profile the
run, take the worst patterns first).

## Update (Session 353): the Node modules are lib/node

Since Node compatibility N5a the build maps only `node:worker_threads` and the
`@scriptc/*` modules to shims (`benchmarks/tsc_ts_native/garnet/`); `node:fs`,
`node:path`, `node:os`, `node:perf_hooks` and `node:child_process` are the
library's (`lib/node`, `docs/node_compat_design.md`), and `process`/`Buffer`
come from the prelude the exporter generates. `host.c` stays for the worker
shim. The measured configuration is one CPU (`TSAOT_CPUS=1` in the run and in
the PGO training command), the shims' former `availableParallelism() === 1`.
