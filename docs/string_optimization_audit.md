# String Optimization Audit

This document classifies the current string optimizations after the string
benchmark push. The goal is to keep the AOT wins, but stop adding benchmark-only
peepholes until the underlying analyses are generalized.

## Policy

- Prefer representation and runtime substrate work first: code-unit accessors,
  Latin1/UTF-16 storage, shared scanners, builders, and non-heap literals.
- Treat narrow emitter matchers as last-stage micro tuning. They are allowed
  only with explicit guards, a normal runtime fallback, and conformance variants
  that cover guard failure.
- When the same idea appears in multiple benchmarks, promote it to an IR/dataflow
  pass instead of adding another local matcher.
- RegExp-facing work must keep strings behind the accessor/view interface. New
  optimizations should not reintroduce direct `ts_string*` data access.

## Classification

| Area | Current status | Classification | Required hardening |
| --- | --- | --- | --- |
| `ts_strview`, typed len/data/flags accessors, Latin1/UTF-16 code-unit storage | Shared by runtime, generated C, literals, views, search, split, replace, concat | General substrate | Keep all RegExp scanners on the same view/accessor API |
| static literal non-heap strings | Literal strings are emitted as static `ts_string` values with flags/hash | General substrate | Extend only through emitter/runtime literal boundaries |
| `ts_str_concat_many` | Primitive concat chains precompute total code-unit length and copy once | General substrate | Reuse for template and `String.prototype.concat`; keep object/side-effect fallback |
| split/join and replace metric helpers | Runtime helpers compute metrics without materializing when patterns are simple | Generalizable helper | Keep `$`, empty separator, non-string, and out-of-range fallbacks covered |
| non-escaping slice scalarization | Local slice/substring allocation is replaced with `(base,start,len)` state | Generalizable analysis | Promote to escape/materialization analysis before adding more shapes |
| invariant search/replace/split/case metric hoists | Loop-invariant string operations are hoisted or metricized | Generalizable analysis | Move repeated matcher logic into an IR pass with dominance and mutation checks |
| dynamic source/pattern table hoists | Runtime-selected strings/patterns are tabled before the hot loop | Useful but narrow | Generalize selection parsing beyond fixed if-chain layouts |
| `parse_source_select4` / `parse_pair_select4` | Recognizes exactly four-way `if/else if` selection | Narrow peephole | Treat as final tuning until a real switch/select representation exists |
| masked Unicode metric cycle folding | Recognizes a specific masked-index, fixed-cycle loop | Narrow peephole | Keep as benchmark-specific unless a loop-period analysis is introduced |
| concat-chain metric scalarization (`_fccm_*`) | Recognizes `prefix + i + sep + marker + tail` plus four metrics | Narrow peephole | Do not broaden locally; replace with materialization/metric analysis if reused |
| escape-result result tables | Precomputes a small table of replacement/split outputs | Useful but narrow | Generalize through loop-invariant allocation sinking/materialization analysis |

## Guardrail Tests

The conformance suite includes `strings/optimizer_guardrails.ts`. It checks:

- concat flattening keeps numeric-prefix semantics such as `1 + 2 + "x"`.
- concat-chain metric scalarization falls back when the marker appears in the
  prefix or is a digit that could appear inside the numeric component.
- zero-iteration concat-chain loops preserve the previous `last` value.
- materialization side-table loops preserve the previous `last` value on zero
  iterations, including dynamic result-table hoists.
- materialized string temporaries that are observed later keep normal semantics.
- four-way polymorphic pattern hoists preserve the default branch for out-of-range
  selectors.
- three-way pattern selection stays correct without relying on the four-way
  parser.
- replacement `$` patterns and empty split separators force runtime fallback.

Any future narrow string matcher should add similar conformance variants before
it is used to claim performance coverage.

## Current Cleanup

Session 190 started the mechanical cleanup that can be done before RegExp:

- `emit_checked_loop` centralizes the generated-C counted loop skeleton that
  evaluates the lowered condition body and breaks on falsy condition.
- `emit_runtime_loop` centralizes the normal fallback loop used when a string
  peephole guard fails.
- `emit_select4_clamped` centralizes the four-way selector clamp used by dynamic
  source/pattern table hoists.
- The late concat-chain, dynamic-source, polymorphic-pattern, masked-metric, and
  dynamic-pattern peepholes now share those helpers where practical.
- Session 191 extended the same loop/fallback cleanup to the older split/join,
  replace, and case/trim metric and escape-result matchers.
- Session 192 put `parse_source_select4` and `parse_pair_select4` on top of a
  shared `Select4<N>` parser and centralized four-value `tsv` table emission.
- Session 193 wrote `docs/string_metric_ir_pass_design.md`, which defines the
  side-table plan that will move metric-only recognition and safety checks out
  of `emit_c.rs` without changing the Escape IR JSON schema first.
- Session 194 implemented the first side-table pass in
  `analyzer/src/string_metrics.rs` for static and dynamic search-pair metric
  ranges. At that point `emit_c` consumed the plan for generic loop-body metrics
  before falling back to the older emitter peepholes during migration.
- Session 195 extended the side-table pass to static and dynamic replace metrics.
  Planned replace metrics carry a replay range, and `emit_c` emits the original
  instructions in the fallback branch when the runtime metric helper returns a
  negative marker.
- Session 196 extended the side-table pass to static and dynamic split/join
  metrics, removed the old generic search/replace/split metric emitter
  fallbacks, and split the remaining dynamic fused-loop validation into pure
  shape matchers instead of throwaway C emission. The same dynamic metric shape
  matchers now back the polymorphic replace/split fused paths, removing another
  copy of those sequence checks from the emitter.
- Session 197 split more fused loop-level string paths into parser and emitter
  halves: dynamic source search, dynamic replace/split escape-result table
  hoists, and polymorphic pattern search. Escape-result paths still stay in
  `emit_c.rs` because they materialize and root observable result strings.
- Session 198 split the remaining invariant escape-result fused loops
  (`split/join`, `replace`, and case/trim) into parser and emitter halves, and
  moved the invariant metric/escape fused loops onto the shared counter-tail
  matcher. The materialization-sensitive root/unroot and zero-iteration behavior
  remains in emitter wrappers.
- Session 199 added `StringMaterializationPlan` in
  `analyzer/src/string_materialization.rs` and moved the current invariant
  escape-result plus dynamic four-way replace/split result-table recognizers
  behind that side table. `emit_c` still owns construction, rooting, fallback,
  and loop emission.
- Session 201 moved the invariant case/trim metric-only full-loop shape into
  `StringMetricPlan` and split the shared path/use/def helpers into
  `analyzer/src/string_plan.rs`, so metric and materialization analysis no
  longer duplicate that scaffolding.
- Session 202 fixed string iterator consumers that are already modeled as
  built-in iterable paths. `for...of` and `yield*` now lower string iteration by
  `codePointAt`/`fromCodePoint` and advance by one or two UTF-16 code units, and
  runtime `ts_array_push_all` now spreads strings by code point for array spread
  and `Array.from`.
- Session 205 kept RegExp deferred but hardened the boundary: regex literals,
  `RegExp(...)`, `RegExp` as a value, and static `globalThis.RegExp` reads/calls
  now reject at export time instead of reaching runtime as undefined or dynamic
  calls. Binary bitwise string/any coercion was also conformance-locked before
  returning to RegExp work.
- Session 206 added the first RegExp-facing substrate without enabling RegExp:
  `ts_regexp_litprefix_find_view` wraps the existing view scanner contract,
  `classifyRegExpLiteral` extracts conservative literal-prefix metadata in the
  exporter, and `tests/regexp_aot_gate.sh` guards that no-RegExp programs emit
  no RegExp/QuickJS support.

This is intentionally behavior-preserving cleanup. It does not make the narrow
matchers more powerful; it makes the fallback policy and future IR-pass migration
easier to audit.

## Next Direction

1. Prepare the QuickJS `libregexp`/`libunicode` adapter as a separate optional
   runtime module. Generated C should mark `TSAOT_NEEDS_REGEXP`, and no-RegExp
   programs must keep emitting no RegExp support.
2. Start accepted RegExp syntax with literal-prefix-only cases that can call
   `ts_regexp_litprefix_find_view`; do not enable full fallback until the
   adapter and link gating are both present.
3. Decide separately whether array destructuring from non-array iterables should
   be widened beyond the current index-based implementation; do not mix that
   semantic expansion into RegExp scanner work.
4. Keep unsupported RegExp patterns behind exporter rejects until a real runtime
   fallback or compiled scanner path exists.
5. Revisit local micro tuning only after the general representation and RegExp
   paths are stable.
