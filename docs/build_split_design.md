# Native builds in parallel units, with incremental reuse

Session 352, design. Kaz's request: native builds take minutes because the
generated C is one file; split it so it compiles in parallel and only what
changed recompiles.

## Where the time goes

tsc-ts's native build (`scripts/build_tsc_ts_native.sh`, `cc -O2
-gline-tables-only`, one thread per step), measured phase by phase:

| phase | seconds |
|---|---|
| export (node, the exporter on the project) | 13.7 |
| emit (`tsaot ... emit`: analysis and C) | 32.0 |
| the runtime, the host, the adapters | 3.7 |
| **the generated C: 66.7 MB, 1.43 M lines, 22,019 functions** | **151.0** |
| link | 0.1 |
| total | 201 |

The generated C's compile has one hot spot: the module initializer
(`fn_..___module_init_d`, 148,688 lines). The build script marks it and
the two other giant cold functions `optnone` (`TSAOT_NATIVE_COLD_O0`), but
in a `-O2` translation unit the backend still allocates its registers with
the greedy allocator: 65 s of backend time for that one function, 52.5 s of
it in register allocation (`-ftime-trace`). Everything else is 22,000
small functions (median 6 lines, 99th percentile 485).

## What a prototype measured

A post-processor split the generated C into a shared header (types,
prototypes, hidden `extern` declarations of the data), a data unit, a cold
unit (the three `optnone` functions) compiled at `-O0` (the fast register
allocator) and 16 function units of balanced size, compiled ten at a time:

| build | generated-C time | tsc-ts against the one-file build |
|---|---|---|
| one file (today) | 151 s | |
| 16 units, `-O2`, no LTO | 26.3 s | wall 1.042, instructions 1.023 |
| 16 units, ThinLTO (`-flto=thin`) | 20.7 s + 14.0 s link | wall 1.000, cycles 1.000, instructions 0.989 |

Without link-time optimization the calls between units cannot be inlined
(4% slower); ThinLTO imports across units at link time, in parallel, and
the result is as fast as the one-file build. Outputs identical throughout.

Incremental: a one-line edit of tsc-ts's source (`isWhiteSpaceSingleLine`)
changed 144 lines of the generated C, all inside that function (its locals
renumbered); function, literal and site numbers did not move. With the
prototype's size-balanced partition five units changed anyway (the unit
boundaries moved with the function's size): recompiling them took 4.6 s
and the ThinLTO link 13.5 s (its cache helped little, since five of
seventeen modules changed). A stable partition makes a function body's
edit one unit.

## Keeping the inlining

The one-file build inlines across what the split separates. Of the
functions the one-file binary no longer contains (3,115 fully inlined),
719 are called from another unit at 3,968 sites; every one of them has
several callers (median 3, up to 183; median 23 lines, 90th percentile
59), so placing a callee next to its caller cannot help. Two
countermeasures, measured on tsc-ts against the one-file build (eight
pairs each, outputs identical):

- **Inline copies**: a function of at most 60 lines without local statics
  that another unit calls gets a `static inline` copy `<name>__i` in the
  shared header, and every call site calls the copy; the unit keeps the one
  external definition, so a function's address (the function tables,
  `ts_make_fn`) stays unique. tsc-ts: 2,063 copies, a 6.5 MB header.
- **Unit-local functions stay `static`**: a function whose every reference
  (calls, address uses, data, the header's copies) is inside its own unit
  keeps internal linkage, and with it the interprocedural freedom of the
  one-file build (8,251 of 22,124 functions).

| build | generated-C time | wall | cycles | instructions |
|---|---|---|---|---|
| 16 units, no LTO | 26.3 s | 1.042 | 1.039 | 1.023 |
| + inline copies | 26.8 s | 1.017 | 1.016 | 1.005 |
| + unit-local `static` | 29.0 s | 1.006 | 1.011 | 1.004 |
| same, 10 units | 26.3 s | 1.003 | 1.008 | 1.005 |
| same, copies up to 150 lines | 28.7 s | 1.017 | 1.014 | 0.995 |
| same, units refined along the call graph | 27.1 s | 1.011 | 1.012 | 1.005 |
| 16 units, ThinLTO | 20.7 + 14.0 s | 1.000 | 1.000 | 0.989 |
| **ThinLTO + inline copies + unit-local `static`** | **21.5 + 13.1 s** | **0.997** | **0.997** | **0.989** |

Without link-time optimization the two countermeasures take the loss from
4% to about 1%; larger copies lower the instructions further but cost
cycles (more code), and refining the partition along the call graph does
not help: what remains is whole-program work (attribute inference across
functions, layout), which ThinLTO does. With ThinLTO the split build is as
fast as the one-file build, a little faster with the countermeasures.
Startup (the cold unit at `-O0`) costs 6 M cycles more, nothing measurable.

So: native builds and every measurement use ThinLTO with both
countermeasures; a development mode without LTO (about 1% slower, the
fastest rebuilds) is an option of the driver.

## Design

1. **The emitter writes units** (`tsaot <ir> emit --units <dir>`, the
   driver's choice; stdout keeps today's one file, so the parity oracle and
   every small program are unchanged):
   - `prog.h`: the includes, the types, every function's prototype and every
     file-scope object's `extern` declaration, all under hidden visibility;
     the string literals' anonymous structs get named types;
   - `data.c`: the file-scope objects' definitions, `main`;
   - `cold.c`: the giant cold functions (the build script's rule, moved into
     the emitter), compiled at `-O0`;
   - `u_<module>_<k>.c`: the functions of one source module in emission
     order, in chunks of at most about 20k lines. The exporter records each
     function's module (a small IR addition); a unit's name and contents
     then depend only on its module, so editing a function recompiles its
     chunk (and the chunks after it in the same module when its size crosses
     a boundary), never the rest of the program.
   - small functions called from another unit also get a `static inline`
     copy in `prog.h` that every call site uses, and functions referenced
     only inside their unit stay `static` (above);
2. **The driver compiles units in parallel** (one job per core) with
   `-flto=thin`, the cold unit natively at `-O0`, and links with ThinLTO and
   its cache (`-Wl,-cache_path_lto,<dir>`); `--no-lto` (development) links
   the native objects directly. Each unit's object is cached
   under `build/units/` by a hash of the unit, `prog.h`, the compiler
   command and the compiler's version; a header change (a new function, a
   new literal) recompiles every unit, as it must.
3. **Native builds** (`scripts/build_tsc_ts_native.sh`,
   `build_typescript_native.sh`) and `./garnet` for large programs (above a
   size threshold) use it; small programs keep one file, where splitting
   would only add the header's parse to each unit.

What stays serial: export (14 s) and emit (32 s) for tsc-ts. A full native
build would take about 85 s instead of 200, an edit of a function body
about 60 s; both are the next targets (stable numbering for additions, a
parallel emit) once the split works.

## Slices

1. The emitter's unit mode, the module index in the IR, the driver's
   parallel ThinLTO build with the cold unit, the object cache; native build
   scripts on it. Verification: conformance (the driver splits at a forced
   threshold), parity (stdout unchanged), the native builds' outputs, A/B of
   the split builds against one file (time, instructions, peak memory),
   build times full and after an edit.
2. Stable numbering, so adding a function or a literal does not renumber
   the program (the header stops changing on additions).
3. A parallel emit, if the 32 s still dominate.

## Slice 1 as built

Session 352. `tsaot <ir> emit --units <dir>` writes the units and prints
them in build order, largest first (`cold` marks the `-O0` ones); without
`--units` stdout keeps the one file. `scripts/lib/units.sh`
(`tsaot_units_build`) compiles and links them. Both native build scripts
use it by default (`TSAOT_NATIVE_UNITS=0`: one file), `./garnet --units`
builds a program this way (`--no-lto`: native objects, no ThinLTO), and
`TSAOT_CONF_UNITS=1` runs the conformance suite through it.

Where it differs from the design above:

- **The module index.** The exporter records each function's source module
  (`modules`, `functionModules` in the IR), synthetic functions taking the
  module being lowered. The paths are resolved, then made relative to the
  directory that contains every module, so the units do not depend on where
  the project or the build is (the native build scripts copy the project
  into each work directory and give the entry relative to it; before the
  paths were resolved, that one relative name made every path relative to
  `/`, and an edit moved the modules between the bins).
- **The partition.** A module above 20,000 lines gets chunks of its own
  (`m_<stem>_<hash>_<k>.c`, a tail under a quarter of a chunk joining the
  chunk before it); the smaller modules share 16 bins by a hash of their
  path (`bin_<k>.c`): 201 of tsc-ts's 210 modules are smaller, and a unit
  per module would parse the header that many times. tsc-ts: 14 chunks of 9
  modules, 16 bins, the data unit and 4 cold units, 35 in all. `main` and the
  functions without a module (the runtime setup the emitter writes) go to
  `data.c`. Each cold function is a unit of its own (`cold_<name>.c`,
  `-O0 -fno-global-isel`), so tsc-ts's four compile in parallel; the rule
  (at least 10,000 lines, or 2,000 for a `create…` function) moved from the
  build script into the splitter.
- **The inline copies live in the units that call them**, not in the
  header: each unit gets the copies its calls reach, transitively. Editing
  a copied function then recompiles its own unit and its callers' units,
  not the program, and a unit parses only the copies it uses (tsc-ts's
  header: 7.9 MB with the copies, 2.5 MB without). Calls within a unit stay
  direct; the cold units call the originals. Whatever a copy references is
  extern, its own function too when the copy takes the original's address.
- **The cache key** is the unit's text, the header as the compiler sees it
  (preprocessed with its macro definitions, `-E -P -dD`, so a change in
  `ts_rt.h` or a host header reaches every unit; the first version hashed
  `prog.h`'s text and reused stale objects after such a change), the
  compile command, the optimization flags and the compiler's version. A hit
  refreshes the object's time; objects no build used for seven days are
  removed (`TSAOT_UNITS_CACHE_DAYS`).
- **The driver's unit mode is a flag, not a size threshold**: it writes a
  directory where the one-file mode writes `<name>.c`, which scripts may
  expect.

Build times, tsc-ts (`cc -O2 -gline-tables-only -fno-omit-frame-pointer`,
ten cores; seconds; the runtime, host and adapter objects, 3.7 s, are in the
units column):

| build | export | emit | units | link | total |
|---|---|---|---|---|---|
| one file (before) | 13.7 | 32.0 | 154.7 | 0.1 | 201 |
| units, empty cache | 15.8 | 34.2 | 21.0 | 14.9 | 86.0 |
| units, nothing changed | 14.4 | 33.8 | 4.6 | 0.3 | 53.2 |
| units, after a one-line edit | 14.5 | 33.5 | 6.3 | 13.1 | 67.5 |

The edit (`isWhiteSpaceSingleLine`, the design's example) changed one unit
of 35 and nothing else; the ThinLTO link redoes the modules that import
from it. The TypeScript compiler (60 units) builds in 103.5 s from an empty
cache (export 19.8, emit 38.2, units 20.9, link 24.5), against about five
minutes for one file.

A/B against the one-file builds (`-O2`; the giant cold functions at `-O0`
in both, `ts_setup_prototypes` too in the units build), eight pairs each,
outputs identical:

| program | wall | cycles | instructions | peak memory |
|---|---|---|---|---|
| tsc-ts | 0.957 | 0.984 | 0.985 | 1.002 |
| the compiler | 0.989 | 0.990 | 0.991 | 1.001 |

As the prototype measured, ThinLTO with the copies and the unit-local
`static`s is a little faster than the one-file build.

Tests: the splitter's unit test (`tests/c_units_tests.rs`), the unit
build gate in the fast CI (`tests/units_build_gate.sh`: outputs against the
one-file builds with every kind of unit, hidden symbols, module paths, a
rebuild compiling nothing, an edit recompiling only its units, an included
header's change recompiling), the conformance suite through units (538/538).

What remains: export and emit are serial and now 48 of a rebuild's 53 to
68 s (slice 3, and the exporter). An addition (a function, a literal)
still changes the shared header, so every unit recompiles: slice 2 needs,
besides stable numbering, declarations that a unit takes only for what it
uses.
