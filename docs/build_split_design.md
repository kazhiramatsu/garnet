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
