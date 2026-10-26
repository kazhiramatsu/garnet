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
  does not implement yet, the build stops and names the file and line. Garnet
  refuses rather than guesses. The few places where a compiled program can
  behave differently from Node.js are listed in
  [Known differences](#known-differences-from-nodejs).
- **Proven on a compiler.** Built with Garnet,
  [tsc-ts](https://github.com/vercel-labs/tsc-ts), a TypeScript port of the
  TypeScript 7 compiler, type-checks and emits the TypeScript compiler's own
  sources 5–9% faster than scriptc's native build of the same code, 21–27%
  faster than tsgo (the Go compiler it was ported from), and 3–7× faster than
  the same code on Node.js. See [Performance](#performance).

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

## Performance

### The benchmark: a TypeScript compiler, compiled four ways

[tsc-ts](https://github.com/vercel-labs/tsc-ts) is a TypeScript port of
[tsgo](https://github.com/microsoft/typescript-go), the Go implementation of
the TypeScript 7 compiler: 246 files and 11 MB of strictly typed TypeScript,
written by Vercel Labs to be compiled natively by their scriptc compiler. The
same source runs on Node.js, and Garnet compiles it unmodified. That gives one
large, real program in four executable forms: Garnet's native build, scriptc's
native build, the JavaScript build on Node.js, and the Go original.

The task is to type-check the compiler project of TypeScript 6.0.3
(`src/compiler`: 78 source files and 10 MB of TypeScript, plus the standard
library's declaration files) and emit its 78 JavaScript files. Every
configuration below produces 78 files and no diagnostics. Garnet's, scriptc's
and Node.js's outputs are byte-identical. tsgo's differs in 7 of the 78 files
by a few lines, because tsgo inlines constant enum members where its
TypeScript port emits the member access; that is a difference between the port
and its upstream, not between compilers of the port.

### Results

Wall-clock time, the median of seven interleaved runs:

| Configuration | Garnet | Garnet, no profile | scriptc 0.4.0 | tsgo 7.0.2, Go PGO | tsgo 7.0.2 | Node.js 25.2 |
|---|---:|---:|---:|---:|---:|---:|
| Default settings | **0.49 s** | 0.56 s | 0.50 s | 0.67 s | 0.67 s | 3.23 s |
| Four checkers | **0.41 s** | 0.48 s | 0.43 s | – | – | 3.04 s |
| One thread | **0.97 s** | 1.18 s | 1.07 s | 1.23 s | 1.24 s | 3.22 s |

Total CPU time (user + system, all processes and threads) and peak memory:

| Configuration | Garnet | Garnet, no profile | scriptc 0.4.0 | tsgo 7.0.2, Go PGO | tsgo 7.0.2 | Node.js 25.2 |
|---|---:|---:|---:|---:|---:|---:|
| CPU time, default settings | **1.61 s** | 1.85 s | 1.85 s | 2.09 s | 2.21 s | 6.80 s |
| CPU time, one thread | **0.95 s** | 1.17 s | 1.05 s | 1.52 s | 1.58 s | 6.73 s |
| Peak memory, one thread | 629 MB | 629 MB | **394 MB** | 469 MB | 483 MB | 769 MB |

The rows are:

- **Default settings**: each program as it runs out of the box. tsc-ts (under
  Garnet, scriptc and Node.js) picks its checker count from the machine's
  parallelism, ten here; tsgo picks its own.
- **Four checkers**: `--checkers 4`, the best setting for tsc-ts on this
  machine, where only four of the ten cores are performance cores. tsgo has no
  equivalent option.
- **One thread**: `--checkers 1` for tsc-ts under Garnet and scriptc, which run
  in a single process then; `--singleThreaded` for tsgo and for Node.js (with
  `--checkers 1`, Node.js still parses on worker threads and took 3.26 s).

What the numbers say:

- At a fixed number of checkers, Garnet's build is 5% (four checkers) to 9%
  (one thread) faster than scriptc's, and uses 10–13% less CPU time. At the
  default settings the two are within the measurement's noise of each other.
- Garnet's build is 27% faster than tsgo at the default settings and 21% faster
  with one thread, with 23–38% less CPU time. Go's profile-guided optimization
  changed tsgo's time by at most 1% here.
- Garnet's build is 3.3× faster than Node.js with one thread and 6.6× faster at
  the default settings.
- Garnet's profile-guided build is 12–18% faster than its build without a
  profile. Without a profile, Garnet is still ahead of tsgo but about 10%
  behind scriptc.
- Garnet's one-thread build uses the most memory of the three native builds.
  With several checkers, Garnet's checkers are forked processes, so a
  per-process peak is not comparable and is not shown.

### Conditions

- Measured on October 25, 2026 on an Apple M5 Mac (4 performance and 6
  efficiency cores, 32 GB) running macOS 26.5.1, with a load average between
  3 and 5 from other work. The seventeen configurations were run in rounds,
  each configuration once per round, seven rounds; each table entry is the
  median of its seven runs.
- **Garnet**: commit `17de039`, built as [Reproducing the measurements](#reproducing-the-measurements)
  shows: the front end given tsc-ts's own tsconfig (`"strict": true`), the C
  compiled by Apple clang at `-O2` as parallel units with ThinLTO, profile-guided
  by a training run on this same workload. The "no profile" column is the same
  build with `TSAOT_PGO=off`. Outside Node.js, tsc-ts needs a host for
  `node:fs`, `process` and workers; Garnet's build provides it with the Node library (`lib/node`) and shims
  and the small C host in `benchmarks/tsc_ts_native/`, where each checker is a
  forked process that shares the parsed program with the main process. That
  host is part of the benchmark; the `garnet` command does not include it yet.
- **scriptc**: tsc-ts commit `c002e8e` (October 20, 2026) built by its own
  `npm run build:native` with scriptc 0.4.0 (`--optimization=speed`).
- **tsgo**: the typescript-go commit that tsc-ts ports, `2bd066d8` (July 7,
  2026, reporting `Version 7.0.2`), built with Go 1.26.0, plain and with
  `go build -pgo` on a CPU profile of three runs of this same workload. The
  npm preview `@typescript/native-preview` 7.0.0-dev.20260707.2 produced
  identical output and took 0.70 s at the default settings.
- **Node.js**: v25.2.1 running tsc-ts's JavaScript build (`tsc` with
  `--target es2024 --module nodenext`).
- The compilers were given the same arguments: the project
  `src/compiler/tsconfig.json`, `--composite false --incremental false
  --declaration false --declarationMap false --emitDeclarationOnly false
  --isolatedDeclarations false --sourceMap false --pretty false`, and an
  `--outDir`.

### Reproducing the measurements

Everything below runs from the Garnet checkout, after [Quick start](#quick-start)
has built Garnet. The profile-guided build needs Clang and `llvm-profdata`
(Xcode Command Line Tools on macOS); tsgo needs Go.

1. Get tsc-ts at the measured commit, with its dependencies. They include
   scriptc 0.4.0 and the TypeScript 7 lib files that every build below reads.

   ```bash
   git clone https://github.com/vercel-labs/tsc-ts.git
   git -C tsc-ts checkout c002e8e02f462bea45f87067baaaaf646372f4be
   (cd tsc-ts && npm ci)
   ```

2. Get the workload: the TypeScript repository at v6.0.3, with its
   dependencies, at the path Garnet's scripts expect.

   ```bash
   git clone --branch v6.0.3 --depth 1 https://github.com/microsoft/TypeScript.git build/typescript_603/source
   (cd build/typescript_603/source && npm ci)
   ```

3. Build tsc-ts with Garnet. The script copies the checkout's sources next to
   the host (the checkout is not modified), exports the program with tsc-ts's
   tsconfig, writes the C as units, builds an instrumented executable, trains
   it on the workload from step 2 with one checker, and builds the final
   executable with that profile. It takes two to three minutes on this machine
   and writes `build/tsc_ts_native/tsc-ts`. The default C flags are `-O0` for
   debugging builds, so pass the measured ones:

   ```bash
   TSAOT_NATIVE_CC='cc -O2 -gline-tables-only -fomit-frame-pointer' \
     bash scripts/build_tsc_ts_native.sh tsc-ts build/tsc_ts_native
   # the build without a profile:
   TSAOT_PGO=off TSAOT_NATIVE_CC='cc -O2 -gline-tables-only -fomit-frame-pointer' \
     bash scripts/build_tsc_ts_native.sh tsc-ts build/tsc_ts_native_plain
   ```

4. Run it. The lib files come from scriptc's package inside the tsc-ts
   checkout.

   ```bash
   export TSC_TS_LIB_DIR=$PWD/tsc-ts/node_modules/@scriptc/cli-darwin-arm64/dist/lib/typescript/lib
   cd build/typescript_603/source
   time ../../tsc_ts_native/tsc-ts -p src/compiler/tsconfig.json \
     --composite false --incremental false --declaration false --declarationMap false \
     --emitDeclarationOnly false --isolatedDeclarations false --sourceMap false --pretty false \
     --outDir /tmp/tsc-ts-out --checkers 4
   cd ../../..
   ```

5. Build the others.

   ```bash
   # scriptc's native build: tsc-ts/packages/tsc-ts/dist/tsc
   (cd tsc-ts/packages/tsc-ts && npm run build:native)

   # the JavaScript build for Node.js: tsc-ts/packages/tsc-ts/dist-node/tsc-ts/src/main.js
   (cd tsc-ts/packages/tsc-ts && npx tsc --outDir dist-node --rootDir .. --target es2024 \
     --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node src/main.ts)

   # tsgo at the commit tsc-ts ports, plain and profile-guided
   git clone https://github.com/microsoft/typescript-go.git
   git -C typescript-go checkout 2bd066d87f5bafd315be9f40889d0a60b9e58e0b
   (cd typescript-go && go build -o ../tsgo ./cmd/tsgo)
   (cd build/typescript_603/source && for i in 1 2 3; do
      ../../../tsgo -p src/compiler/tsconfig.json --composite false --incremental false \
        --declaration false --declarationMap false --emitDeclarationOnly false \
        --isolatedDeclarations false --sourceMap false --pretty false \
        --outDir /tmp/tsgo-out --pprofDir /tmp/tsgo-pprof; done)
   go tool pprof -proto /tmp/tsgo-pprof/*-cpuprofile.pb.gz > tsgo.pprof
   (cd typescript-go && go build -pgo=../tsgo.pprof -o ../tsgo-pgo ./cmd/tsgo)
   ```

6. Compare. `scripts/tsc_ts_compare.sh` runs the given configurations in
   interleaved rounds on the workload, adds the project and emit options,
   prints the medians of wall, user and system time and the peak memory, and
   checks every configuration's output against the first.

   ```bash
   TSC_TS_LIB_DIR=$PWD/tsc-ts/node_modules/@scriptc/cli-darwin-arm64/dist/lib/typescript/lib \
   bash scripts/tsc_ts_compare.sh 7 \
     "garnet=$PWD/build/tsc_ts_native/tsc-ts --checkers 4" \
     "scriptc=$PWD/tsc-ts/packages/tsc-ts/dist/tsc --checkers 4" \
     "tsgo=$PWD/tsgo-pgo" \
     "node=node $PWD/tsc-ts/packages/tsc-ts/dist-node/tsc-ts/src/main.js --checkers 4"
   ```

   The script changes into the workload's directory, so give it absolute
   paths, as above.

### Not every program gets faster

Garnet is not faster than V8 on every program. The unmodified TypeScript 6.0.3
compiler, written for a JIT and full of dynamic patterns, takes 4.06 s for the
same project as a Garnet executable against 3.37 s on Node.js (measured on
October 21, 2026). Garnet removes work that it can prove unnecessary, so typed,
statically structured code gains the most, and highly dynamic or untyped code
gains the least. Benchmark the program you plan to ship.

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
(including named groups and Unicode mode), Date (construction, getters and
`toISOString`), Promise, Symbol, Proxy, Reflect, typed arrays with ArrayBuffer
and SharedArrayBuffer, Atomics, and TextEncoder/TextDecoder.

Element-wise loops over typed arrays (`for (let i = 0; i < a.length; i++)
a[i] = ...`) are compiled as counted loops with direct element access, which
the C compiler vectorizes; a fill-and-transform loop over a million elements
ran 1.7× faster than on Node.js (0.17 s against 0.29 s), where before it ran
slower (0.32 s). A loop that calls a function or boxes a value takes the
general path.

Math's transcendental functions (`exp`, `log`, `sin`, `tanh`, `pow` and the
others) are V8's own implementations, a C translation of V8's fdlibm port
compiled with the same defaults as Node's V8, so their results agree with
Node.js on the same platform to the last bit (`tests/math_v8_parity` checks
every function over 100,000 inputs per range against the installed node).

Typed JSON: `import { JSON } from "garnet:json"` gives `JSON.parse<T>(text)`,
which validates the text against `T` while parsing, builds each object in
the property order of the type and drops undeclared properties. A mismatch
is a TypeError naming the path (`$.user.tags[2] must be number, received
string`; `$.id is missing`), and `T` can also come from the contextual type
(`const u: User = JSON.parse(text)`). Object types, arrays, tuples,
`Record<string, T>`, unions, literal types, enums, `null` and recursive type
aliases are supported; a type JSON cannot carry (a class, a `Date`, a `Map`,
a method) is rejected at compile time. The parser is TypeScript compiled by
Garnet (`lib/garnet/json_core.ts`): a document of 20,000 records parsed 25
times took 0.26 s typed, where the untyped `JSON.parse` of the same document
takes 0.16 s in Garnet's runtime and 0.20 s on Node.js (including Node's
startup). `parseWithSchema` takes the schema string explicitly, and under
Node.js the same import resolves to a polyfill (`parse<T>` without the
compiler's schema is the plain parse there).

Numeric arrays: `import * as nd from "garnet:ndarray"` is an n-dimensional
array module in the style of numpy (`docs/ndarray_design.md`): a contiguous
typed buffer with a shape, `float64` by default and `float32`, the integer
dtypes, `float16` and `bfloat16` as alternatives, the rank in the type
(`zeros([3, 4])` is a `Matrix`, `tensor([1, 2])` a `Vector`), elementwise
arithmetic with scalar operands, `dot`, `outer`, `transpose`, slicing and
concatenation, reductions, lazy `rows()`/`entries()` generators, and a seeded
`Random` (xoshiro128**) whose stream is the same under Node.js. The module is
TypeScript compiled with your program, so its loops are the compiled loops of
the section above; a shape mismatch throws a `DimensionError`.

The GPU: `import { Library, GpuBuffer, CommandBuffer } from "garnet:metal"`
compiles Metal Shading Language kernels at run time and runs them over the
program's `SharedArrayBuffer`s without a copy (`docs/metal_design.md`): a
`CommandBuffer` encodes any number of dispatches for one commit and one wait,
and the results are in the program's typed arrays when `wait()` returns. The
runtime loads Metal on the first use, so nothing is linked and a program that
does not use it pays nothing; under Node.js (or without Metal) `available()`
is false and the classes throw. Wrong arguments are rejected before any Metal
call, and a failed command buffer or a kernel that does not compile throws
with the system's message.

Language models: `garnet:llama` runs a llama-architecture model from a
llama.cpp GGUF file (`docs/llm_inference_design.md`): the reader, the F32,
F16, Q8_0 and Q4_0 tensors, the SentencePiece tokenizer in the file, the
forward pass, a sampler, and a thread pool over `node:worker_threads`;
`garnet:llama_metal` runs the same model on the GPU through `garnet:metal`,
one command buffer per token. TinyLlama-1.1B-Chat Q8_0 on an M5 generates
24 tokens/s on one CPU thread, 72 on eight (llama.cpp's CPU path: 65 and 72)
and 101-106 on the GPU, from TypeScript (`benchmarks/llama2/llama_gguf.ts`,
`benchmarks/llama2/run_gguf.sh` compares the CPU path's text with Node.js
byte for byte and the GPU's logits with the CPU's).

Not available yet: `Intl` and the locale methods (`toLocaleString`,
`localeCompare`), `DataView`, `WeakRef` and `FinalizationRegistry`, the Set
algebra methods (`union` and the others), `Date` parsing and setters, and the
replacer argument of `JSON.stringify`. A method Garnet does not implement is
rejected at compile time with a message that names it; nothing is silently
skipped. Without `-p`, Garnet type-checks against the ES2020 library, so newer
APIs do not type-check unless your tsconfig selects a newer `lib`.

### Input and output

Programs can print and fetch:

- `console.log`, `console.info` and `console.debug` write to standard output,
  and `console.warn` and `console.error` to standard error, formatted the way
  Node.js formats values;
- `fetch` works over HTTP and HTTPS through libcurl, with `Response`, `Headers`,
  `AbortController` and `AbortSignal.timeout`.

### Node.js modules

A program written for Node.js imports its modules as usual, with `node:` or
the bare names, and Garnet compiles its own implementations of them, written
in TypeScript (`lib/node`) over a small C core, together with the program.
Available so far:

| Module | What works |
|---|---|
| `node:path` | the complete POSIX module (`join`, `resolve`, `relative`, `parse`, `format`, ...) |
| `node:os` | `platform`, `arch`, `type`, `release`, `hostname`, `homedir`, `tmpdir`, `cpus`, `availableParallelism`, `totalmem`, `freemem`, `loadavg`, `uptime`, `userInfo`, `endianness`, `EOL`, `constants` |
| `node:process` and the `process` global | `argv` (`argv.slice(2)` is the program's arguments, as in Node), `env`, `cwd`, `chdir`, `exit` and `exitCode` with the `exit` event, `pid`, `platform`, `arch`, `version`, `hrtime`, `uptime`, `memoryUsage`, `cpuUsage`, `nextTick`, `emitWarning`, `kill`, `umask`, `stdout` and `stderr` with `write` |
| `node:events` | `EventEmitter` with Node's ordering, `once`, `prependListener`, the `error`, `newListener` and `removeListener` behavior, `once()` and `on()` helpers |
| `node:util` | `format`, `inspect`, `promisify`, `callbackify`, `inherits`, `deprecate`, `debuglog`, `isDeepStrictEqual`, `types`, `stripVTControlCharacters` |
| `node:worker_threads` | `Worker` (a forked process running the named module's top level: `import.meta.url` or `new URL("./w.js", import.meta.url)`, resolved at compile time), `isMainThread`, `parentPort`, `workerData`, `threadId`, messages, 'error'/'exit', `terminate`, `ref`/`unref`; no `MessageChannel` |
| `node:assert`, `node:assert/strict` | every assertion, `AssertionError` with `code`, `actual`, `expected`, `operator` and `generatedMessage` |
| `node:perf_hooks` and `performance` | `performance.now()` and `timeOrigin` |
| `node:buffer` and the `Buffer` global | `from`, `alloc`, `allocUnsafe`, `concat`, `compare`, `byteLength`, `isBuffer`, `isEncoding`; `toString`, `write`, `slice`/`subarray` (shared memory), `fill`, `copy`, `equals`, `compare`, `indexOf`/`lastIndexOf`/`includes`, the integer and float readers and writers, `swap16/32/64`, `toJSON`; the encodings utf8, utf16le, latin1, ascii, base64, base64url, hex; `atob`, `btoa`, `isUtf8`, `isAscii` |
| `node:fs` and `node:fs/promises` | the synchronous API (`readFileSync` ... `writeSync`, `mkdtempSync`, `rmSync` recursive, `readdirSync` with `withFileTypes` and `recursive`, descriptors), the promise API and the callback API over it, `Stats`, `Dirent`, `constants`; no streams or `watch` yet |
| `node:string_decoder` | `StringDecoder` across chunk boundaries |
| `node:timers`, `node:timers/promises` and the timer globals | `setTimeout`, `setInterval`, `setImmediate` and their `clear` functions on Garnet's event loop, returning `Timeout`/`Immediate` objects with `ref`, `unref`, `hasRef` and `refresh`; `process.nextTick` runs before the promise reactions of a turn; the promise forms, `setInterval` as an async iterator, `scheduler.wait`/`yield`; `process.on("beforeExit")` and `"exit"` |
| `node:stream`, `node:stream/promises` | `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough` with Node's paused and flowing modes, `highWaterMark` and backpressure, `construct`, `destroy` and `autoDestroy`, `pipe`, `pipeline` (a generator may be a stage), `finished`, `Readable.from`, async iteration, `toArray` |
| `node:fs` streams, `node:tty` | `createReadStream`/`createWriteStream` (`open`, `ready`, `start`/`end`, `bytesRead`/`bytesWritten`, `pending`), `process.stdin`/`stdout`/`stderr` as streams (`isTTY`, `columns`, `rows`, the cursor methods), `isatty` |
| `node:readline`, `node:readline/promises` | `createInterface` over any readable (LF, CRLF and CR endings), `'line'`/`'close'`, `question`, `prompt`, `pause`/`resume`, async iteration, the cursor functions; no terminal mode (lines are read whole) |
| `node:child_process` | `spawnSync`, `execSync`, `execFileSync` (status, signal, `input`, `env`, `cwd`, `timeout`, `stdio`), `spawn`, `exec`, `execFile` over the event loop (`stdin`/`stdout`/`stderr` streams, `'spawn'`, `'exit'`, `'close'`, `'error'`, `kill`), `util.promisify(exec)`; no `fork` |
| `node:crypto` | `createHash`/`hash` (md5, sha1, sha256, sha512), `createHmac`, `pbkdf2`/`pbkdf2Sync`, `randomBytes`, `randomInt`, `randomUUID`, `randomFill`, `getRandomValues`, `timingSafeEqual`; no ciphers, keys or signatures |
| `node:url`, `node:querystring` | the WHATWG `URL` and `URLSearchParams` (also as globals), `fileURLToPath`, `pathToFileURL`, `domainToASCII` (ASCII hosts only: no punycode), the legacy `url.parse`/`format`/`resolve`, `querystring.parse`/`stringify`/`escape`/`unescape` |

The `process`, `Buffer` and `performance` globals, the timer functions,
`URL`, `URLSearchParams`, `queueMicrotask`, `atob`, `btoa` and `global` exist
once a program names them or imports a `node:` module; without `@types/node`
they are typed as Node types them (`setTimeout` returns a `Timeout`, not a
number). Only the modules behind the globals a program names are compiled
with it, and the stream classes behind `process.stdout`, `process.stdin` and
`fs.createReadStream` only when the program names those (a program that does
not gets a minimal `process.stdout` that writes, and a clear error from the
others). `encodeURIComponent`, `decodeURIComponent`, `encodeURI` and
`decodeURI` are always there. A method a module does
not have yet is a type error at compile time (the modules are type-checked
with your program), never a missing value at run time.

Coming next: `worker_threads` generalized from the fork workers, `net` and
`http`. The file system's promise and callback forms complete a microtask
after the call, not from the loop's poll phase, so they run before a timer
due at the same time; a file stream's open and close complete on a later turn
(as Node's asynchronous calls do), its reads and writes are synchronous. Sockets (`net`, `http`) and `fs.watch` are not
planned yet. `util.inspect` ignores its options and `util.format`'s `%o` shows
no hidden properties.

Watch out for one trap. TypeScript's default declarations include browser
globals, so code that uses `structuredClone`, the `crypto` global or
`localStorage` type-checks and compiles, then stops when it runs, with an
error such as `ReferenceError: structuredClone is not defined`.

An uncaught exception prints the error to standard error and ends the program
with a non-zero exit status; so does a promise rejection nothing handles
(`tsaot: Unhandled promise rejection: ...`), as in Node.js.

### JSX and server-side rendering (experimental)

Imported `.tsx` modules can use a classic JSX subset, which compiles to
`React.createElement` calls. The repository includes a small React and Pages
Router server-rendering example; from the checkout, run:

```bash
garnet -o build/react-ssr.c tests/bundler/react_subset/entry.ts
./build/react-ssr
```

This is a test fixture for server rendering, not full React compatibility.

### Known differences from Node.js

Garnet's conformance suite compiles several hundred programs and compares
their output with Node.js, and a difference is treated as a bug. The known
exceptions are these. The first three only arise when a program's types are
wrong, which the TypeScript checker cannot see through an `any`:

- A class field declared as `number` and read before its first assignment
  gives `0`; Node.js gives `undefined`.
- A `number` parameter that receives no argument, in a call made through an
  `any`-typed value with fewer arguments, reads as `0`; Node.js gives
  `undefined`.
- An `any` value that holds something other than a number, assigned to a
  `number` variable, reads as `NaN`; Node.js keeps the value.
- An integer loop counter that passes 2⁵³ can differ in its last bits, because
  Garnet keeps it as a 64-bit integer where V8 rounds to a double.
- A `number` class field that every typed store in the program assigns an
  integer is stored as an integer. A store of a fraction into it through an
  `any`-typed receiver then throws a TypeError naming the field, where Node.js
  stores the fraction. `TSAOT_INT_STORE_FIELDS=0` keeps such fields doubles.

Compiling with `--untyped` removes the first three, at a cost in speed.

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
| `runtime/` | The native runtime: values, objects, strings, async, garbage collector; `ts_ieee754.c` is V8's Math (BSD and Sun notices in the file) |
| `lib/garnet/` | Garnet's own TypeScript modules (`garnet:*`) |
| `tests/` | Conformance tests against Node.js, plus bundler, runtime and GC tests |
| `benchmarks/` | Correctness and performance workloads, including the tsc-ts host |
| `docs/` | Design notes and the progress log (`docs/TODO.md`) |
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
