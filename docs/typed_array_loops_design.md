# Typed-array loops: counted loops the C compiler can vectorize

Session 353. A loop over a typed array (`for (let i = 0; i < a.length; i++)
a[i] = ...`) is emitted today as the general index loop: the hoisted view
(`docs/typed_arrays_design.md`, `TSAOT_TA_HOIST`) saves the receiver test, but
each iteration re-reads `.length` with an own-property check, compares the
integer counter as a double, and reads or writes the element behind a bounds
test whose other arm is a call (`ts_array_get_key_i64`). A loop with a call in
a conditional branch is never vectorized, and the scalar code is a dozen
instructions an element.

Measured on 1M-element Float64Array/Uint8Array loops (fill, a sequential sum,
`b[i] = (b[i] + k) & 255`), 200 rounds: Garnet 0.32 s, Node 0.28 s (V8 does
not vectorize JavaScript loops), the same loops written as plain C over the
buffers 0.12 s (clang vectorizes all three).

## The design: a versioned counted loop

The emitter recognizes a *simple typed-array loop* and emits, before the
general loop, a counted loop over the prefix of the index range that every
accessed view covers, with direct element access; the general loop then
finishes the rest (an index past a view's length reads `undefined` and
ignores a store, so only the prefix is uniform).

A loop qualifies when:

- it is a `for` loop whose condition is `i < bound` and whose update is
  `i++`/`i += 1`, `i` an integer local assigned nowhere else in the loop;
- `bound` is loop-invariant: a hoisted view's length or an integer local not
  assigned in the loop;
- every element access in the body is `v[i]` on a hoisted view `v` (reads and
  writes), the index the loop variable itself;
- the body is straight-line arithmetic on unboxed locals (integer and
  double), reads of loop-invariant locals, and those element accesses: no
  calls, no property stores, no allocation, no boxed value, no `break`,
  `continue`, `return` or `throw`, no nested loop.

The prefix loop:

```c
if (_tah_a && _tah_b && obj_map_plain(&_tah_a->o)->len == 0 && ...) {
  uint32_t _end = <bound>; if (_end > _tal_a) _end = _tal_a; ...
  for (; d_i < _end; d_i++) {
    <body with ((double*)_tah_a->data)[d_i] reads and element stores>
  }
}
/* the general loop continues from d_i */
```

- The element store converts as the general path does: Float32/Float64 a
  plain store; an integer view from an integer local a plain narrowing cast;
  from a double the JS ToInt conversion (`ts_ta_elem_store`), which is scalar
  but still cheaper than the general path. The exporter's int32 facts decide.
- A double reduction (`s += a[i]`) is allowed and stays scalar: C's
  evaluation order is JavaScript's, and clang does not reassociate without
  fast-math. Only element-wise loops vectorize, which is the semantics'
  limit, not the design's.
- Two views may alias (the same buffer, overlapping offsets). The pointers
  are plain, so clang inserts its runtime overlap checks and keeps the scalar
  loop when they fail; nothing is declared `restrict`.
- The guard runs once: the hoisted handles exist (a receiver that is not a
  typed array of the element kind has no handle), the views have no own
  properties (the body cannot add one: no calls, no property stores), and the
  prefix bound is the minimum of `bound` and the accessed lengths.
- The loop variable is the same local, so its value after the loop and the
  remainder's starting index are right by construction.
- `TSAOT_TA_LOOPS=0` emits the general loop only. The parity corpus hoists
  no views (`TSAOT_TA_HOIST=0`), so the oracle never sees a versioned loop.

## Gates

- Fixtures (V8 output identical, plain and strict): element-wise loops over
  every element kind; views of different lengths (the vectorized prefix and
  the general remainder); the same buffer through two overlapping views;
  NaN, infinities and fractions stored into integer views; a loop starting
  above zero; the loop variable read after the loop; a loop whose bound
  exceeds every length; empty views; a loop the rule rejects (a call in the
  body) beside one it takes.
- Kernels against Node and against the plain-C ceiling: fill, scaled add,
  byte transform, copy between views, dot product (scalar by semantics).
- tsc-ts: outputs identical, instructions neutral (its typed-array loops are
  the scanner's `switch` loops, which the rule does not take).

## As built (Session 353)

- Emitter (`ta_loop_plan`, `emit_ta_prefix_loop`, in the `Loop` arm after the
  view hoists, when the loop has no modulo residues): the recognizer reads the
  exporter's `for` lowering (the first-iteration `If` whose else arm holds
  `t = i + 1; i = t`, the flag cleared, the condition `i < bound` last in
  `cond_body`), requires `i` an integer local assigned nowhere else, the bound
  a hoisted view's `length` (`LoadField` with the view's element hint), an
  integral constant below 2^32 or an integer local the loop never assigns,
  and walks the body against the whitelist (`Const`, `Copy`, `BinOp`, `UnOp`
  on unboxed locals, `LoadIndex`/`StoreIndex` by `i` on hoisted views,
  `length` reads of hoisted views, nested `If`). The prefix loop runs while
  `(unsigned long long)i < _te`, `_te` the bound clamped to every accessed
  view's length, guarded by the views' handles and, for a `length` bound, the
  view having no own property; `ctx.ta_prefix` makes `emit_view_load` and
  `emit_view_store` emit the direct forms inside it.
- The hoist also keeps the data pointer in a local (`_tad`): a pointer
  reloaded from the view each iteration through a `uint8_t*` store defeated
  alias analysis.
- Runtime (`ts_rt.h`): the direct forms are typed loads and stores through
  `may_alias` element types (`ts_ta_elem_load_v`, `_load_i32_v`, `_store_v`,
  `_store_i64_v`): the general helpers' fixed-size `memcpy` stays a call at
  the vectorizer's point ("call instruction cannot be vectorized", measured on
  a probe), the typed derefs vectorize; a view's data is element-aligned and
  the aliasing types let two views of one buffer coexist in one function.
  `ts_ta_elem_store_i64` (memcpy form) serves the general path's integer
  stores.
- Kernel `benchmarks/patterns/typed_array_loops` (fill, axpy, bytes, copy,
  dot; 2^18 elements, 300 rounds): 14.73 -> 9.52 G instructions (-35%), 1.69
  -> 1.23 G cycles, outputs identical; clang vectorizes fill, axpy, the init
  loop and (as an ordered reduction) dot, turns copy into memcpy, and leaves
  `bytes`: `(b[i] + k) & 255` adds a double (the element load) to an integer
  local and converts the sum with `ts_to_int32`, which has no vector form;
  the int32 analysis admits only bitwise uses of a candidate, so an add whose
  result is consumed by `& 255` stays a double add even though both operands
  are integers (a later extension: `+`/`-` of integral operands whose result
  feeds ToInt32 computed in int64 and truncated).
- Fixture `stdlib/typed_array_loops` (V8 output identical, plain and strict).
  The new always-inline helpers are listed in
  `tests/runtime_inline_policy_gate.sh` (the unit and GC gates embed it).
- Against Node on a quiet machine: the kernel 302 ms against 337 ms (0.90);
  the fill/sum/bytes probe of the opening (1M elements, 200 rounds) 0.17 s
  against 0.29 s (it was 0.32 s before the slice; the plain-C ceiling 0.12 s,
  the sum being the scalar part).
- tsc-ts: no loop qualifies (its typed-array loops are the scanner's switch
  loops), outputs identical, instructions 0.9999.
- `TSAOT_TA_LOOPS=0`; the parity corpus hoists no views.
