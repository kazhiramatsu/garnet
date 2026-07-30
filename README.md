# Garnet

Garnet is an experimental ahead-of-time compiler for TypeScript. It turns a
typed TypeScript entry file and its static imports into:

1. a C source file; and
2. a native executable.

The resulting program does not need Node.js, Rust, or a JavaScript VM at
runtime. Garnet is useful when fast startup, predictable native deployment, or
whole-program AOT optimization matters. It currently supports a substantial
TypeScript/JavaScript subset; it is not yet a drop-in replacement for Node.js,
React, or the complete JavaScript language.

## Quick start

### Requirements

You need these tools to build Garnet from a checkout:

- Node.js and npm, for the TypeScript front end;
- Rust and Cargo, for the analyzer and C emitter;
- a C compiler available as `cc`, such as Clang or GCC;
- Bash and standard Unix build tools.

Programs that use `fetch` additionally need the libcurl development library.
No system mimalloc installation is needed: Garnet builds its vendored copy
statically by default.

### 1. Build the compiler

```bash
bash scripts/setup.sh
```

The setup script installs the exporter dependencies, builds the exporter and
Rust analyzer, and precompiles the runtime. Re-running it is safe.

### 2. Create a TypeScript program

```bash
mkdir -p /tmp/garnet-demo
cat > /tmp/garnet-demo/hello.ts <<'TS'
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

Top-level statements are the program entry point, just as they are in an ES
module. A function named `main` is not called automatically.

### 3. Compile and run it

```bash
./garnet -o /tmp/garnet-demo/hello.c /tmp/garnet-demo/hello.ts
/tmp/garnet-demo/hello
```

Expected output:

```text
sum 1..10 = 55
```

The compile command writes both `/tmp/garnet-demo/hello.c` and the native
executable `/tmp/garnet-demo/hello`.

## Everyday commands

The `garnet` driver runs the TypeScript exporter, AOT analyzer, C emitter, and C
compiler as one command.

| Command | Result |
|---|---|
| `./garnet src/main.ts` | Write `main.c` and `main` in the current directory |
| `./garnet -o build/app.c src/main.ts` | Write `build/app.c` and `build/app` |
| `./garnet -c src/main.ts` | Emit C only; do not compile or link it |
| `./garnet -S src/main.ts` | Print generated C to standard output |
| `./garnet --untyped src/main.ts` | Compile supported code without type-driven optimization |
| `./garnet --profile src/main.ts` | Build with symbols and frame pointers for profiling |
| `./garnet --rt-stats src/main.ts` | Print runtime allocation, GC, and lookup counters at exit |
| `./garnet --help` | Show all driver options and environment variables |

The output executable always uses the C output name without its `.c` suffix.
Parent directories supplied through `-o` are created automatically.

## Compile a multi-file program

Pass one `.ts` entry file. Garnet follows its static imports and bundles the
reachable TypeScript modules into the generated C file.

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
./garnet -o build/square.c src/main.ts
./build/square
```

This prints `144`. Relative imports, re-exports, module initialization order,
and top-level await are covered by the bundler test suite. Dynamic `import()`
is not supported.

The public driver currently requires the entry file itself to end in `.ts`.
That entry may statically import `.tsx` modules.

## Typed and untyped modes

Typed mode is the default and the intended fast path. Garnet asks the
TypeScript checker to validate all user modules before using their types for
specialization. If the program has a type error, compilation stops instead of
optimizing from an invalid type assumption.

```bash
./garnet src/main.ts
```

Use untyped mode when you deliberately want JavaScript-style `any` behavior for
otherwise supported code:

```bash
./garnet --untyped src/main.ts
```

Untyped mode boxes values and disables type-driven optimization, so it is
usually slower. It does not make unsupported syntax or missing host APIs
available.

## What works today

The supported subset includes the features needed by the conformance and
benchmark programs, including:

- functions, closures, classes, inheritance, accessors, and erased generics;
- arrays, objects, strings, symbols, Map, Set, WeakMap, and WeakSet;
- exceptions, iterators, generators, async generators, Promise, and
  async/await;
- JSON, RegExp, and HTTPS `fetch` through libcurl;
- static ES module graphs, re-exports, cycles, and top-level await;
- an experimental classic-JSX path and a small TypeScript React/Pages Router
  SSR fixture.

Unsupported language constructs are reported at compile time rather than
silently ignored. The most important current limitations are:

- BigInt, decorators, `using`/`await using`, tagged templates, `new.target`,
  `import.meta`, and dynamic imports are not implemented;
- JSX is a deliberate classic subset, and the included React and Pages Router
  code is an SSR test fixture rather than full framework compatibility;
- JSDoc and `@ts-check` are not implemented as an additional type-checking
  mode;
- Garnet is not currently a general Node.js runtime, and dynamic code
  generation such as `eval` is outside the AOT model.

See [TypeScript syntax coverage](docs/syntax_coverage.md),
[known conformance gaps](tests/conformance/KNOWN_GAPS.md), and
[standard-library coverage](docs/stdlib_coverage.md) before adopting Garnet for
a larger program. The [JSX, React subset, and Pages Router SSR
design](docs/jsx_react_ssr_design.md) describes the exact server-rendering
boundary.

To compile and run the repository's JSX/SSR example:

```bash
./garnet -o build/react-ssr.c tests/bundler/react_subset/entry.ts
./build/react-ssr
```

## Native deployment

A normal native build links the Garnet runtime and the vendored mimalloc source
into the executable. RegExp and Unicode support are linked only when the
generated program needs them. A program using `fetch` links libcurl.

The executable has no Node.js, Rust, or Garnet compiler dependency at runtime,
but it may still depend on platform libraries:

- the system C library is used unless your toolchain performs a fully static
  libc link;
- libcurl and its transport dependencies are required when `fetch` is used;
- the exact dynamic library set depends on the target compiler and operating
  system.

In other words, Garnet produces one application executable, but a completely
static binary is a toolchain and platform decision. Garnet does not force
static libc linkage.

To use the libc allocator instead of the vendored static mimalloc:

```bash
TSAOT_USE_MIMALLOC=0 ./garnet -o build/app.c src/main.ts
```

## Build and runtime configuration

The common configuration variables are:

| Variable | Purpose |
|---|---|
| `TSAOT_CC` | C compiler command and flags; default: `cc -O2` |
| `TSAOT_USE_MIMALLOC=0` | Use the libc allocator instead of vendored mimalloc |
| `TSAOT_ANALYZER=rust\|ts\|native` | Select the analyzer; normal builds use `rust` |
| `TSAOT_RT_STATS_FILE=path` | At application runtime, append enabled runtime counters to a file |

For example:

```bash
TSAOT_CC="clang -O3" ./garnet -o build/app.c src/main.ts
```

Production builds enable property inline caches, batched GC roots,
escape-guided pretenuring, the moving nursery, adaptive aging, and movable
Promise/coroutine cells by default. Their diagnostic kill switches are listed
by `./garnet --help`; they are intended for testing and performance
investigation rather than normal application configuration.

## Troubleshooting

### `exporter not built` or `analyzer not built`

Run the setup step again from the repository:

```bash
bash scripts/setup.sh
```

### TypeScript diagnostics stop the build

Fix the type errors for the optimized path. If the program intentionally relies
on `any`-style behavior, retry with `--untyped`.

### `UNSUPPORTED` appears

The source contains legal TypeScript whose runtime behavior Garnet does not yet
implement. Check the file and line in the diagnostic and consult the coverage
documents above. Do not bypass this check for production code: it protects
against silently generating an incorrect executable.

### Linking fails only when using `fetch`

Install the libcurl development package for the target platform. The driver
adds `-lcurl` only when the generated C contains fetch support.

### Inspecting generated code or runtime behavior

Use `-c` or `-S` to inspect the generated C. Use `--rt-stats` for GC,
allocation, property-cache, and lookup counters, and `--profile` for native
sampling tools.

## Performance expectations

Garnet is designed to remove work that can be proven unnecessary before the
program starts: boxing in typed numeric code, dynamic method dispatch, property
lookup, and some non-escaping allocations. This can help startup-bound and
statically typed workloads. Highly dynamic or untyped programs use the boxed
runtime and may not benefit.

Treat performance as workload-specific and benchmark the program you plan to
ship. The repository keeps historical measurements and optimization notes in
[benchmark results](docs/bench_results.md); current regression budgets can be
run with:

```bash
bash scripts/run_benchmarks.sh
```

## Developing Garnet

Run the bounded full CI workflow:

```bash
bash scripts/ci_par.sh
```

It builds compiler components once, caps Cargo parallelism, runs ordinary
correctness checks in bounded waves, and isolates GC stress and timed
benchmarks. Useful focused gates are:

```bash
bash scripts/gate.sh conf all
bash scripts/gate.sh unit
bash scripts/gate.sh bundler
bash scripts/gate.sh gc
```

The main directories are:

| Directory | Contents |
|---|---|
| `exporter/` | TypeScript compiler API front end and TS-to-IR lowering |
| `analyzer/` | Rust analysis, optimization, and C emission |
| `runtime/` | Native JavaScript-value, object, async, and GC runtime |
| `third_party/` | Vendored dependencies, including mimalloc |
| `tests/` | Conformance, bundler, runtime, GC, and regression tests |
| `benchmarks/` | Correctness and performance workloads |
| `docs/` | Design decisions, implementation notes, and coverage details |

The pipeline is:

```text
TypeScript entry + static imports
    -> typed whole-program IR
    -> escape/devirtualization/AOT optimization
    -> C source
    -> native executable linked with the Garnet runtime
```

The public project name is **Garnet**. Some internal executable names,
environment variables, and source identifiers still use `tsaot`, the former
project name.

## License

[MIT](LICENSE)
