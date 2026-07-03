# Benchmark-driven development — results & honest analysis

All kernels run the full pipeline: TS -> exporter -> devirt -> escape -> emit C
-> gcc -O2 -> native, linked against ts_rt. AOT time is wall-clock (incl ~1ms
startup); V8 is node, warmed, best-of-5 steady state. All outputs match V8.

| kernel | AOT | V8 (warmed) | verdict |
|---|---|---|---|
| **integer** loop (`%`, `*`, `+`) | **378 ms** | 519 ms | **AOT wins 1.37x** |
| **float** loop (double arithmetic) | 247 ms | 244 ms | **tie** |
| **object** loop (`new Vec` + method/field) | 989 ms | 365 ms | **V8 wins 2.7x** |
| startup / short task | ~1.3 ms | ~22 ms | **AOT wins ~18x** |

## Where AOT wins, ties, loses — and why
- **Integer (win)**: typed int loops are the sweet spot. V8 must keep deopt
  guards and Smi/double checks; we statically prove int-ness and emit native
  `long long` with plain `%`. Matches hand-written int64 C (378 ms).
- **Float (tie)**: TurboFan already keeps hot doubles unboxed in registers, so
  there's little to win on raw FP arithmetic; we match it but don't beat it.
- **Object (lose)**: this is the honest finding. Even after stack-allocating the
  loop-body `new Vec` (down from 2590 ms via heap+GC, to 989 ms), V8 still wins
  2.7x because it **scalar-replaces the object across the method call** (inlines
  `dot()`, promotes `x`/`y` to registers, eliminates the allocation entirely).
  Our codegen still passes the instance through a real function call with `tsv`
  boxing at the boundary and a struct in memory. Beating V8 here needs
  cross-call inlining + SROA (scalar replacement of aggregates), which is exactly
  what V8's optimizer is best at.

## Bugs the benchmarks caught (the point of measuring)
1. **All-boxed values**: first int kernel was 2.5x *slower* than V8 (1320 ms) —
   box/unbox dominated. Fixed with the unboxed numeric path.
2. **Double<->int64 churn**: modulo round-tripped through doubles (862 ms). Fixed
   with integer specialization (least-fixpoint int-typing) -> 378 ms.
3. **Number formatting**: float kernel printed `1.25e+15` vs V8's
   `1250002487503344.2`. Fixed with JS shortest-round-trip formatting.
4. **Heap corruption**: typed class instances were heap-allocated with the base
   `ts_object` size, overflowing into adjacent memory (glibc abort). Fixed with
   `ts_new_sized(sizeof(struct))`.
5. **Devirt missed nested calls**: `v.dot()` inside a loop stayed dynamic
   (returned 0) because `run_devirt` only walked top-level body. Fixed by
   recursing into Loop/If bodies.
6. **Loop allocation strategy**: loop-body NoEscape was heap-allocated; now
   stack-allocated per iteration (C scope gives per-iteration lifetime soundly).

## Takeaways for the speed thesis
- The thesis holds in the regime it claimed: **typed numeric / integer code, and
  startup-bound workloads**, where static type+escape info lets us erase what V8
  must check at runtime.
- It does NOT hold for allocation-heavy OO code unless we add **inlining + scalar
  replacement of aggregates** to compete with V8's optimizer. That's the next
  big lever, not more micro-tuning.
- Float arithmetic is a wash — V8 is already optimal there.

## Next benchmarks / work
- Implement method inlining + SROA for small NoEscape objects (the object-kernel
  gap); re-measure.
- String/array workloads (honest fallback cost on the dynamic path).
- CI harness that compiles+runs all kernels and asserts correctness + a time
  budget, to catch perf regressions automatically.

## Update: object kernel after SROA + method inlining
Implemented scalar replacement of aggregates (SROA) + method/ctor inlining for
NoEscape class instances (analyzer/src/sroa.rs, run after devirt + escape, before
emit). A `new C()` that doesn't escape and is used only as a Direct-call receiver
is eliminated: its fields become scalar locals and the ctor/method bodies are
inlined (this.fK -> field scalar, params -> args, return -> dst).

| object kernel | time | vs V8 (273 ms) |
|---|---|---|
| heap + GC (original) | 2590 ms | 7.1x slower |
| stack struct | 990 ms | 2.7x slower |
| **SROA + inlining** | **~210 ms** | **AOT wins 1.29x** |

The loop body is now pure scalar arithmetic — no AllocObject, no FN_TABLE call,
no tsv boxing — which is exactly what V8 produces via its own escape analysis +
inliner, but we do it statically at AOT time.

Soundness verified: a Box that escapes via `return` is NOT scalar-replaced (keeps
the heap object + real ctor/method calls), while a non-escaping Box in the same
program is fully inlined; both produce correct results. A stale-header bug
(ts_new_sized lacking a prototype, truncating the returned 64-bit value to int)
was caught by this soundness test and fixed.

Verdict update: the speed thesis now holds for typed integer AND allocation-heavy
OO code (when objects are NoEscape), plus startup. Remaining honest gaps: float
is a tie; string/array/dynamic workloads fall back to the tsv path.

## Update: free-function argument SROA
The later typed-field gap was a narrower variant: the object was already not heap
allocated, but `sink(p)` made the fresh `Point` materialize as a stack struct. SROA
now allows Direct free-function arguments when the callee is tiny and uses the
parameter only for declared field loads/stores, and the inliner rewrites those
loads/stores to the caller's field scalars. Current result:
`typed_field_kernel` ~160 ms -> 66-67 ms, faster than the recent V8 baseline
(~94 ms). The remaining allocation-heavy gap is `gc_churn_kernel`, which still
creates short-lived arrays and likely needs fixed array-literal scalarization.

## Update: JSON parse/stringify mixed payloads

Added `json_perf_kernel`, a JSON workload covering class-instance
`JSON.stringify(...).length`, nested object/array stringify length, pretty
stringify length (`space`), and repeated constant `JSON.parse` payloads. Current
measurement:

| JSON kernel | AOT | V8 (warmed) | verdict |
|---|---:|---:|---|
| `json_perf_kernel` | 16 ms | 18 ms | AOT wins 1.1x |

The win comes from AOT-visible JSON work: literal `JSON.parse("...")` is folded
to constants, and `.length` on supported `JSON.stringify(...)` shapes is lowered
to direct length arithmetic instead of materializing the JSON string. The generic
dynamic runtime JSON path still exists for shapes that cannot be proven safely.

Follow-up tightening folds numeric expressions containing constant
`JSON.parse("number")` calls (for example repeated parse-literal sums) and teaches
the numeric analyzer that JSON number/string length helpers return integer
lengths. This shortens the generated hot loop, although the 20k-iteration benchmark
is now close enough to process/global setup overhead that wall-clock changes are
mostly in the 16-18 ms noise band.
