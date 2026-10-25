# Garnet

Garnet is an ahead-of-time compiler for TypeScript. It type-checks your program
with the official TypeScript compiler, optimizes the whole program using those
types, and turns it into C and then into a standalone native executable. The
executable runs without Node.js or any other JavaScript engine.

Garnet is experimental, but it already compiles large real programs, including
the TypeScript compiler itself. It implements most of the JavaScript language
and standard library. It does not yet provide Node.js APIs such as files,
timers or `process` (see [What your program can use](#what-your-program-can-use)).

- **Native executables.** One `.ts` entry file and everything it imports become
  one executable, with nothing to install on the target machine and no JIT
  warm-up.
- **Types make it fast.** Garnet sees the whole program at once. Where the
  types allow it, numbers stay unboxed, method calls go straight to their
  target, and short-lived objects never reach the heap.
- **Loud, not wrong.** If a program has type errors, or uses something Garnet
  does not implement yet, the build stops and names the file and line. Garnet's
  rule is to refuse rather than guess; the few known exceptions are listed in
  [known gaps](tests/conformance/KNOWN_GAPS.md).
- **Proven on a compiler.** Built with Garnet,
  [tsc-ts](https://github.com/vercel-labs/tsc-ts) (a TypeScript port of the
  TypeScript 7 compiler) takes 4–6% less time than scriptc's native build of
  the same source, and runs about 3× faster than the same code on Node.js. See
  [Performance](#performance-tsc-ts).

## Quick start

### Requirements

- Node.js and npm: the front end runs on Node.js and uses the TypeScript 5.9
  compiler API, which the setup script installs;
- Rust and Cargo: the optimizer and C code generator are written in Rust;
- a C compiler available as `cc` (Clang or GCC; profile-guided builds need
  Clang);
- Bash and the usual Unix tools.

Garnet is developed on macOS on Apple Silicon, and its scripts also support
Linux. Programs that call `fetch` also need the libcurl development library.

### 1. Build Garnet

```bash
git clone https://github.com/kazhiramatsu/garnet.git
cd garnet
bash scripts/setup.sh
export PATH="$PWD:$PATH"
```

`setup.sh` installs the front end's npm dependencies, builds the front end and
the Rust analyzer, and precompiles the runtime. Running it again is safe. The
last line puts the `garnet` command on your `PATH` for the current shell. Add
the checkout itself to `PATH`; do not copy or symlink the script, because it
finds its tools next to itself.

### 2. Write a program

```bash
mkdir -p ~/garnet-demo && cd ~/garnet-demo
cat > hello.ts <<'TS'
function sumTo(n: number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total += i;
  }
  return total;
}

console.log(`sum 1..10 = ${sumTo(10)}`);
TS
```

A program starts at its top-level statements, as an ES module does. A function
named `main` is not called automatically.

### 3. Compile and run

```bash
garnet hello.ts
./hello
```

```text
sum 1..10 = 55
```

`garnet hello.ts` writes the generated C (`hello.c`) and the executable
(`hello`) to the current directory, and prints a few lines of build information
as it goes.

## Performance: tsc-ts

[tsc-ts](https://github.com/vercel-labs/tsc-ts) is a TypeScript port of tsgo,
the Go implementation of the TypeScript 7 compiler: 246 files and 11 MB of
TypeScript, written to be compiled natively by Vercel Labs' scriptc. Garnet
compiles the same compiler sources without modification, so the two
ahead-of-time compilers can be compared on one large real program.

The benchmark type-checks and emits the compiler project of TypeScript 6.0.3
(`src/compiler`, 78 output files). Both native builds write byte-identical
output.

| Checkers (`--checkers N`) | scriptc 0.4.0 | Garnet | Garnet's time vs. scriptc |
|---|---:|---:|---:|
| 1 | 1.042 s | **0.977 s** | 0.94× |
| 4 | 0.429 s | **0.406 s** | 0.95× |
| 10 (tsc-ts's default on this machine) | 0.476 s | **0.455 s** | 0.96× |

For reference, tsc-ts's own JavaScript build took 3.27 s on Node.js with one
checker, and 3.05 s with four, on the same machine (measured separately, during
the same work). With one checker, Garnet's native build is about 3.3× faster.

How it was measured:

- Apple M5 (4 performance and 6 efficiency cores), macOS, October 2026, Garnet
  commit `0467f35`. Each value is the median wall-clock time of five
  interleaved runs.
- Garnet's build passes a tsconfig with `"strict": true` to the front end, as
  `garnet -p` does, so the [strict-profile optimizations](#turn-on-strict) were
  on. It compiles the C as parallel units with ThinLTO at `-O2`, as `--units`
  does.
- Garnet's tsc-ts is a [profile-guided build](#profile-guided-builds), trained
  on this same workload. In the last comparison with one checker, Garnet's
  build without a profile took 1.23 s and the trained build 1.02 s. A profile
  trained on a different project kept about half of that gain.
- Outside Node.js, tsc-ts needs a host for `node:fs`, `process` and workers.
  Garnet's build replaces the entry file and those modules with the shims and
  C host in [`benchmarks/tsc_ts_native/`](benchmarks/tsc_ts_native/README.md),
  where each checker is a forked process that shares the parsed program. This
  host is part of the benchmark; the public `garnet` driver does not include
  it yet.

### Against tsgo

tsc-ts is a port of tsgo, so the Go compiler itself is the other natural
comparison: the same algorithms and data structures, Go's compiler and runtime
against Garnet's generated C and runtime.

| Configuration | tsgo 7.0.2 | tsgo 7.0.2 with Go PGO | Garnet | Garnet's time vs. tsgo with PGO |
|---|---:|---:|---:|---:|
| Default settings (tsc-ts: 10 checkers) | 0.660 s | 0.640 s | **0.440 s** | 0.69× |
| Garnet with `--checkers 4` | | | **0.400 s** | 0.63× |
| One thread (`tsgo --singleThreaded`; Garnet `--checkers 1`) | 1.210 s | 1.190 s | **0.940 s** | 0.79× |

How it was measured:

- October 25, 2026, the same machine, Garnet commit `17de039` built and trained
  as above. Each value is the median wall-clock time of nine interleaved runs
  (`scripts/tsc_ts_compare.sh`); the load average was about 3.
- tsgo was built from the typescript-go commit that tsc-ts ports (`2bd066d8`,
  July 7, 2026, reporting `Version 7.0.2`) with Go 1.26.0, plain and with
  `go build -pgo` on a CPU profile of three runs of this same workload
  (`--pprofDir`), so both profile-guided builds are in-sample. The npm preview
  `@typescript/native-preview` 7.0.0-dev.20260707.2 produced identical output
  and took 0.70 s.
- All tsgo builds emit identical files. tsc-ts's output differs from tsgo's in
  7 of the 78 files by a few lines (tsgo inlines constant enum members where
  tsc-ts emits the member access): a difference between the port and its
  upstream, not between the compilers of the port.
- Garnet's build without a profile took 0.52 s at the default settings, still
  ahead of tsgo with PGO.
- Total CPU time at the default settings: tsgo 2.2 s, Garnet 1.6 s (1.0 s with
  four checkers). Peak memory with one thread, where both run in one process:
  tsgo about 470 MB, Garnet 629 MB. With forked checkers the figure for
  Garnet's main process alone (143 to 225 MB) leaves out the checkers.

Garnet is not faster than V8 on every program. The unmodified TypeScript 6.0.3
compiler, written for a JIT and full of dynamic patterns, takes 4.06 s for the
same project as a Garnet executable against 3.37 s on Node.js (measured on
October 21, 2026). Garnet removes work that it can prove unnecessary, so typed,
statically structured code gains the most, and highly dynamic or untyped code
gains the least. Benchmark the program you plan to ship.

To reproduce the tsc-ts numbers, see
[`benchmarks/tsc_ts_native/README.md`](benchmarks/tsc_ts_native/README.md). The
measurements and how they evolved are in
[`docs/published_graphs_design.md`](docs/published_graphs_design.md),
[`docs/pgo_design.md`](docs/pgo_design.md) and
[`docs/single_thread_vs_scriptc.md`](docs/single_thread_vs_scriptc.md).

## Everyday commands

| Command | What it does |
|---|---|
| `garnet src/main.ts` | Writes `main.c` and the executable `main` to the current directory |
| `garnet -o build/app.c src/main.ts` | Writes `build/app.c` and `build/app`, creating `build/` if needed |
| `garnet -p tsconfig.json src/main.ts` | Uses your project's compiler options (see [Turn on `strict`](#turn-on-strict)) |
| `garnet -c src/main.ts` | Writes the C file only |
| `garnet -S src/main.ts` | Prints the generated C to standard output |
| `garnet --untyped src/main.ts` | Ignores the types and compiles with plain JavaScript semantics (slower) |
| `garnet --help` | Lists every option and environment variable |

The executable is named after the C file, without the `.c`.

### Programs with several files

Pass the entry file. Garnet follows its static imports and compiles every
module it reaches into one executable.

```ts
// src/math.ts
export function square(n: number): number {
  return n * n;
}
```

```ts
// src/main.ts
import { square } from "./math";

console.log(square(12));
```

```bash
garnet -o build/square.c src/main.ts
./build/square        # prints 144
```

Re-exports, import cycles, module initialization order and top-level `await`
work. The entry file must be a `.ts` file; it may import `.tsx` modules. Dynamic
`import()` is not supported.

### Typed and untyped mode

By default Garnet trusts your types, so it first has the TypeScript checker
confirm them. If any module has a type error, the build stops rather than
optimizing on a false assumption.

`--untyped` compiles the program as if every value were `any`. It follows plain
JavaScript semantics, accepts programs with type errors, and is usually much
slower. It does not make unsupported features available.

## Getting the fastest code

### Turn on `strict`

Garnet's strongest type-driven optimizations, such as specializing generic
classes and functions for the types they are used with, are enabled only when
the whole program type-checks under TypeScript's full `strict` profile. Without
`-p`, Garnet turns on `strictNullChecks` only. Use a tsconfig with
`"strict": true`:

```json
{ "compilerOptions": { "strict": true } }
```

```bash
garnet -p tsconfig.json src/main.ts
```

`-p` also brings in the project's module resolution, libraries and ambient
declarations. Garnet still compiles from the entry file; it does not build
project references or emit declarations.

### Profile-guided builds

A profile records which paths of your program are hot, and the C compiler
optimizes for them. Create one by running your program once in a typical way:

```bash
garnet --pgo-train '"$TSAOT_PGO_BIN"' src/main.ts
```

Garnet builds an instrumented executable, runs the quoted shell command with
`$TSAOT_PGO_BIN` set to that executable, writes `default.pgo` next to the entry
file, and builds the program again with it. From then on, every build of that
entry file applies `default.pgo` automatically, and the driver's last line says
`(profile-guided: ...)`. Commit the file to share it. `--pgo off` ignores it,
and `--pgo <file>` uses another profile.

Train on the work the program really does: a profile from an unrepresentative
run can make the program slower than no profile at all. Edits make parts of a
profile stale (those functions fall back to normal optimization), so train
again after significant changes. Profile-guided builds need Clang and
`llvm-profdata`; on macOS, both come with the Xcode Command Line Tools.

### Large programs

`--units` writes the C as many units, compiles them in parallel with ThinLTO,
and caches each compiled unit, so a rebuild only recompiles the units that
changed. `--no-lto` links faster, but calls between units are no longer
inlined. The compiles use every CPU core; `TSAOT_UNITS_JOBS=N` limits them.

### Looking inside

- `-S` prints the generated C, and `-c` writes it without compiling it.
- `--rt-stats` prints runtime counters (allocation, garbage collection,
  property lookups) when the program exits.
- `--profile` keeps symbols and frame pointers for profilers such as `perf`,
  Instruments or `sample`.

## What your program can use

### Language

Most of modern TypeScript works: functions and closures; classes with
inheritance, accessors, static members, `#private` fields and abstract methods;
generics; enums and namespaces; destructuring, spread and rest; optional
chaining and `??`; exceptions with `try`/`catch`/`finally`; iterators and
generators; `async`/`await`, async generators and `for await`; tagged
templates; `Proxy`, `Reflect` and symbols; and ES module graphs.

These are rejected at compile time for now:

- BigInt (`10n`);
- decorators;
- `using` and `await using`;
- `accessor` class fields;
- `new.target` and `import.meta`;
- dynamic `import()`, import attributes, and `import x = require(...)`;
- namespaced JSX names such as `<svg:rect>`.

### Built-in objects

String, Array, Map, Set, WeakMap, WeakSet, Math, Number, Object, JSON, RegExp
(including named groups and Unicode mode), Date (a core subset), Promise,
Symbol, Proxy, Reflect, typed arrays with ArrayBuffer and SharedArrayBuffer,
Atomics, and TextEncoder/TextDecoder.

Not available yet: `Intl` and locale formatting (`toLocaleString`), `DataView`,
`WeakRef` and `FinalizationRegistry`. Without `-p`, Garnet type-checks against
the ES2020 library, so newer APIs such as `Set.prototype.union` do not
type-check. [Standard-library coverage](docs/stdlib_coverage.md) has the
details.

### Input and output

Programs can print and fetch:

- `console.log`, `console.info` and `console.debug` write to standard output,
  and `console.warn` and `console.error` to standard error, formatted the way
  Node.js formats values;
- `fetch` works over HTTP and HTTPS through libcurl, with `Response`, `Headers`,
  `AbortController` and `AbortSignal.timeout`.

There is no API yet for command-line arguments, environment variables, files,
standard input or timers, and Node.js modules (`process`, `require`, `node:fs`
and so on) are not available. Node.js compatibility is planned; see
[its design](docs/node_compat_design.md).

Watch out for one trap. TypeScript's default declarations include browser
globals, so code that uses `setTimeout`, `queueMicrotask`, `performance`,
`structuredClone`, `atob`/`btoa` or `crypto` type-checks and compiles, then
stops when it runs, with an error such as
`ReferenceError: setTimeout is not defined`. Others, such as `new URL(...)`,
are rejected at compile time.

An uncaught exception prints the error to standard error and ends the program
with a non-zero exit status.

### JSX and server-side rendering (experimental)

Imported `.tsx` modules can use a classic JSX subset, which compiles to
`React.createElement` calls. The repository includes a small React and Pages
Router server-rendering example; from the checkout, run:

```bash
garnet -o build/react-ssr.c tests/bundler/react_subset/entry.ts
./build/react-ssr
```

This is a test fixture for server rendering, not full React compatibility; see
the [JSX and SSR design](docs/jsx_react_ssr_design.md).

## Deploying the executable

The executable needs no Node.js, Rust or Garnet at run time. The Garnet runtime
and the bundled mimalloc allocator are linked in statically, and the RegExp and
Unicode tables only when the program uses them. A hello-world executable is
about 640 KB on macOS/arm64.

Like any C program, it uses the platform's C library, and a program that calls
`fetch` needs libcurl and its TLS libraries on the target machine. A fully
static binary is a toolchain decision; pass your own compiler and flags through
`TSAOT_CC`:

```bash
TSAOT_CC="clang -O3" garnet -o build/app.c src/main.ts   # another compiler or flags
TSAOT_USE_MIMALLOC=0 garnet -o build/app.c src/main.ts   # the libc allocator
```

## Troubleshooting

**`exporter not built` or `analyzer not built`.** Run `bash scripts/setup.sh`
in the checkout.

**`Refusing to compile ill-typed input`.** The TypeScript errors printed above
it stop the build. Fix them, or use `--untyped` if the program deliberately
relies on `any`-style behavior.

**`Cannot find name 'process'`** (or `require`, `Buffer`). Node.js APIs are not
available yet; see [Input and output](#input-and-output).

**`UNSUPPORTED construct(s)`.** The program uses valid TypeScript that Garnet
does not implement yet. Each entry names the file, line and column; rewrite that
spot, or check [What your program can use](#what-your-program-can-use).
`TSAOT_ALLOW_UNSUPPORTED=1` skips the check, but the result can behave
incorrectly, so never use it for real builds.

**`ReferenceError: ... is not defined` when the program runs.** The program uses
a browser or Node.js global that type-checks but is not provided; see
[Input and output](#input-and-output).

**Linking fails only when the program uses `fetch`.** Install the libcurl
development package.

**`--pgo-train needs clang` or `needs llvm-profdata`.** Build with Clang
(`TSAOT_CC="clang -O2"`), and set `TSAOT_LLVM_PROFDATA` to the path of
`llvm-profdata` if Garnet cannot find it.

## Environment variables

| Variable | Purpose |
|---|---|
| `TSAOT_CC` | C compiler and flags (default: `cc -O2`) |
| `TSAOT_USE_MIMALLOC=0` | Use the libc allocator instead of the bundled mimalloc |
| `TSAOT_PGO=auto\|off\|<file>` | Same as `--pgo` |
| `TSAOT_UNITS_JOBS=N` | Number of parallel compiles with `--units` |
| `TSAOT_RT_STATS_FILE=<path>` | Set when running a `--rt-stats` program: append the counters to this file instead of standard error |

The many other `TSAOT_*` variables listed by `garnet --help` switch individual
optimizations off for testing and investigation. Garnet used to be called
tsaot, which is why these variables, the Rust binary and some internal names
still use that name.

## Developing Garnet

```text
TypeScript entry file + its static imports
  → exporter/   TypeScript checker, lowering to IR
  → analyzer/   whole-program analysis and optimization, C emission (Rust)
  → cc          compiles the C and links it with runtime/
  → native executable
```

| Directory | Contents |
|---|---|
| `exporter/` | TypeScript front end: type checking and lowering to IR |
| `analyzer/` | Analysis, optimization and C emission in Rust (the cargo binary is `tsaot`) |
| `runtime/` | The native runtime: values, objects, strings, async, garbage collector |
| `lib/garnet/` | Garnet's own TypeScript modules (`garnet:*`) |
| `tests/` | Conformance tests against Node.js, plus bundler, runtime and GC tests |
| `benchmarks/` | Correctness and performance workloads, including tsc-ts |
| `docs/` | Design notes, coverage, benchmark results, and the progress log (`docs/TODO.md`) |
| `analyzer_ts/` | The frozen self-hosted analyzer, kept as a benchmark and parity oracle |
| `third_party/` | Vendored mimalloc |

Garnet is tested against Node.js: the conformance suite compiles each test
program with Garnet and compares its output with V8's.

```bash
bash scripts/gate.sh conf all   # conformance against Node.js
bash scripts/gate.sh unit       # unit tests
bash scripts/gate.sh bundler    # multi-module programs
bash scripts/ci_par.sh          # the full CI, including benchmark budgets
```

The full CI is heavy. Forced-GC stress runs only when asked for, with
`TSAOT_CI_GC_STRESS=1` or `bash scripts/gate.sh gc`. `TSAOT_PHASE_TIMINGS=1`
makes the analyzer report its phase timings on standard error. The working
handbook for contributors is [`docs/agent_workflow.md`](docs/agent_workflow.md).

## License

[MIT](LICENSE)
