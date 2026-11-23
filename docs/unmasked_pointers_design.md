# Object pointers stored as themselves

Status: **design and audit, nothing built** (Session 368, 2026-11-24; every line number below is at
commit `f9439c5`). The expected gain is an estimate until slice 4 measures it.

A value is a 64-bit word that holds a double, or a selector in its top 16 bits (`0xFFF8` to `0xFFFE`)
over a 48-bit payload. An object's word is `0xFFF8` over its address, so every use of the object masks
the word first, and every test for "an object" compares the top 16 bits with a constant that does not
fit an instruction. This design changes the encoding so that **an object's word is its address**: no
mask, and the test is "the top 16 bits are zero".

## Why

Where the checkers of tsc-ts spend their samples, by the instruction a sample falls on (Session 367,
the TypeScript 6.0.3 compiler project):

| build | the pointer mask of an unboxing | a value's tag tests |
|---|---|---|
| plain | 4.8% | 5.2% |
| profile-guided | 6.5% | 6.5% |

Proven receivers (class facts) can remove tag tests; nothing but the representation removes the mask:
it stands at every pointer read from a slot. On AArch64 today:

- the mask is `and x8, x0, #0x7fffffffffff` before the first load through every object;
- the object test compares against `0xfff8`, which is no immediate of `cmp`, so the constant sits in a
  register, callee-saved in a loop with calls;
- boxing a pointer (`ts_obj`) loads the cell's generation byte to decide the stack tag, then ors.

Estimate for tsc-ts on one thread: 3 to 4% of the instructions (the masks, part of the tag tests, the
constant's register, the boxing). Not measured.

## The representation

**Every word is today's word exclusive-or `K = 0xFFF8_0000_0000_0000`**, and the stack tag (bit 47 of a
reference to a cell outside the heap) goes away.

| value | today (`TS_VALUE_REP 0`) | new (`TS_VALUE_REP 1`) |
|---|---|---|
| object at `p` | `0xFFF8 << 48 \| p` (bit 47: a stack or static cell) | `p` |
| heap string at `p` | `0xFFF9 << 48 \| p` | `1 << 48 \| p` |
| function at `p` | `0xFFFA << 48 \| p` | `2 << 48 \| p` |
| boolean, undefined, null | selectors `0xFFFB`, `0xFFFC`, `0xFFFD` | selectors 3, 4, 5 |
| short string, the internal holes | selector `0xFFFE` | selector 6 |
| a double `d` | the bits of `d` | the bits of `d` xor `K` |
| `+0`, `1`, `-0`, the one NaN | `0`, `0x3FF0…`, `0x8000…`, `0x7FF8…` | `0xFFF8…`, `0xC008…`, `0x7FF8…`, `0x8000…` |
| a number, by its top 16 bits | below `0xFFF8`, or `0xFFFF` | above 6 (7 is never made) |
| the zero word | the number `+0` | no value: the object selector over a null address |

What follows from "the same word xor `K`":

- The selectors keep their order and spacing (`new = old - 0xFFF8`), so the runtime's selector
  comparisons (`TS_TOP16` at 64 sites, all but one an equality) and every `TS_BOX(sel, payload)` are
  right as written once the enum changes. Payloads, short strings and the hole markers keep their
  layout.
- `ts_to_num` of any word is the same double as today: `ts_to_num(undefined)` is still the NaN it was,
  so everything that reads a non-number as a number keeps its result.
- A NaN is canonical under the same condition as today, stated on the double's own bits (`bits >=
  0xFFF8…` becomes `0x7FF8…`): the bits that would read as a selector are the same thirteen.
- Words are compared for identity as before (`a == b`, the map's "found by its very bits").

So the two representations compute the same thing wherever code goes through the helpers. What can
differ is code that reads a word's bits itself. The audit below is the list of that code.

### The helpers in both representations

```c
#ifndef TS_VALUE_REP
#define TS_VALUE_REP 0
#endif
#define TS_NUM_XOR  (TS_VALUE_REP ? 0xFFF8000000000000ULL : 0ULL)
#define TS_SEL_BASE (TS_VALUE_REP ? 0x0000U : 0xFFF8U)
enum { TS_SEL_OBJECT = TS_SEL_BASE, TS_SEL_STRING, TS_SEL_FUNC, TS_SEL_BOOL, TS_SEL_UNDEF, TS_SEL_NULL, TS_SEL_SHORTSTR };

static inline tsv ts_num(double d){
  uint64_t b; memcpy(&b, &d, 8);
  if (b >= 0xFFF8000000000000ULL) b = 0x7FF8000000000000ULL;   /* a NaN whose bits would read as a selector */
  return b ^ TS_NUM_XOR;
}
static inline double ts_to_num(tsv v){ uint64_t b = v ^ TS_NUM_XOR; double d; memcpy(&d, &b, 8); return d; }
static inline int ts_is_num(tsv v){ return (uint16_t)(TS_TOP16(v) - TS_SEL_OBJECT) > 6u; }
static inline int ts_is_heap_ref(tsv v){ return (uint16_t)(TS_TOP16(v) - TS_SEL_OBJECT) <= 2u; }  /* object, string, function */
static inline void* ts_ptr(tsv v);       /* any heap reference: the payload (rep 0: less the stack tag) */
static inline void* ts_obj_ptr(tsv v);   /* a word known to carry the object selector: rep 1, the word itself */
static inline tsv   ts_obj(void* p);     /* rep 1: the address; no load, no branch, NULL is the zero word */
static inline tsv   ts_raw_word(uint64_t w){ return w ^ TS_NUM_XOR; }   /* a word that is no value, kept in a value slot */
```

`ts_obj_ptr` is new and is the point of the change: `ts_ptr` must keep its mask, since it also serves
strings and functions (selectors 1 and 2). A site uses `ts_obj_ptr` only where a test that dominates
it, or the allocation that made the word, proves the object selector.

### What each operation costs (AArch64, the forms expected; to be read off the disassembly in slice 4)

| operation | today | new |
|---|---|---|
| object test | compare with `0xfff8` held in a register | `lsr x8, x0, #48; cbnz` or `tst x0, #0xffff000000000000`: no constant |
| object pointer | `and` | nothing |
| string or function pointer | `and` (47 bits) | `and` (48 bits) |
| boxing an object pointer | load the generation byte, branch, `orr` | nothing |
| number test | `lsr`, `add`, `cmp` | `lsr`, `cmp #6` |
| undefined, null, boolean test | compare with a constant in a register | `lsr`, `cmp #4` |
| number read | `fmov d0, x0` | `eor x8, x0, #0xfff8000000000000; fmov d0, x8` |
| number write | `fmov`, the NaN test | `fmov`, the NaN test, `eor` |
| integer slot read | 32-bit load | the same |
| integer slot store | 64-bit store of the zero-extended integer | one `orr` more (below) |
| unboxed double and integer fields, typed arrays, unboxed locals | | unchanged |

`K`, the 48-bit mask and the 16-bit test are logical immediates: nothing needs a constant register.
The price is one `eor` at every boxed number read or written: `any`-typed arithmetic, **the elements of
a `number[]`** (they are words; typed arrays are not), number keys of a Map, JSON numbers. tsc-ts has
few of them on its hot paths; the bench kernels over number arrays are where a regression would show.

### Why this form

- **JavaScriptCore's offset** (cells unmasked, doubles plus `2^49`) removes the same mask, but the
  offset is no immediate of `add` (JSC keeps its tag constants in two reserved registers, which C
  cannot do), addition is not its own inverse, and the selectors would have to be redesigned (JSC's
  other immediates live in the low bits). The exclusive-or keeps every selector comparison.
- **Low-bit tags** (V8) fold into the addressing mode but need boxed doubles.
- **Renumbering the selectors** to make `ts_is_str` one comparison (heap and short strings one bit
  apart) is possible later and separate: this change keeps the order so that it stays a bijection.
- **Functions and strings under selector 0** (the kind byte tells them apart) would unmask them too,
  at the price of a load in every `typeof` and callable test. Not in this design.

Selector 7 is free in the new representation (`ts_num` never makes it).

## What depends on the representation: the audit

### 1. Code that goes through the helpers (follows the definitions)

- The runtime: `TS_TOP16` at 64 sites (ts_rt.h 28, ts_rt.c 35, inspect.c 1), every one an equality
  with a selector except `ts_is_num`, an order test (rewritten above, as is the NaN test of `ts_num`,
  which shifts the word itself). `ts_ptr` at 88 sites in ts_rt.h, 568 in ts_rt.c, 58 in the other
  runtime files.
- The emitter (`analyzer/src/emit_c.rs`) writes no bit pattern of a value: numbers through `ts_num` /
  `ts_to_num`, constants through `TS_UNDEFINED` / `TS_NULL` / `ts_bool`, one short string constant as
  `TS_BOX(TS_SEL_SHORTSTR, …)` (16944), pointers through `ts_ptr` at 27 sites. Its frames, locals and
  module globals are initialized to `TS_UNDEFINED` explicitly (3926, 9688, 884), boxed fields of a
  class instance likewise (23054). No cast between `double*` and `tsv*`, no union of the two.
- The frozen emitter (`analyzer_ts`, its two C templates), `benchmarks/typescript_native/host.c`, the
  regular expression adapter: helpers only.

### 2. Raw selector literals (follow once spelled with the enum)

`TS_ARRAY_HOLE`, `TS_TDZ_HOLE`, `TS_ITER_DONE` (ts_rt.h 4021, 4024, 4111) and `TS_MAPSET_HOLE`
(ts_rt.c 9746) say `TS_BOX(0xFFFEu, …)`.

### 3. The payload mask and the stack tag (16 and 13 sites)

Bit 47 marks a reference to a cell outside the heap (a stack or SROA cell, a static literal) so that
the barriers and the collector tell it from a heap cell without a load. As an address it must go.
What replaces it is already the source of the tag: **the cell's generation byte** (`TS_GEN_NONHEAP`),
and for the collector the test it makes first anyway, **the cage's range**.

| site | today | new |
|---|---|---|
| `ts_heap_ref_fast`, `ts_heap_ref_value` (ts_rt.h 328, ts_rt.c 1499) | load `gen`, set the tag | `TS_BOX(sel, p)`; an object is `p` |
| `ts_ptr` (ts_rt.h 336) | payload less the tag | payload |
| `ts_write_barrier`, `_hdr`, `_ptr` (ts_rt.h 2709 to 2766), `array_value_is_young` (ts_rt.c 2672) | tag or null: return; else the value's `gen` | null: return; the value's `gen` (a stack or static cell's says NONHEAP). The owner's `gen` is tested first, as now. One test fewer |
| `gc_mark_visit` (ts_rt.c 7133) | tagged: `ts_heap_ptr`'s validation; else the cage test | the cage test first; outside the cage, the same validation (null, the stack-check quarantine, a plausible stack address, `gen == NONHEAP`, a valid kind) |
| `ts_heap_ptr` (ts_rt.c 1389) | by the tag | by the cage |
| `gc_mark_conservative_word` (ts_rt.c 7181) | a tagged word is not followed | a word outside the cage is not followed (the same words) |
| `ts_ref_hash`, the two hashes by payload (ts_rt.h 3734, ts_rt.c 9768, 14775) | payload | payload (a stack reference hashes differently; nothing orders by it) |
| debug and test helpers (ts_rt.c 7239, 7244, 7575; ts_rt_test.c 674, 708, 1578) | mask, tag | through `ts_ptr` |

The collector's work per edge is unchanged for a heap cell (selector test, cage test). A reference to
a static string literal takes the out-of-cage path, as it takes the tagged path today.

### 4. Number bits read off the word itself: **silent wrong values in the new representation**

- `ts_int32_exact` (ts_rt.h 3004): `if (i == 0 && (v >> 63)) return 0;` tests the word's sign bit for
  `-0`. Under the exclusive-or the bit is inverted: `+0` would be refused an integer slot and `-0`
  stored as `0`. To be `signbit(d)`.
- `TS_MAPSET_NEG_ZERO 0x8000000000000000ull` (ts_rt.h 3698), compared with a key and an element at
  ts_rt.c 10050 and 10632. In the new representation that word is **the NaN**: `map.set(NaN, 1)`
  would store under `+0`. To be the word of `ts_num(-0.0)`.

These two are everything a search for 64-bit literals, shifts by 63, 52, 51 and 48, and `memcpy`
between a double and a word finds outside `ts_num` / `ts_to_num` (the other number code works on a
`double`: `signbit`, `sv0_hash_num_d`). The source gate of slice 2 keeps it so.

### 5. Words that are no value, kept in a value slot

Today a small integer in a value slot reads as a denormal number, so nothing that walks slots follows
it. In the new representation a word below `2^48` reads as **an object reference**.

- **Integer slots of plain objects** (`TS_PROP_INT32`, docs/record_int_fields_design.md):
  `ts_int_slot_word(i)` is `(tsv)(uint32_t)i` (ts_rt.h 2965; the literal fill at 2988 and the stores
  around 3056 to 3495 go through it, the reads through `ts_int_slot_value` / `ts_int_slot_box`). The
  collector visits these slots as values (`gc_mark_common_props`).
- **A sparse array's side table**: `a->inline_data[0] = (tsv)(uintptr_t)s` (ts_rt.c 2712); the scan
  does not visit `data` while `a->sparse`, other walks must not either.

Rule: **a raw word in a value slot is `ts_raw_word(w)`, the word xor `K`**. It is then the number it
is today (the same denormal), in both representations, to every reader. An integer slot's store
becomes `orr x8, x8, #0xfff8000000000000` and the store; its read is the low 32 bits as now. If the
`orr` shows on vue (its `flags |=` sites are why integer slots exist), the store can write the low
half alone (`str w`), the high half written once when the slot becomes an integer slot: measured
before it is built.

Not affected: a class instance's unboxed double and integer fields (the marker reads `ref_offs`, the
boxed offsets, ts_rt.c 15499), a coroutine frame's numeric locals behind its frame map.

### 6. Memory scanned by selector

A coroutine frame without a frame map (`nvals < 0`: the runtime's adapters, the frozen emitter's
frames, and generated frames under `TSAOT_CORO_PRECISE=0`) is read word by word through
`gc_mark_visit` (ts_rt.c 27176): "any word that looks like a heap reference is a root". Today few
integers look like one. In the new representation every integer and denormal below `2^48` does, and
one that falls in the cage would have its "header" read. Those frames go through
`gc_mark_conservative_word`, which admits a word only if the allocation bitmap names a cell. The
native stack is already scanned that way, and its scan does not change: it takes a word by its low
48 bits, with or without a selector above them.

### 7. Zeroed memory

The zero word is `+0` today and no value tomorrow: a read of it as a value is `ts_is_obj` true and a
load through address 0 (a fault, loud), or silently "an object" where nothing dereferences it
(`ts_truthy`, `typeof`).

- **Cells are zeroed by contract** (ts_rt.c 750), except young class instances, whose every field the
  constructor writes (`TS_UNDEFINED` for a boxed one; ts_rt.c 338, 15133). So a value field of a cell
  that no constructor writes reads `+0` today. Known: **a coroutine frame's boxed locals** (the
  frame struct declares them, emit_c.rs 14398, and `coro_alloc`, ts_rt.c 25335, writes none). Whether
  generated code reads one before its first write is not established; if it does, it reads `0` today
  where V8 has `undefined`, and the fix is `coro_alloc` filling the first `nvals` words with
  `TS_UNDEFINED`, in both representations. The runtime's own cells set their value fields in their
  constructors as far as read for this audit (`coro_init`, the function, promise and generator
  paths); the checking build below is what settles the rest.
- **Static arrays of values without an initializer**: `g_wksym_singletons`, `g_error_protos`,
  `g_error_ctor_values`, `g_ta_proto`, `g_ta_ctor`, `g_exception` (ts_rt.c 5983, 12655, 12733, 18370,
  18377, 24139) and `g_iter_proto = 0` (ts_regexp_adapter.c 595). The rest are declared `TS_NULL` or
  `TS_UNDEFINED`. Zero as "not made yet" is right in both representations; zero read as `+0` is not.
- `calloc`'d or cleared arrays of values: `g_field_strings`, `g_struct_method_home` (ts_rt.c 13478,
  13563, 15205), unset meaning zero. The numeric field clear at 15141 is of a raw field.
- The marker meets zero words (a fresh frame, a cell's unused slots within its length): a null
  payload returns before anything else, as `!vp` does in the barriers.
- A stack instance is `memset` to zero, then its boxed fields set to undefined (emit_c.rs 23090), unless
  `TSAOT_UNDEF_FIELDS=0`: that knob leaves boxed fields zero and is not valid in the new representation.

### 8. Around the runtime

- **The ABI**: the runtime object and every generated unit must be compiled with the same
  `TS_VALUE_REP`. The harnesses pass flags through `TSAOT_CC` / `TSAOT_NATIVE_CC` and build their own
  runtime object, as the stack-check build does; `build/rt.o` and `build/regexp/*.o` (the shared
  caches of `dt`) are per representation. A mismatch must not link: ts_rt.h references a symbol named
  for the representation (`ts_value_rep_1`), defined by ts_rt.c.
- **Addresses**: an object's word has its top 16 bits zero, so every cell lies below `2^48`: the
  cage (checked where it is mapped), the stacks and the image. The stack tag assumed `2^47` already.
  Nothing may sign or tag a cell's address (pointer authentication, top-byte tags).
- **The frozen twin**: its emitted C uses the helpers, but it predates the undefined fill of boxed
  fields (Session 350) and registers classes its own way. `selfconf` runs in both representations in
  slice 3; if it cannot pass in the new one, the frozen twin's gates pin `-DTS_VALUE_REP=0` and that
  is a reason to keep representation 0 buildable.
- **The profiling scripts** classify instructions by pattern (`scripts/prof_pc.py`, the instruction
  classes of Session 367): the untag `and` goes, `eor #0xfff8000000000000` is a number. They are how
  slice 4 says what is left.
- **x86-64**: the same argument (a 64-bit mask is a `movabs` there); the default NaN of SSE is
  `0xFFF8…`, canonical after `ts_num` in both representations. Not measured.

## The checking build (`-DTS_VALUE_CHECK`)

A build for the gates, not for speed:

- `ts_obj_ptr(v)` aborts unless `v` carries the object selector: every conversion of slice 2 is checked
  in representation 0, before the new one exists.
- In representation 1, the marker reports a word in a precisely scanned slot that claims to be a
  reference and names no cell (not null, not in the cage, not a live stack cell, not a static literal),
  with the cell that holds it: a raw word that missed `ts_raw_word`, or a value field never written.
  Representation 0 cannot ask this: there such a word is a number.
- In representation 1, the value tests abort on the zero word (`ts_is_obj`, `ts_truthy`, `ts_typeof`,
  the equality entries): a zeroed field read as a value where nothing would fault.

With `TSAOT_CRASH_TRACE=1` a fault at a small address is the same finding from generated code.

## Slices

1. **This document.**
2. **Behind the helpers, representation 0 only, output unchanged.**
   - The definitions block as above with `TS_VALUE_REP` fixed at 0; `ts_is_heap_ref`, `ts_obj_ptr`,
     `ts_raw_word` and its reader; the four hole markers on the enum.
   - Sections 3 to 5 rewritten against the helpers: the barriers and the collector through one
     `ts_ref_is_nonheap` / the cage test, `signbit` in `ts_int32_exact`, the `-0` key as
     `ts_num(-0.0)`, integer slots and the sparse table through `ts_raw_word`.
   - `ts_ptr` to `ts_obj_ptr` where the selector is proven: the emitter's 27 sites less its three
     function sites (11445, 11453, 26669), the header's inline paths (arrays, maps, the property
     caches, typed field access), then the runtime's hot functions. Each is checked by the checking
     build over conformance.
   - A source gate, `tests/value_rep_gate.sh`, in `gate.sh unit` beside the header and property-map
     gates: outside the definitions block no `TS_SEL_SHIFT`, `TS_PAYLOAD_MASK`, `TS_PTR_STACK_TAG`,
     `TS_NUM_XOR`, no `TS_BOX(0x`, no shift of a word by 47, 48, 51, 52 or 63, no 64-bit literal
     compared with a word.
   - Verified by: the generated C byte-identical (the emitter's text changes only where `ts_obj_ptr`
     replaces `ts_ptr`: identical after that substitution), the instructions of tsc-ts and the bench
     unchanged, unit, conformance plain, the checking build over conformance.
3. **The switch.** `-DTS_VALUE_REP=1`, the link guard, the mapless frames through the conservative
   visitor, the marker's out-of-cage path, and what the checking build finds of section 7 (the
   coroutine frame's fill if a local is read unwritten). Both representations pass the
   whole set (below). New fixtures, each failing on a representation-1 build without its fix:
   `-0` and `0` into an integer slot of a literal and of a class (`Object.is`); `-0`, `0` and `NaN`
   as Map keys and Set elements, through the typed lookups too; a boxed local of an `async` function
   read before its assignment and after an `await`; NaNs of every payload out of a `Float64Array`
   (`0xFFF8…`, `0xFFFF…`, `0x7FF8…1`) and denormals with the bits of addresses, through `any`, an
   array, a Map and a field; integer slots and a sparse array under the collector's stress.
4. **The measurement, then the default.** Plain builds, alternating: tsc-ts on one thread and a
   default run (instructions, cycles, the corpus identical), hono, hono_app, vue, the bench budgets,
   the pattern kernels against Node, the size of the binaries; the instruction classes again (what the
   mask and the tag tests are now). Default if tsc-ts gains and no kernel leaves its budget; a kernel
   over number arrays that does is looked at first (its loop, the `eor`), not recorded as a cost.

## Gates of slice 3 (a representation change is the kind that needs all of them)

In both representations: unit (with the source gate), conformance plain, strict and under the
collector's protect mode, bundler, bench, ci, the collector stress, the stack-check build over
conformance, selfconf and parity, hono / hono_app / vue with identical outputs, tsc-ts built with its
reports identical and its corpus in the plain mode; the four fuzzers (numbers, statements, features,
objects), a few hundred seeds each; the test262 tier. In representation 1 also the checking build
over conformance and the fuzzers. Outputs are compared with V8's as always and between the two
representations.

## Risks

- **A raw-bit dependency the audit missed** is silent only if it is of section 4's kind. The source
  gate covers the idioms; the fixtures of slice 3, the fuzzers and test262 cover behaviour.
- **A zeroed value field** is a fault or a checking-build abort, not a wrong value, except through a
  test that does not dereference; those abort in the checking build.
- **Boxed number traffic**: one `eor` each way. To watch: the bench kernels over `number[]`, vue and
  hono's dynamic paths, JSON.
- **Two representations to keep**: until the default moves, every gate that builds the runtime says
  which one it built. After it moves, representation 0 stays buildable only as long as something
  needs it (the frozen twin, a bisect); deciding that is part of slice 4.

## Open for Kaz

- Whether representation 0 is kept after the default moves, and for how long.
- The integer slot's store: the `orr`, or the half-word store, by vue's measurement.
