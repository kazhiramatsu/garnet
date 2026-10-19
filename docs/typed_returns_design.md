# Typed direct-entry returns

## Problem

A direct entry (`fn_X_d`, Session 350) takes its parameters in the
representation the body uses (`double`, `long long`, `tsv`) but always
returns a `tsv`. The compiler's hottest small functions return numbers and
booleans — `getObjectFlags`, `getNodeId`, `getCombinedFlags`, and the
hundreds of `isXxx(node)` predicates — so every call boxed the result
(`ts_num`, `ts_bool`) and the caller unboxed it again (`ts_to_num`,
`ts_truthy_fast`), and a returned comparison (`return n.kind === k`) was
boxed inside the callee because a `return` is not a condition use.

## Design (`direct_return_kind` in `emit_c.rs`; `TSAOT_TYPED_RETURNS=0`)

Each direct signature carries a return kind:

- **F64 / I64** when every `return` carries a raw numeric local of the
  body's classification (the int kind when all of them are `long long`).
- **Bool** when `bool_return_locals` is non-empty: every `return` carries a
  local whose definitions are all comparisons, `!`, boolean constants,
  calls to functions whose direct entry returns a raw boolean, or copies of
  such locals, and whose uses are all returns, conditions, `!` operands or
  those copies. Those locals become raw 0/1 locals of the body (they join
  the condition-temporary rule's set), so `return a.kind < b.kind` is a
  plain `int` comparison. Parameters and catch variables never qualify.
- **Boxed** otherwise: a valueless `return`, a returned `undefined`, a
  returned parameter, mixed kinds, a function without a direct entry.

Raw-boolean returns feed each other (`return isLeaf(n)`), so
`direct_entry_sigs` iterates the classification over the set of functions
with a Bool entry until the set stops growing (it only grows); the final
set stays available to the body emitter, whose unboxing analysis admits a
call to such a function as a raw definition (`if (isLeaf(n))` tests the
`int` result directly).

The body reads each returned local in whatever representation it has, so a
classification difference between the pre-pass and the body is never a
type mismatch: `(dN != 0)` or `ts_truthy_fast(vN)` for Bool, `ctx.num` for
F64, a cast for I64. A `return` inside `try`/`finally` reaches the entry's
exit through the finally machinery's pending completion value, which is a
boxed `tsv`; that exit converts it the same way (the first version returned
the boxed bits from a `long long` entry, caught by the conformance gate's
finally fixtures). The generic `(args, nargs)` entry boxes the raw result
(`ts_num`, `ts_bool`) for callers through function values, `call`/`apply`
and callbacks. At a direct call the result lands by kind: a raw local takes
the value, a boxed local takes `ts_num`/`ts_bool` of it, an `int` local
takes the cast. The guarded known-method call uses the same assignment.

Fixture `functions/typed_returns` (numbers, booleans produced every way,
`undefined`-returning and mixed functions, NaN, -0 and large results, a
returned parameter, returns inside try/catch and through one and two
`finally` blocks (including an overriding return), recursion, results as values,
conditions, operands, `typeof`, JSON and arrays, and the same functions
through callbacks, `call`/`apply`, `some`/`every`/`filter`/`map`/`sort`).
