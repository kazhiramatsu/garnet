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

## scriptc's object model, probed

Six small programs built with scriptc and run beside Node (Session 352;
`scratchpad/crit/kern/probe`). An interface's members are a struct: when
a literal with extra properties reaches an interface-typed binding
(`const wide = { flags: 5, id: 7, extra: "e", more: 9 }; const t: T =
wide;`), scriptc's `Object.keys(t)` is `flags,id` and its `JSON.stringify(t)`
`{"flags":5,"id":7}`, where Node prints `flags,id,extra,more` and the whole
object; a property added through an intersection-typed alias of the same
object (`(o as O & { d?: number }).d = 4`) is seen through the alias and
not through the original `O`-typed binding (`Object.keys` `a` against
Node's `a,d`). Structural compatibility between differently declared
interfaces, unions discriminated by a literal member, optional members,
`in`, `keyof` indexing and `Record` index signatures behave as in Node;
`any`-typed fields, accessors satisfying data properties and
union-shaped values are refused at compile time. So the static type is the
layout: a field read is one load because nothing else can be there, and
what the type does not name is dropped from the object's reflection.
garnet keeps JavaScript's semantics (the extra properties stay, as in
Node), so it cannot take this model as it is; it can take the result
where a whole-program proof makes the layout certain, and keep the
check elsewhere.

## Found on the way

- `tsc-ts --noEmit` crashes garnet's build (`EXC_BAD_ACCESS` at address
  0x20 in a closure trampoline: a closure called with a null environment
  register), in the build before the fork work too. To reproduce
  minimally and fix.
- The fork build's default is forked checkers (`availableParallelism()` is
  the core count), so one-thread measurements pass `--singleThreaded` or
  `--checkers 1`.

## The profile, corrected

The sampling profiles above (`sample`, 1 ms) are wrong about the generated
code: `sample` walks frame pointers and truncates the checker's deep
recursion, so 95% of its leaves were mid-stack return addresses, and the
category shares came from the few stacks it walked to the end. A second
attempt, an interval timer (`ITIMER_PROF`) in the runtime, was wrong the
other way: its signal is delivered when the thread leaves the kernel, so
70% of its samples sat in `bzero` and `memmove` (fresh heap pages being
touched, page fault by page fault), which two measurement builds then
disproved (per-cell inline zeroing instead of the run `memset`, and the
next free run prefetched: wall unchanged). The profiler that works is a
sampler thread (`TSAOT_PROF_PC`, `scripts/prof_pc.py`,
`docs/agent_workflow.md`): wall-clock sampling of the main thread from
outside, PC, link register and the frame's saved return address, 13.5k
samples of one compile (Session 352, after slices A and F):

| | share |
|---|---|
| generated code | 57.3% |
| runtime (`ts_rt.c`, `host.c`) | 36.9% |
| system libraries (`bzero`, `memmove`, `open`, ...) | 5.6% |

The runtime's share by function: `ts_map_get` 5.6% + `mapset_probe` 2.4% +
`map_find` 1.1% + `map_set_unchecked` 0.4% + `ts_str_hash_of` 0.5% (the
checker's caches: 9.4 M lookups a compile, three dependent loads each on a
large map: index word, key, value); the collector 9.5% (`gc_mark_visit`
3.6%, `gc_scan_cell` 1.3%, `gc_space_refill` 1.8%, `gc_alloc` 1.2%,
`gc_alloc_pretenured` 0.6%, `array_write_barrier` 0.6%,
`ts_new_sized_site` 0.5%: 98 minor and 3 full collections, 165 ms of
pauses, 7.4 M cells and 740 MB allocated); strings 7% (`strhash_units`
1.8%: every fresh string was hashed when built; `host_utf8_length` 1.3% +
`ts_str_utf8_len_view_impl` 0.4%: `Buffer.byteLength` over texts stored as
UTF-16, one unit at a time through the view accessor; `td_m_decode` 1.0%;
`ts_str_charcodeat_general` 0.8%; `ts_string_slice_view` 0.5%;
`ts_array_join` 0.6%); arrays 1% (`ts_array_set`, `ts_array_push`).

The generated code's share by machine-instruction class (the sampled
instruction, classified by its text and its predecessor):

| class | share of the generated code's samples |
|---|---|
| loads from the stack (frame slots `F.sN`, the C compiler's spills) | 11.9% |
| stores to the stack | 7.8% |
| prologue and epilogue: callee-saved register pairs | 11.2% |
| prologue and epilogue: the stack pointer | 1.7% |
| loads of globals and runtime structures | 13.1% |
| field and element loads after an untag | 8.5% |
| integer arithmetic and moves | 10.1% |
| compares and selects | 7.7% |
| `fmov` (a number boxed or unboxed) | 6.6% |
| branches | 5.3% |
| tag constants materialized | 3.7% |
| number conversions (`fjcvtzs`, `scvtf`) | 2% |

So a third of the generated code's time is the shape of a call: the frame
struct's slots written before and read after calls and as arguments
(`fn(F.s0, F.s2, F.s1, d3)`), the frame linked and unlinked, the slots
filled with undefined at entry, the register pairs saved and restored
around functions with two hundred locals; another tenth is numbers moved
between the integer and the floating-point files (a `kind` stored as a
double, converted to an int32 at every switch).

Measured ceilings (unsound variant builds, outputs identical, the
TypeScript compiler project): the receivers' object test is 3.7% of the
instructions, the class interval test 0.4%, NaN canonicalization 0.4%, the
frame-slot reloads after calls 0.3%; the collector 5.5% of the
instructions (every trigger off: a 1 GB nursery, a count threshold and a
payload budget past the compile, a 4 GB full threshold; a nursery setting
alone leaves 69 of the 98 minor collections running) and about 9% of the
time; with the collector off, the frame slots turned into plain locals in
every function without a try (`F.sN` to `F_sN`: no spills before calls,
no reloads after, no slot arguments) save 4.0% of the instructions, so
most of the stack traffic in the table is the C compiler's own spilling of
two-hundred-local functions. The nursery's size (4, 16, 64 MB) changes
neither instructions nor wall.

## Where the slices stand

| build | instructions | wall (one thread) |
|---|---|---|
| start of the work (fork build) | 33.44 G | 1.74 s |
| A: the typed store barrier | 32.93 G | |
| F: base-class field types | 32.60 G | |
| S: lazy string hashes, direct UTF-8 walks | 31.77 G | 1.66 s |
| C: conservative roots, no GC frames (`docs/conservative_roots_design.md`) | 28.55 G | 1.50 s |
| scriptc | 18.3 G | 1.05 s |

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
