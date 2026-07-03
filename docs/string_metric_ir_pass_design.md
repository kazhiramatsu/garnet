# String Metric IR Pass Design

The current string benchmark wins include a useful but fragile class of
metric-only peepholes in `emit_c.rs`. They recognize loops that create or query
strings only to add derived metrics to an accumulator. This document defines the
next migration step: move recognition and safety proof out of C emission without
changing the Escape IR JSON schema yet.

## Goals

- Keep the current AOT wins while stopping the growth of local emitter-only
  pattern matchers.
- Give string metrics one shared analysis boundary for invariance, mutation,
  escape, and materialization checks.
- Preserve the current fallback policy: if a runtime metric helper cannot prove
  its fast case, replay the original instructions.
- Keep string data behind the existing accessor/view/runtime helper interface so
  RegExp can reuse the same string substrate later.

## Non-Goals

- Do not implement RegExp in this pass.
- Do not add rope, builder, short-immediate, or new string representation logic
  here.
- Do not broaden benchmark-shaped patterns while moving the logic. The first
  migration should accept exactly the current search metric shape.
- Do not change the exporter/analyzer JSON schema in the first step.

## Original Problem

Metric-only string peepholes originally lived directly in the loop emitter:

- `try_emit_search_pair_metric_peephole`
- `try_emit_dynamic_search_pair_metric_peephole`
- `try_emit_replace_metric_peephole`
- `try_emit_dynamic_replace_metric_peephole`
- `try_emit_split_join_metric_peephole`
- `try_emit_dynamic_split_join_metric_peephole`
- `try_emit_string_metric_loop_body`

Each function mixes four concerns:

- recognizing the IR instruction sequence,
- proving skipped locals are dead after the skipped range,
- deciding whether materialization can be removed,
- emitting the final C code and fallback path.

That is workable for one or two cases, but it makes it too easy to add another
benchmark-shaped matcher. The migration should make the emitter consume a
precomputed plan instead of being the analysis pass.

## Placement

Add a new analyzer module, initially named `string_metrics`.

The first integration should be side-table based:

```rust
let metric_plan = string_metrics::analyze_program(&prog);
print!("{}", emit_c::emit_program_with_string_metrics(&prog, &res, &metric_plan));
```

The existing `emit_program(&prog, &res)` entry point can call the new function
with an empty or computed plan to keep callers simple.

The pass should run after SROA in emit mode. SROA can remove temporary objects
and rewrite local use chains, so loop identity and dead-local checks should be
computed on the final IR that codegen will see.

The pass should not mutate `Program` in the first milestone. A side table avoids
schema churn and keeps escape analysis unchanged. If the plan proves stable,
later work can introduce explicit IR instructions such as
`StringSearchMetricAdd`.

## Plan Data Model

Loop identity must not depend on C labels, because labels are generated during
emission. Use a structural path assigned by traversing function bodies after
SROA:

```rust
pub struct StringMetricPlan {
    pub functions: BTreeMap<u32, FunctionMetricPlan>,
}

pub struct FunctionMetricPlan {
    pub loops: BTreeMap<LoopPath, LoopMetricPlan>,
}

pub struct LoopPath(pub Vec<u32>);

pub struct LoopMetricPlan {
    pub body_ranges: BTreeMap<usize, MetricOp>,
}
```

`LoopPath` is the index path to an `Inst::Loop` inside a function body. For
example, the top-level third instruction is `[2]`; an inner loop inside that
loop body's fifth instruction is `[2, body, 4]` in implementation terms. The
Rust representation can encode the edge with small enum segments instead of a
plain `Vec<u32>` if that makes diagnostics clearer.

The first operation kind should cover only the existing search metric pair:

```rust
pub enum MetricOp {
    SearchPair(SearchPairMetric),
}

pub struct SearchPairMetric {
    pub start: usize,
    pub len: usize,
    pub recv: u32,
    pub acc: u32,
    pub from: u32,
    pub needle1: MetricNeedle,
    pub needle2: MetricNeedle,
}

pub enum MetricNeedle {
    StaticLiteral(String),
    Local(u32),
}
```

Static literals are still resolved by emission into `TS_STRLIT_*` symbols using
the emitter's static string table. The plan should store the literal value, not
the generated C identifier.

## Safety Checks

### Invariance

For a planned metric op, the receiver and metric inputs must be loop-invariant
for the skipped range. The first milestone can use a conservative rule:

- reject if the receiver, search needles, or `from` local is defined by any
  instruction in the candidate sequence,
- reject if any of those locals is defined earlier in the same loop body before
  the candidate and that definition is part of the value being optimized across,
- reject nested control flow in the candidate sequence.

This matches the current straight-line matcher. Later dominance analysis can
replace the conservative local-scan checks.

### Mutation

JavaScript strings are immutable, so a string value local does not need a
content-mutation check. The pass still needs local rebinding checks:

- if `recv` is redefined in the candidate range, reject,
- if a dynamic needle local is redefined in the candidate range, reject,
- if `from` is redefined before the original `indexOf` call inside the candidate,
  reject.

Object/value side effects are handled by preserving evaluation order. The first
search metric migration should only skip instructions whose outputs are proven
dead and whose inputs are already available.

### Escape

The metric-only pass may remove materialization only when all skipped definition
locals are dead after the skipped range. This is the existing
`collect_defs(seq)` plus `locals_used_after(body, end, defs)` rule, but it should
live in the analysis module.

Nested `return`, `throw`, `await`, `yield`, `break`, `continue`, `try/catch`, and
nested loops should make a candidate ineligible for the first step.

### Materialization

Metric-only candidates must not handle "escape-result" loops such as `last =
replaced` or result-table hoists. Those belong to a later materialization plan.

The first pass is allowed to replace:

```text
tmp = indexOf(...)
acc = acc + tmp
tmp = lastIndexOf(...)
acc = acc + tmp
```

with a metric add only if the skipped result locals are dead. It is not allowed
to suppress a string value that is observed later.

### Escape-Result Materialization Plan

Escape-result loops should migrate through a separate side-table plan, not by
stretching the metric-only operations. The first materialization plan should
carry:

- the loop path and candidate instruction range,
- the produced result local that is assigned to the observable `last` local,
- the metric accumulator local and per-iteration metric increment,
- the source/pattern/replacement/select inputs needed to build result tables,
- the root/unroot lifetime requirements for precomputed string results,
- the fallback replay range for helpers that can decline a fast path.

Zero-iteration behavior is part of the plan contract. If the original loop does
not execute, the previous `last` value must remain unchanged. Planned emitters
therefore may precompute and root candidate results before the checked loop, but
must assign the observable result local only inside the emitted fast loop.

Root lifetime is also observable through generated C safety. Precomputed result
strings or result tables must remain rooted for the whole fast loop and must not
be unrooted before any fallback replay that can still observe them. The first
implementation should keep root/unroot emission in `emit_c.rs`, with the
analysis plan describing only which values require protection.

The first materialization migration should accept only the current table-hoist
shapes:

- invariant `split().join()` escape-result,
- invariant `replaceAll()` escape-result,
- invariant case/trim escape-result,
- dynamic four-way source `replaceAll()` and `split().join()` result tables.

For dynamic source table hoists, table construction is valid only when the
selected source and pattern/replacement locals are loop-invariant and not
redefined in the candidate or fallback range. Materialized result locals that
escape beyond the known post-loop `last` use should make the candidate
ineligible until a broader escape analysis exists.

### Runtime Fallback

Search metric helpers do not currently need a negative-result fallback because
`ts_str_indexof_fast` / `ts_str_lastindexof_fast` are full semantic helpers for
the accepted shape. Replace and split/join metric helpers return negative on
unsupported cases; when those are migrated, the plan must carry the original
range so the emitter can replay it in the fallback branch.

## Emitter Contract

`emit_c.rs` should continue to own C text generation:

- C local naming,
- static literal symbol lookup,
- `emit_metric_acc_add`,
- fallback block emission,
- GC rooting rules for later materialization plans.

The `string_metrics` pass should own only:

- sequence recognition,
- dead-local checks,
- loop-path assignment,
- operation metadata.

During Sessions 194 and 195, `try_emit_string_metric_loop_body` first consulted
the plan and temporarily fell back to the older emitter peepholes when no plan
existed. Session 196 removed that migration fallback for generic loop-body
search/replace/split metrics; unplanned instructions now use normal emission.

## Initial Milestone

Move only these two recognizers into the plan:

- `try_emit_search_pair_metric_peephole`
- `try_emit_dynamic_search_pair_metric_peephole`

Status: implemented in Session 194. `analyzer/src/string_metrics.rs` now plans
static and dynamic search-pair metric ranges, and `emit_c` consumes those ranges
from the shared side-table plan.

Session 195 extended the same side-table model to replace metrics. The plan now
carries the original range length, and `emit_c` replays `body[start..start+len]`
when `ts_str_replace_literal_metric3` returns a negative fallback marker.

Session 196 extended the same replay model to split/join metrics. Generic
loop-body search, replace, and split/join metric emission now consumes only
planned ranges; the older generic emitter peephole fallbacks have been removed.
The remaining dynamic replace/split helpers in `emit_c.rs` are pure shape
matchers used by fused loop-level paths, not generic metric emitters.

Session 198 split the invariant escape-result `split/join`, `replace`, and
case/trim fused loops into pure shape matchers plus emitter wrappers. It also
put their counter-tail checks on the same matcher used by the metric fused
loops. That keeps materialization-sensitive root/unroot and zero-iteration
behavior in emission while making the recognizers ready to move into a future
side-table materialization plan.

Session 199 added `analyzer/src/string_materialization.rs` with
`StringMaterializationPlan`. The plan uses the same function/loop path model as
`StringMetricPlan`, and currently recognizes invariant `split/join`, `replace`,
case/trim escape-result loops plus dynamic four-way source replace/split result
tables. `emit_c` consumes the plan before the legacy emitter matchers while
keeping result construction, GC rooting, zero-iteration assignment, and fallback
loop emission in emitter wrappers.

Session 201 moved the remaining invariant case/trim metric-only full-loop shape
into `StringMetricPlan` as a loop-level metric op. The common loop path, use/def,
constant-match, and control-flow helpers now live in `analyzer/src/string_plan.rs`
and are shared by `string_metrics.rs` and `string_materialization.rs`.

Implementation steps:

1. Done: add `analyzer/src/string_metrics.rs` with side-table types and
   traversal.
2. Done: move equivalent local-def/use and dead-range checks into the new module
   for the first planned recognizers.
3. Done: teach `emit_c` to accept an optional `StringMetricPlan`.
4. Done: emit planned search-pair metrics from the plan.
5. Done: planned replace and split/join metrics replay the original range on
   negative helper results.
6. Done: remove old generic search/replace/split metric peephole fallbacks from
   `try_emit_string_metric_loop_body`.
7. Done: move the invariant case/trim metric-only full-loop shape into the metric
   plan and share helper analysis between metric and materialization passes.

## Tests and Checks

Required checks for the search metric migration:

- focused `optimizer_guardrails` conformance,
- full exhaustive conformance,
- targeted string search/dynamic search benchmarks,
- analyzer unit coverage that the side-table pass recognizes the static and
  dynamic search-pair ranges and rejects a skipped definition used after the
  range,
- generated C inspection after removing old emitter fallbacks, to confirm the
  planned path still emits the intended metric helper calls,
- a negative fixture where a skipped local is used after the candidate and the
  plan rejects it.

The negative fixture can be added to `optimizer_guardrails.ts` because the
observable behavior is semantic, not just code shape.

## Risks

- Loop path drift if future passes mutate `Program` after the metric analysis.
  Keep `string_metrics::analyze_program` immediately before emission, or rerun it
  after any future mutating pass.
- False positives from alias/local reuse. The first pass should prefer missed
  optimization over extra matching.
- Fallback omission for future materializing helpers. Keep the explicit replay
  range model for any operation whose runtime helper can decline the fast path.
- RegExp scanner sharing can be polluted if new code directly reads
  `ts_string*` fields. All generated code must keep using view/accessor/runtime
  helpers.

## Migration Order

1. Done: search pair metric plan, static and dynamic needles.
2. Done: replace metric plan with negative-helper fallback replay.
3. Done: split/join metric plan with negative-helper fallback replay.
4. Done: escape-result/materialization side-table contract documented; invariant
   escape-result recognizers are shape-only.
5. Done: materialization side-table for invariant escape-result and dynamic
   four-way result-table shapes.
6. Done: case/trim metric-only full-loop planning through `StringMetricPlan`.
7. Revisit narrow masked-cycle and concat-chain metric tuning only after the
   general plans are stable.
