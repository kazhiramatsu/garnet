# `switch` statements: direct chains and C jump tables

## Problem

The pattern benchmarks against V8 (Session 350) put a 32-case
`switch (node.kind)` dispatcher at 6x slower than V8. The exporter lowered
every `switch` into two passes: a nested if/else-if chain computing the index
of the first matching clause (`matched`), then a run-once loop over all
clauses that flips an `active` flag at `matched` and runs every following
body (fall-through). A dispatch therefore paid up to `n` compares to find the
clause, then `n` more `matched === i` compares and `n` `active` tests, for
every execution. The compiler's hot switches (`checkExpressionWorker`,
`bindWorker`, `pipelineEmitWithHintWorker`, `visitEachChild`, the scanner)
have dozens of cases.

## Design

1. **Direct chain** (exporter). When no clause body falls through into the
   next — every non-empty body but the last ends with `break`, `continue`,
   `return` or `throw`, or cannot complete normally by the same structural
   analysis that makes implicit returns explicit — the switch becomes a
   direct if/else-if chain inside the run-once loop (kept so `break` still
   targets the switch). Consecutive label-only clauses group with the next
   body; a group tests its labels lazily in source order
   (`eq = disc === l0; if (!eq) { eq = disc === l1 } ...`), so case
   expressions keep their evaluation order and side effects. The default
   group is the final else; a default that carries labels of its own, or a
   switch with fall-through, keeps the generic form.
   `TSAOT_SWITCH_CHAIN=0` restores the generic form for every switch. The
   IR is unchanged in kind, so the frozen twin emits the same C and parity
   is unaffected.
2. **C `switch`** (emitter, `switch_plan_for` in `emit_c.rs`). An
   if/else-if chain whose tests are `disc === k` on one unboxed numeric local
   with integer constants in the 32-bit range — the chain above or a
   hand-written one — is emitted as a C `switch` with the case bodies as
   cases and the innermost else as `default`, so the C compiler builds a
   jump table or a binary search. Requirements checked per chain: at least
   four cases, no duplicate value (JS picks the first, C would reject),
   every compare temp defined once and read only by the pattern, and each
   nested segment being the whole else-body. A `double` discriminant
   switches on its ToInt32 (`ts_to_int32`, one FJCVTZS on ARMv8.3), replaced
   by a value no case has (INT32_MIN unless a case takes it) when the double
   is not exactly that integer — a fraction, NaN, an infinity, out of range —
   so it reaches the default through the jump table's own bounds check; -0
   converts to 0 and compares equal (`-0 === 0`). Session 352: this replaced
   an explicit range guard (two compares against materialized double
   constants and a branch to the default label before the switch): tsc-ts
   retires 0.9% fewer instructions and the TypeScript compiler 0.3%, both
   time-neutral (eight ABBA pairs each). An integer local switches
   directly. The chain's own
   constant and compare temps are still emitted and left to dead-code
   elimination; nested chains inside case bodies convert too. Emission
   replays the original if/else path segments so loop-keyed plans still
   apply. `TSAOT_SWITCH_TABLE=0` keeps the nested ifs (the parity oracle).

## Measured

`switch_dispatch` kernel (32 cases, 98M dispatches): 829 ms → 537 ms
(V8 141 ms including startup). The remaining gap is the call, the two
property reads and the result boxing per dispatch.
