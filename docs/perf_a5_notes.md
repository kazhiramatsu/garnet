# typed_field_kernel performance: profile-first findings (no IC / no generational GC)

## What the profile showed
typed_field_kernel was assumed to need inline caches / a generational allocator
(the "A5" plan). Profiling proved otherwise: escape analysis ALREADY stack-
allocates the Point (no heap alloc in the loop), so allocation/GC was never the
bottleneck. The real costs were three simple codegen inefficiencies:

  1. `% 1000007` emitted `fmod` (a non-inlinable libcall)  — biggest, ~95ms/307
  2. trivial constructor not inlined (boxed arg-array + indirect call) — ~34ms
  3. loop condition boxed a boolean (ts_num + ts_truthy) — ~16ms (broadly applies)

Hand-applying all three: 307ms -> 181ms. No IC, no generational GC needed.

## Fixes landed
- Direct calls (CalleeRef::Direct/Set) now emit a direct C call `fn_<id>(...)`
  instead of `FN_TABLE[i](...)`, letting the C compiler inline.
- Inline integral fast-path for `%`: `x % nonzeroConst` with x a double tests
  `x == (long long)x` at runtime and uses trap-free integer `%`, falling back to
  fmod for non-integral / NaN / Inf. Sound; the dominant win (307 -> ~218ms).
- Condition unboxing: a comparison result whose every use is a truthiness context
  (loop/if cond, `!` operand) is kept as a raw 0/1 int (cmp_truthy_only pass),
  dropping the box/unbox around conditions. Broadly helps every loop:
  int_kernel 430->388ms, float_kernel 409->250ms.

## Correctness bugs fixed along the way (pre-existing, unrelated to perf)
- `7 % 0` returned garbage `(long long)NaN`; now `% C` yields int only when C is a
  proven nonzero int const, so `x % 0` correctly uses fmod -> NaN.
- `console.log(a < b)` / `console.log(!x)` printed `1`/`0` instead of `true`/`false`:
  comparison and `!` results are now boxed as ts_bool (JS boolean), and `!`'s
  result local is classified by node type (reference) rather than hardcoded
  primitive. Truthy-only results still unbox (no perf loss).

## Constructor inlining (the remaining ~34ms) — DONE
Extended the existing sroa.rs free-fn inliner (is_inlinable_free_fn / inline_free_fn)
to also fire on Direct calls WITH a receiver (this = param[0], then args). A trivial
constructor `this.x = a` then inlines to a direct typed field write
`((Class0*)ts_ptr(v))->f2 = d;` even when the object escapes (so SROA can't remove
it), avoiding the boxed `_a[]` arg-array round-trip (ts_num then ts_to_num).
Result: typed_field_kernel 218 -> 182ms (307 -> 182 overall; V8 kernel ~85ms).

SOUNDNESS (a regression caught by sroa_soundness / syntax_strfield and fixed): a
method that reads/writes `this` fields via LoadField/StoreField may only be inlined
when the receiver's class is statically known at the call site (a fresh AllocObject
in the same body), so codegen emits the SAME typed `->fN` layout the field uses
elsewhere. Inlining such a method onto an escaping receiver whose class is unknown
there (e.g. `b = make(); b.get()`) would emit a dynamic `ts_get` read that mismatches
a typed inlined write -> NaN/undefined. The inliner now gates on
`recv_fresh || !callee_touches_param0_fields(callee)`. Constructors onto fresh
allocations inline; getters onto escaped receivers do not. Golden inline_escape_getter
locks this in. typed_field_kernel budget tightened 300 -> 240ms.

## Free-function argument SROA — DONE
The remaining object in typed_field_kernel was not a heap allocation anymore, but
it still materialized as a per-iteration stack struct because passing `p` into
`sink(p)` disqualified it from SROA. We now keep such an argument scalarizable only
when the Direct free-function callee is tiny/straight-line and uses that parameter
exclusively for declared field loads/stores. During free-function inlining,
`param.f` loads/stores are rewritten to the caller's field scalar.

Result on the current machine: typed_field_kernel ~160ms before this change ->
66-67ms after it, beating the recent V8 baseline (~94ms). The loop body no longer
contains `AllocObject`, `Class0 sobj`, or `ts_ptr` field access.
The benchmark budget is tightened again from 240ms to 140ms so a return to the
old stack-materialized path is caught.

## Free-function inlining extended: pure ifs, cascading rounds (Session 353)

The inliner took straight-line free functions only (at most eight constants,
copies, arithmetic, field loads and stores and a trailing return). The tsc
pattern kernels showed the cost: `small_calls` (`getObjectFlags(t) { return
t.flags & F ? t.objectFlags : 0 }`, `pick(a, b) { return a.id < b.id ? a :
b }`) ran 2.65x scriptc's instructions, and inlining its helpers by hand
took it from 20.6 to 13.3 G. Now:

- A body may hold `if`s whose branches are of the same straight-line kinds
  (a `?:`, `&&` or `||` lowered), no return inside a branch, within a budget
  of 24 instructions in all and 10 at the top level (`inlinable_pure_body`);
  the splice remaps the branches (`inline_free_splice`).
- The inlining cascades: a helper that only became inlinable once its own
  calls were inlined (`isRef(t) { return (getObjectFlags(t) & 4) !== 0 }`)
  is inlined into its callers in up to two more rounds over the rewritten
  bodies (`inline_free_calls_round`), free functions and methods whose
  bodies do not touch the receiver's fields alike.
- The two parameter scans the SROA of argument objects relies on
  (`callee_param_field_only_sroa_safe`, `callee_touches_param0_fields`) see
  the nested bodies: the first declines any body with control flow or a call
  (the parameter's object is not scalar-replaced, as before), the second
  looks into the branches.

Tried and removed: admitting calls inside an inlined body. The compiler
project ran 0.6% more instructions, and a body holding a method call on an
interface-typed parameter (fixture object_methods/interface_dispatch)
miscompiled when inlined; the cause was not analyzed.

Measured (instructions): `small_calls` 20.63 to 15.83 G (scriptc 7.80),
`class_nodes` 4.51 to 4.34 G; the compiler's one-checker compile 0.9991
(neutral). `TSAOT_INLINE_IF=0` keeps the straight-line rule, and the parity
oracle (`scripts/emitc_diff.sh`) runs with it.

## Deferred
- Nothing material remains for typed_field_kernel. Allocation/GC churn work should
  move to array/object churn kernels where the allocations still exist; for
  gc_churn_kernel specifically, fixed array-literal scalarization is likely a
  better first step than allocator work because it can remove the short-lived
  arrays entirely.
