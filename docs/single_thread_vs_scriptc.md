# One thread against scriptc: where the critical path's time goes

Session 352. The threads work (`docs/threads_scaling_review.md`,
`docs/fork_workers_design.md`) ends on one fact: on the TypeScript compiler
project, tsc-ts's time with any number of checkers is one thread parsing,
checking and emitting `src/compiler/checker.ts`, and garnet's thread is
1.4-1.65x slower than scriptc's at it. This document is the first look at
what that thread spends, measured on the one-thread compile of the whole
project (`--singleThreaded`), which the critical path is a sample of.

## It is an instruction count

`/usr/bin/time -l` on one compile (Apple M5, outputs identical):

| | garnet | scriptc | ratio |
|---|---|---|---|
| wall | 1.74 s | 1.05 s | 1.66x |
| instructions retired | 33.4 G | 18.3 G | **1.82x** |
| cycles | 7.68 G | 4.61 G | 1.67x |
| instructions per cycle | 4.35 | 3.98 | 1.09x |

garnet's code runs at a better IPC than scriptc's and retires 1.8x as many
instructions: the gap is the amount of code executed per operation, not
memory or the collector's pauses. Parsing alone (`--listFilesOnly`):
garnet 5.31 G instructions in 0.28 s, scriptc 2.11 G in 0.09 s (2.5x
instructions; garnet's 23 ms startup and its file decoding included).

## Where the instructions are

Sampling profiles of the one-thread compile (`sample`, 1 ms, a build
linked with `-Wl,-no_deduplicate` so that folded functions keep their
names), each leaf sample by category:

| window | generated code | Map/Set | allocation and GC | strings | arrays | libc |
|---|---|---|---|---|---|---|
| check (0.42-1.42 s) | 61% | 12.6% | 8.3% | 7.3% | 3.8% | 4.7% |
| emit (1.22 s to the end) | 58% | 11.9% | 5.4% | 11.1% | 4.6% | 8.1% |
| parse (`--listFilesOnly`) | 53% | | 14.9% | 21.4% | | 3.2% |

The profile is flat: the hottest leaf of the check window is `ts_map_get`
at 3.7%, the hottest generated function `getTypeAtFlowNode` at 1%. Within
the runtime: `ts_map_get` + `mapset_probe` + `map_find` are 12% of check
(the checker's caches are `Map`s; the whole compile does 9.4 M map finds at
2.24 probes each); the collector and allocation 8% (98 young and 3 full
collections, 180 ms of pauses over the compile); strings 7%, of which
`Buffer.byteLength` is 2-3.5% in every window: tsc-ts's
`containsNonASCII(text)` compares the UTF-8 byte length with the length
(`ast.ts`), which the host answers by walking the string unless its ASCII
flag is set (`host_utf8_length`, `ts_str_utf8_len_view_impl`); in parse,
`strhash_units` (the interning of identifiers) is 13%.

So about 40% of the time is the runtime's, in operations whose per-call
cost is garnet's to lower (maps, allocation, strings), and 60% is the
emitted code itself, whose instruction count per operation is the larger
question.

## The kernels: 2-7x the instructions

`scripts/pattern_bench_scriptc.sh` builds each kernel of
`benchmarks/patterns` (tsc-style patterns, written for the comparison with
V8) with garnet and with scriptc and compares instructions retired, cycles
and outputs (identical on every kernel both build):

| kernel | garnet G instructions | scriptc | ratio | garnet ms | scriptc ms |
|---|---|---|---|---|---|
| path_regexps | 7.09 | 1.03 | 6.9x | 240 | 40 |
| obj_literal_poly | 5.76 | 1.59 | 3.6x | 140 | 40 |
| map_string_keys | 1.77 | 0.60 | 3.0x | 60 | 20 |
| string_scan | 7.33 | 2.55 | 2.9x | 190 | 80 |
| flags_truthy | 8.91 | 3.13 | 2.85x | 270 | 100 |
| strings_build | 4.18 | 1.54 | 2.7x | 130 | 40 |
| small_calls | 20.58 | 7.80 | 2.6x | 720 | 260 |
| tree_recursion | 2.30 | 0.89 | 2.6x | 70 | 20 |
| callbacks | 7.41 | 2.88 | 2.6x | 220 | 90 |
| string_keys | 5.23 | 2.56 | 2.0x | 200 | 110 |
| switch_dispatch | 9.14 | 4.67 | 2.0x | 360 | 360 |
| object_arrays | 5.83 | 3.50 | 1.7x | 160 | 100 |
| closures_env | 6.29 | 10.02 | 0.6x | 180 | 300 |
| map_forof | 0.75 | 0.06 | (scriptc folds the loop) | 30 | 0 |

scriptc rejects four kernels its type system does not admit
(`ctor_functions`: a value typed `() => NdCtor` with an `as any` cast;
`links_objects`: an `any`-typed class field; `method_objects`: an accessor
satisfying a data property; `sparse_stores`: a value of type
`any[] | undefined`): its speed rests partly on refusing the dynamic forms
garnet compiles.

## What a field read costs

`small_calls` (160,000 x 1,024 iterations of four tiny helpers over
interface-typed literals) retires 125 instructions per iteration in garnet
and 48 in scriptc. garnet's C for `getObjectFlags(t: T)`:

```c
d1 = (double)ts_to_int32(ts_to_num(({ tsv _lz;
  if (!ts_get_static_try(r0, 2, 0u, &_ts_pic_900000, &_lz)) { ... _lz = ts_get_linked(r0, 2, &_ts_pic_900000, &F.h, 1); ... }
  _lz; })));
d3 = ((double)((int32_t)((int32_t)d1) & (int32_t)((int32_t)(uint32_t)d2)));
if ((d3 != 0)) {
  d5 = ts_to_num(({ tsv _lz; if (!ts_get_static_try(r0, 3, 1u, ...)) ...
```

Every field read is a shape check against a static slot guess with an
inline-cache fallback, a NaN-box decode, a double-to-int32 conversion and
a conversion back; every helper takes and returns boxed values. scriptc
compiles `T` as a struct of three numbers and `t.flags & 524288` as a load
and an `and`. The difference is type-directed layout: an object literal
typed by an interface has, to garnet, a shape to be checked at each site;
to scriptc, a layout known at compile time. garnet does this for class
instances (sized instances, monomorphized numeric fields,
`docs/cell_header_design.md`), not for interface-typed literals, which is
how tsc writes its nodes, symbols and types.

## Found on the way

- `tsc-ts --noEmit` crashes garnet's build (`EXC_BAD_ACCESS` at address
  0x20 in a closure trampoline: a closure called with a null environment
  register), in the build before the fork work too. To reproduce
  minimally and fix.
- The fork build's default is forked checkers (`availableParallelism()` is
  the core count), so one-thread measurements pass `--singleThreaded` or
  `--checkers 1`.

## What to do

The lever is the instruction count of the emitted code and of the
runtime's hot operations, and the kernels order the work: regular
expressions (6.9x: the engine, QuickJS's, runs without a first-character
prefilter and the adapter boxes every match), interface-typed literals
(3.6x: the tsc node pattern, the checker's whole data model), maps with
string keys (3.0x), string scanning and building (2.9x, 2.7x), flag tests
and truthiness over unions (2.85x), small calls with boxed arguments
(2.6x), callbacks (2.6x). Each is measured by its kernel's instruction
ratio, which `scripts/pattern_bench_scriptc.sh` prints, and the whole by
the one-thread compile's instruction count (33.4 G today). The runtime's
side, with its own measurements: `Map` lookups (12% of check), the
collector (8%), `containsNonASCII` (2-3%: keep the ASCII flag on every
string that has it, including the builder's and concatenation's results).
