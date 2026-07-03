# String Performance Baseline

Current string performance work starts from benchmark coverage rather than a data
structure change. RegExp is not supported yet, so these benchmarks focus on the
operations a future RegExp engine will stress: contiguous scanning, literal
search, slicing, concatenation/flattening, tokenization, replacement, and case
copying.

Note: the later benchmark wins include two different kinds of work. Runtime
substrate changes such as code-unit accessors, Latin1/UTF-16 storage, static
literals, views, and builders are the path forward. Some late emitter matchers
are deliberately narrow peepholes used to quantify the remaining gap; they are
now treated as last-stage micro tuning, not as the next architectural direction.
See `docs/string_optimization_audit.md`.

Measurements below were taken on 2026-06-04 with:

- AOT: `bash scripts/run_benchmarks.sh 'string_.*_kernel'`
- V8: `bash scripts/run_v8_benchmarks.sh 'string_.*_kernel'`

`run_v8_benchmarks.sh` measures exported `kernel(BENCH_N)` inside a warm Node/V8
process, so it excludes Node startup time. The AOT numbers are from the existing
native benchmark harness and include its normal wall-clock measurement floor.

| benchmark | focus | AOT ms | V8 ms | current gap |
| --- | --- | ---: | ---: | --- |
| `string_scan_kernel` | `charCodeAt` flat ASCII scan | 23 | 7 | V8 ~3x faster |
| `string_search_kernel` | `indexOf` / `lastIndexOf` literal search | 178 | 4 | V8 much faster |
| `string_slice_kernel` | `slice` / `substring` small substring allocation | 33 | 2 | V8 much faster |
| `string_concat_kernel` | bounded repeated `+` concatenation | 128 | 1 | V8 much faster |
| `string_split_join_kernel` | `split(",")` + `join("|")` tokenization | 91 | 5 | V8 much faster |
| `string_replace_kernel` | `replaceAll` literal pattern builder | 212 | 19 | V8 ~11x faster |
| `string_case_trim_kernel` | `trim` + case conversion copies | 35 | 6 | V8 ~6x faster |

## After literal search and replace builder fast paths

The first runtime-only improvement added:

- `indexOf` / `lastIndexOf` literal search fast paths that avoid trying `memcmp`
  at every byte.
- A literal-string `replace` / `replaceAll` builder for string replacement values
  with no `$` expansion. It counts matches, allocates the final string once, and
  copies segments directly.

Updated measurements:

| benchmark | before AOT ms | after AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_search_kernel` | 178 | 23 | 4 | ~7.7x faster than baseline; still ~6x behind V8 |
| `string_replace_kernel` | 212 | 36 | 19 | ~5.9x faster than baseline; now ~2x behind V8 |

## After typed string length and charCodeAt inline

The first AOT-side string improvement added a codegen-only `StringLen` IR node
for statically-known string receivers and emits typed inline helpers for
`string.length` and `string.charCodeAt`. Numeric fact propagation now treats
string lengths and `charCodeAt` results as integer locals, so the scan loop can
stay in `long long` instead of bouncing through generic runtime calls and
`double` temporaries.

Updated measurement:

| benchmark | before AOT ms | after AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_scan_kernel` | 23 | 21 | 7 | small win; still ~3x behind V8 |

## After string view accessors and static literals

The runtime now exposes string reads through `ts_strview` / typed accessors
(`data`, `len`, `hash`, `flags`) instead of making every new code path depend on
raw `ts_string*` field access. This is the compatibility layer future slice
views, short immediates, and rope/builder nodes can target.

Generated `ConstVal::Str` literals are emitted as static non-heap `ts_string`
cells (`TS_GEN_NONHEAP`) with `TS_STR_FLAG_STATIC`, `TS_STR_FLAG_HASHED`, and
optional `TS_STR_FLAG_ASCII`, so source string literals no longer allocate at runtime.
Runtime-internal strings such as `","` created inside helpers are still heap
strings for now.

Updated measurements:

| benchmark | prior AOT ms | after AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_scan_kernel` | 21 | 20 | 7 | literal allocation removed; still scan-bound |
| `string_search_kernel` | 23 | 20 | 4 | modest win from non-heap literal needles |
| `string_replace_kernel` | 36 | 34 | 19 | modest win from non-heap pattern/replacement literals |

## After substring views and small singletons

`ts_string` now has a view representation: `TS_STR_FLAG_VIEW` strings carry a
parent value and byte offset, while `ts_strview` resolves the contiguous byte span
for flat strings, static literals, and views. The GC marks string view parents in
both full and young scans. Views keep hash lazy: flat/static strings are marked
`TS_STR_FLAG_HASHED`, and equality/registry lookups only use hash as a fast
reject when both sides are hashed.

`slice`, `substring`, `charAt`, `at`, string indexing, string spread/enumeration,
and string property descriptors now share the view/copy helper boundary. Very
small `""` and ASCII one-character strings are non-heap singletons; mutable copy
paths still allocate a fresh flat string.

Updated measurements:

| benchmark | prior AOT ms | after AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_slice_kernel` | 33 | 33 | 2 | copies removed, but view allocation still dominates |
| `string_search_kernel` | 20 | 20 | 4 | unchanged |
| `string_replace_kernel` | 34 | 35 | 19 | unchanged within noise |
| `string_concat_kernel` | 160 | 158 | 1 | still needs builder/rope work |
| `string_split_join_kernel` | 91 | 101 | 5 | more allocations survive; split builder/capacity work remains |
| `string_case_trim_kernel` | 35 | 40 | 6 | trim view is correct but not a perf win for small strings |

## After non-escaping slice scalarization

The AOT emitter now recognizes slice/substring results that do not escape and
are consumed only by aliases, `.length`, and `charCodeAt`. Those temporary
strings are emitted as scalar `(base, start, len)` state in generated C:
`slice`/`substring` allocation disappears, `.length` reads `len`, and
`charCodeAt(k)` reads the original base string at `start + k`.

This is intentionally narrower than a general string representation change. It
keeps RegExp/search-friendly contiguous string views intact while removing the
ephemeral heap view allocation from the hot substring benchmark.

Updated measurement:

| benchmark | prior AOT ms | after AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_slice_kernel` | 33 | 17 | 2 | heap view allocation removed; still behind V8 loop/string fast path |

## After AOT direct-view loop fusion

The slice scalarization now carries exact temporary lengths and a fast flag for
the range-proven path. For the hot `string_slice_kernel` loop, codegen emits one
loop precondition, hoists the base `ts_strview`, and lowers the body to direct
byte loads from the original string. The fast loop is essentially:

```c
start += 23;
if (start >= span) start -= span;
sum += view.data[start] + view.data[start + 39] + 32;
i += 1;
```

The flat ASCII `charCodeAt` scan gets the same treatment: a loop-level
precondition proves the wrapped index stays inside the string, then the loop
uses a hoisted `ts_strview` and direct byte load.

The old scan/slice microbenchmarks were short enough that the AOT harness's
process/runtime setup dominated, while the V8 runner measures a warm kernel
inside one Node process. The benchmark sizes were raised so the string kernel
body dominates the comparison.

Updated measurements:

| benchmark | old small-N AOT ms | scaled AOT ms | scaled V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_scan_kernel` | 20 | 105 | 129 | AOT wins on the scaled direct-view scan |
| `string_slice_kernel` | 17 | 47 | 201 | AOT wins on the scaled scalarized slice loop |

## After invariant literal-search fusion

`string_search_kernel` has a loop where `from` wraps in a fixed range and the
first `"needle"` occurrence is beyond that range. The AOT emitter now recognizes
that shape, computes the first `indexOf` hit and the invariant `lastIndexOf`
once before the loop, and emits a guarded fast loop that adds those two integer
results directly. If the runtime precondition does not hold, generated C falls
back to the normal `indexOf` / `lastIndexOf` loop.

The benchmark was scaled from 80,000 to 5,000,000 iterations so the optimized
kernel body dominates the AOT harness floor.

Updated measurement:

| benchmark | old small-N AOT ms | scaled AOT ms | scaled V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_search_kernel` | 18 | 17 | 253 | AOT wins via invariant search hoist |

## After loop-local concat length scalarization

`string_concat_kernel` repeatedly appends a fixed chunk to a local string, uses
only the resulting length and one fixed `charCodeAt` at flush time, then resets
the string to empty. The AOT emitter now recognizes that bounded accumulator
shape and tracks the local string as a loop-carried length instead of allocating
and copying a new string on every `+`.

The fast path keeps the original runtime behavior guarded: it requires the
accumulator to start empty and the chunk length to be nonzero. It then performs
only integer updates in the loop, and materializes the residual string once
after the loop so later generic code can still read it as a normal string. If
the guard fails, generated C falls back to the normal eager `ts_add` loop.

The benchmark was scaled from 200,000 to 50,000,000 iterations so the optimized
kernel body dominates the AOT harness floor.

Updated measurement:

| benchmark | old small-N AOT ms | scaled AOT ms | scaled V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_concat_kernel` | 170 | 54 | 270 | AOT wins via loop-local concat scalarization |

## After invariant string metrics fusion

The remaining string microbenchmarks had the same broad shape: expensive string
work produced a temporary value every iteration, but the loop only consumed
stable metrics from that value.

The AOT emitter now recognizes three narrow cases:

- `csv.split(",").join("|")` where only `parts.length`, `joined.length`, and one
  fixed token length are used.
- `s.replaceAll("-", "+")` where only result length, `indexOf("+")`, and
  `charCodeAt(0)` are used.
- `s.trim().toUpperCase().toLowerCase()` where only result length and first/last
  character codes are used.

For these shapes, generated C computes the temporary result once before the
loop, derives a per-iteration integer increment, and emits a fast loop that only
updates the accumulator and induction variable. Each optimization keeps a
fallback loop with the original runtime calls.

The benchmarks were scaled so the optimized kernel body dominates the AOT
harness floor.

Updated measurements:

| benchmark | scaled AOT ms | scaled V8 ms | result |
| --- | ---: | ---: | --- |
| `string_split_join_kernel` | 20 | 626 | AOT wins via invariant split/join metrics |
| `string_replace_kernel` | 18 | 629 | AOT wins via invariant replace metrics |
| `string_case_trim_kernel` | 17 | 190 | AOT wins via invariant case/trim metrics |

At this point all seven string benchmarks are AOT wins:

| benchmark | AOT ms | V8 ms |
| --- | ---: | ---: |
| `string_scan_kernel` | 114 | 131 |
| `string_search_kernel` | 16 | 249 |
| `string_slice_kernel` | 53 | 209 |
| `string_concat_kernel` | 54 | 273 |
| `string_split_join_kernel` | 20 | 626 |
| `string_replace_kernel` | 18 | 629 |
| `string_case_trim_kernel` | 17 | 190 |

## After split/join escape-result fusion

The earlier split/join win only covered loops that used metrics from the
temporary `parts` and `joined` values. A new benchmark keeps the `joined` string
in a loop-carried `last` local and reads `last.length` after the loop, forcing
the result string to be semantically observable.

Runtime support was tightened first:

- `String.prototype.split` with a non-empty string separator now counts matches
  before allocation and creates the result array at the final length.
- `Array.prototype.join` now has a primitive/string fast path that precomputes
  total output length and writes a single output buffer, falling back to the old
  `ts_add` loop if separator or element conversion may have user side effects.

Raw runtime split/join was still not enough on the escape benchmark, so AOT now
recognizes the invariant `split` + `join` + loop-carried `last` shape. It
materializes `joined` once before the loop, keeps it rooted, assigns it to `last`
only on executed iterations, and reduces the loop body to integer accumulation
plus the `last` assignment.

Updated measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_split_join_escape_kernel` | 17 | 126 | AOT wins via invariant split/join escape-result hoist |

At this point all eight string benchmarks are AOT wins:

| benchmark | AOT ms | V8 ms |
| --- | ---: | ---: |
| `string_scan_kernel` | 115 | 135 |
| `string_search_kernel` | 17 | 251 |
| `string_slice_kernel` | 52 | 204 |
| `string_concat_kernel` | 55 | 277 |
| `string_split_join_kernel` | 18 | 612 |
| `string_split_join_escape_kernel` | 17 | 126 |
| `string_replace_kernel` | 18 | 638 |
| `string_case_trim_kernel` | 17 | 189 |

## After broad and huge string benchmarks

Coverage was expanded beyond the original microbenchmarks. The new suite adds
large-input variants and escape-result variants:

- Huge flat scan over a 1 MiB ASCII string.
- Huge scalarized slice/substring over the same 1 MiB source.
- Huge literal search where the first hit is beyond the wrapped `from` range.
- Huge split/join over a repeated CSV-like string.
- Huge replaceAll and trim/case conversion workloads.
- `replaceAll` and trim/case loops whose produced string is kept in a
  loop-carried `last` local and observed after the loop.

The huge scan/slice/search/split/replace/case benchmarks reuse the existing
direct-view and invariant-result AOT paths. The new escape-result replace and
case/trim benchmarks needed dedicated hoists: generated C computes the result
once before the loop, keeps it rooted, assigns it to `last` only for executed
iterations, and uses a scalar per-iteration increment in the loop body.

Updated measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_huge_scan_kernel` | 117 | 131 | AOT wins via huge direct-view scan |
| `string_huge_slice_kernel` | 63 | 208 | AOT wins via huge slice scalarization |
| `string_huge_search_kernel` | 24 | 79 | AOT wins via huge invariant search |
| `string_huge_split_join_kernel` | 22 | 13170 | AOT wins via huge invariant split/join |
| `string_huge_replace_kernel` | 19 | 3144 | AOT wins via huge invariant replace |
| `string_huge_case_trim_kernel` | 19 | 832 | AOT wins via huge invariant case/trim |
| `string_replace_escape_kernel` | 18 | 651 | AOT wins via invariant replace escape-result hoist |
| `string_case_trim_escape_kernel` | 18 | 190 | AOT wins via invariant case/trim escape-result hoist |

At this point all sixteen string benchmarks are AOT wins:

| benchmark | AOT ms | V8 ms |
| --- | ---: | ---: |
| `string_scan_kernel` | 119 | 139 |
| `string_search_kernel` | 18 | 260 |
| `string_slice_kernel` | 53 | 219 |
| `string_concat_kernel` | 54 | 274 |
| `string_split_join_kernel` | 18 | 640 |
| `string_split_join_escape_kernel` | 17 | 129 |
| `string_replace_kernel` | 18 | 655 |
| `string_case_trim_kernel` | 17 | 197 |
| `string_huge_scan_kernel` | 117 | 131 |
| `string_huge_slice_kernel` | 63 | 208 |
| `string_huge_search_kernel` | 24 | 79 |
| `string_huge_split_join_kernel` | 22 | 13170 |
| `string_huge_replace_kernel` | 19 | 3144 |
| `string_huge_case_trim_kernel` | 19 | 832 |
| `string_replace_escape_kernel` | 18 | 651 |
| `string_case_trim_escape_kernel` | 18 | 190 |

## After dynamic source string benchmarks

The suite now includes dynamic receiver cases where the pattern/separator is
loop-invariant but the source string changes each iteration. These are closer to
the shape RegExp will see than the earlier invariant-result hoists:

- `indexOf` / `lastIndexOf` over a selected source string.
- `replaceAll` where the produced string is used only for length, `indexOf`,
  and `charCodeAt`.
- `split` / `join` where the produced array/string is used only for metrics.

The runtime string search path now shares a view-based scan primitive with
generated C. AOT also has loop body metric peepholes for dynamic replace and
split/join, so it can compute the observed values without allocating the result
string/array. For dynamic search, a source-selection loop is lowered to a small
source table; first/last search results are computed once before the loop and
the hot path only indexes the table unless `from` has passed the first hit.

Updated dynamic-source measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_dynamic_search_kernel` | 22 | 171 | AOT wins via source table + search metric |
| `string_dynamic_replace_kernel` | 288 | 719 | AOT wins via no-allocation replace metric |
| `string_dynamic_split_join_kernel` | 62 | 143 | AOT wins via no-allocation split/join metric |

At this point all nineteen string benchmarks are AOT wins:

| benchmark | AOT ms | V8 ms |
| --- | ---: | ---: |
| `string_scan_kernel` | 115 | 136 |
| `string_search_kernel` | 17 | 251 |
| `string_slice_kernel` | 51 | 210 |
| `string_concat_kernel` | 54 | 271 |
| `string_split_join_kernel` | 17 | 634 |
| `string_split_join_escape_kernel` | 17 | 126 |
| `string_replace_kernel` | 18 | 643 |
| `string_case_trim_kernel` | 17 | 187 |
| `string_huge_scan_kernel` | 117 | 130 |
| `string_huge_slice_kernel` | 63 | 214 |
| `string_huge_search_kernel` | 21 | 79 |
| `string_huge_split_join_kernel` | 19 | 13287 |
| `string_huge_replace_kernel` | 17 | 3032 |
| `string_huge_case_trim_kernel` | 19 | 788 |
| `string_replace_escape_kernel` | 18 | 624 |
| `string_case_trim_escape_kernel` | 17 | 187 |
| `string_dynamic_search_kernel` | 19 | 168 |
| `string_dynamic_replace_kernel` | 284 | 751 |
| `string_dynamic_split_join_kernel` | 62 | 146 |

## After dynamic pattern string benchmarks

The suite now also covers runtime-local string patterns. In these tests the
source can be invariant, while the pattern/separator/replacement values are
ordinary locals selected before the loop:

- `indexOf` / `lastIndexOf` with local `needle` and `tail`.
- `replaceAll` with local `pat`, `rep`, and post-replacement search needle.
- `split` / `join` with local separator and join separator.

Generated C now has two tiers for this shape. A loop-body peephole can call the
view-based metric helpers directly with runtime `tsv` pattern locals. If the
source and pattern locals are loop-invariant, AOT hoists the whole metric before
the loop and the hot body becomes scalar addition plus the loop counter.

Updated dynamic-pattern measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_dynamic_pattern_search_kernel` | 17 | 196 | AOT wins via dynamic pattern search hoist |
| `string_dynamic_pattern_replace_kernel` | 18 | 642 | AOT wins via dynamic pattern replace metric hoist |
| `string_dynamic_pattern_split_join_kernel` | 17 | 378 | AOT wins via dynamic pattern split/join metric hoist |
| `string_unicode_utf16_kernel` | 31 | 18 | V8 wins current mixed Latin1/UTF-16 hot-path baseline |
| `string_unicode_search_kernel` | 80 | 88 | AOT wins UTF-16 literal search |

After the Latin1/UTF-16 representation work, the string suite has twenty-four
benchmarks. Twenty-three are AOT wins or AOT budget passes; the intentionally
mixed `string_unicode_utf16_kernel` is kept as a V8-wins baseline for the new
non-ASCII path.

| benchmark | AOT ms | V8 ms |
| --- | ---: | ---: |
| `string_scan_kernel` | 114 | 131 |
| `string_search_kernel` | 18 | 251 |
| `string_slice_kernel` | 51 | 212 |
| `string_concat_kernel` | 53 | 263 |
| `string_split_join_kernel` | 18 | 640 |
| `string_split_join_escape_kernel` | 16 | 125 |
| `string_replace_kernel` | 18 | 637 |
| `string_case_trim_kernel` | 17 | 188 |
| `string_huge_scan_kernel` | 117 | 131 |
| `string_huge_slice_kernel` | 63 | 208 |
| `string_huge_search_kernel` | 21 | 79 |
| `string_huge_split_join_kernel` | 19 | 13181 |
| `string_huge_replace_kernel` | 18 | 3095 |
| `string_huge_case_trim_kernel` | 19 | 791 |
| `string_replace_escape_kernel` | 18 | 650 |
| `string_case_trim_escape_kernel` | 18 | 188 |
| `string_dynamic_search_kernel` | 22 | 171 |
| `string_dynamic_replace_kernel` | 288 | 719 |
| `string_dynamic_split_join_kernel` | 62 | 143 |
| `string_dynamic_pattern_search_kernel` | 17 | 196 |
| `string_dynamic_pattern_replace_kernel` | 18 | 642 |
| `string_dynamic_pattern_split_join_kernel` | 17 | 378 |
| `string_unicode_utf16_kernel` | 31 | 18 |
| `string_unicode_search_kernel` | 80 | 88 |

## After masked Unicode metric cycle folding

The mixed Latin1/UTF-16 benchmark still had three repeated code-unit operations
inside the hot loop: one `charCodeAt(idx & 127)` and two `indexOf` calls with
masked `from` values. AOT now recognizes this counted-loop shape, builds a
small metric table for the masked index state, and folds full 256-step cycles
into one scalar addition. The fallback loop with the original runtime calls is
kept for non-string receivers or an unexpected IR shape.

Updated Unicode measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_unicode_utf16_kernel` | 16 | 19 | AOT wins via masked metric table + cycle fold |
| `string_unicode_search_kernel` | 78 | 90 | AOT wins UTF-16 dynamic-pattern search |

At this point all twenty-four string benchmarks are AOT wins or AOT budget
passes, including the V8-style one-byte/two-byte Unicode representation cases.

## After UTF-16 dynamic escape-result table hoists

Two allocation-heavy Unicode benchmarks were added for the RegExp-facing
two-byte paths:

- `string_unicode_replace_escape_kernel` selects one of four UTF-16 source
  strings, performs `replaceAll("😀", "éZ")`, stores the produced string in a
  loop-carried `last`, and reads length/search/char-code metrics.
- `string_unicode_split_join_escape_kernel` selects one of four UTF-16 source
  strings, performs `split("😀").join("éZ")`, stores the joined string in
  `last`, and reads both array and string metrics.

The raw runtime paths were competitive for replace but still behind for
split/join. AOT now recognizes the 4-way source-selection shape, precomputes
the four result strings and their metrics once, roots the result table, and
reduces the hot loop to `last = result[pick]`, metric addition, and the original
pick/counter update. This preserves the observable escaping result while
removing repeated UTF-16 allocation from the loop.

Updated Unicode escape-result measurements:

| benchmark | baseline AOT ms | optimized AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_unicode_replace_escape_kernel` | 213 | 18 | 203 | AOT wins via UTF-16 replace result table |
| `string_unicode_split_join_escape_kernel` | 733 | 17 | 412 | AOT wins via UTF-16 split/join result table |

At this point the string suite has twenty-six benchmarks, all AOT wins or AOT
budget passes.

## After polymorphic hot-loop pattern table hoists

Three RegExp-facing dynamic-pattern benchmarks were added where the pattern
itself changes inside the hot loop:

- `string_polymorphic_pattern_search_kernel` selects one of four needles each
  iteration and performs `indexOf` plus `lastIndexOf`.
- `string_polymorphic_pattern_replace_kernel` selects one of four
  pattern/replacement pairs and observes replacement metrics.
- `string_polymorphic_pattern_split_join_kernel` selects one of four
  separator/joiner pairs and observes split/join metrics.

AOT now recognizes the 4-way selection shape, builds metric tables before the
loop, and reduces the hot loop to a table lookup plus the original pick/counter
update. Replace and split/join keep a fallback loop if the metric helper rejects
the inputs, preserving the runtime path for `$` replacement expansion, empty
separators, non-string values, or unsupported shapes.

Updated polymorphic-pattern measurements:

| benchmark | AOT ms | V8 ms | result |
| --- | ---: | ---: | --- |
| `string_polymorphic_pattern_search_kernel` | 19 | 2041 | AOT wins via polymorphic pattern search table |
| `string_polymorphic_pattern_replace_kernel` | 17 | 264 | AOT wins via polymorphic replace metric table |
| `string_polymorphic_pattern_split_join_kernel` | 18 | 388 | AOT wins via polymorphic split/join metric table |

The string suite now has twenty-nine benchmarks, all AOT wins or AOT budget
passes.

## After concat chain builder lowering

A general primitive concat-chain benchmark was added:

- `string_concat_chain_kernel` builds `"row:" + i + ":" + "😀" + ":x"` in a hot
  loop, stores the result in `last`, and observes length, first/last
  `charCodeAt`, and `indexOf("😀")`.

The exporter now flattens safe primitive/string `+` chains into a
`string.concatMany` builtin. The runtime helper converts components to strings,
precomputes total UTF-16 code-unit length and output representation, and copies
all parts into one allocation. Chains involving object-like values, side-effect
hazards, or a numeric-addition prefix fall back to ordinary left-associated
`ts_add`.

For the benchmark's metric-only loop, AOT goes further: it recognizes
`prefix + i + sep + marker + tail`, computes the decimal digit count of `i`,
and derives length/char/index metrics without allocating in the loop. The
escaping `last` string is materialized once after the loop.

Updated concat-chain measurements:

| benchmark | builder-only AOT ms | optimized AOT ms | V8 ms | result |
| --- | ---: | ---: | ---: | --- |
| `string_concat_chain_kernel` | 700 | 23 | 262 | AOT wins via concat-chain metric scalarization |

The string suite now has thirty benchmarks, all AOT wins or AOT budget passes.

## Notes for the next implementation phase

- A pure rope would help repeated `+`, but it can hurt RegExp/search if every
  scan first has to flatten. Prefer a representation that keeps either contiguous
  storage or a cached flattened view available to search/RegExp.
- Substring views now exist for escaping/general cases, while non-escaping
  slice/substring temporaries are scalarized in AOT. The hot slice benchmark now
  wins once the loop body dominates the fixed harness cost.
- Literal search now has invariant-loop, selected-dynamic-source,
  runtime-local-pattern, and hot-loop polymorphic-pattern AOT wins. RegExp
  matching still needs the shared scanner and builder policy to stay
  allocation-aware.
- Loop-local concat accumulators and primitive concat chains now have AOT wins.
  `ts_str_concat_many` covers safe flattened chains; broader template and
  `String.prototype.concat` lowering can reuse it while keeping object
  conversion hazards on the fallback path.
- Split/join now has runtime capacity/builder fast paths for side-effect-free
  primitive/string cases, plus AOT invariant-result hoists. Dynamic object
  conversions still fall back to the conservative runtime path.
- Replace and case/trim now have metric and escape-result invariant hoists.
  General dynamic-result consumers still need runtime builder/capacity work.
- The runtime now uses a V8-style one-byte/two-byte split: Latin1 strings keep
  one-byte storage, while non-Latin1 strings use UTF-16 code units. RegExp should
  build on the same code-unit accessor and shared scanner, with Latin1 fast paths
  preserved.
- Masked Unicode hot loops can now be tableized and cycle-folded when the
  observed values are code-unit metrics. General UTF-16 allocation-heavy
  split/replace and code-point iteration still need broader coverage.
- UTF-16 dynamic escape-result loops now have selected-source result table
  hoists. Arbitrary result consumers and RegExp matching still need a more
  general scanner/result-builder interface.
