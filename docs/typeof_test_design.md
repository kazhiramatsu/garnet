# `typeof` tests and static `typeof` strings

## Problem

The pattern benchmarks against V8 (Session 350) put a loop of
`typeof v === "number"` / `typeof v === "string"` dispatches at 17.9x slower
than V8. Two costs stacked up:

- `ts_typeof` allocated a fresh heap string on every call
  (`ts_new_string("number", 6)`), so every test was an allocation plus GC
  pressure.
- The exporter lowers the test to `t = typeof x; c = "lit"; d = (t === c)`,
  and the generic `===` on two strings is an out-of-line `ts_strict_eq_slow`
  that compares the characters.

The compiler has 231 such sites (`isString`, `getTextOfNode`, option
handling, every `typeof x === "function"` host probe).

## Design

1. **Static `typeof` strings** (runtime). The seven results are static
   string cells (`TS_GEN_NONHEAP`, `TS_STR_FLAG_STATIC`), hashed once at
   startup by `ts_typeof_strings_init` (called from `ts_init_fields`, the
   first runtime call of every generated `main`). `ts_typeof` returns a
   reference to the cell; no allocation. Alone this took the kernel from
   17.9x to 5.5x slower than V8.
2. **Fused tag test** (emitter, `typeof_fusion_plan` in `emit_c.rs`). Per
   function, a `===`/`!==` whose operands are a `typeof` temp and a string
   constant temp becomes a tag test on the `typeof` operand, when
   - the `typeof` temp has exactly one definition,
   - the compare follows the `typeof` in the same block with only constant
     materializations between them (so the operand cannot change in
     between), and
   - the string temp is a single-definition `Const`.
   The test is one of `ts_typeof_is_number/string/boolean/undefined/
   function/symbol/object` (inline, mirroring `ts_typeof`'s classification
   order exactly); any other literal is the constant false. A temp whose
   only use is the fused compare is not materialized at all, so the common
   form compiles to a single tag check. `TSAOT_TYPEOF_TEST=0` keeps the
   generic form; the byte-parity oracle runs with it.

## Expected effect

The kernel's dispatch becomes a tag branch; on the compiler the gain is
bounded by how often the 231 sites execute (the profile attributed under
0.1% to `ts_typeof` itself, the allocation and GC share was hidden in the
collector's time).
