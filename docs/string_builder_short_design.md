# Extendable string buffers and immediate short strings

## 1. Outcome

Garnet keeps contiguous string storage and does not use ropes. Two runtime
representations remove the measured allocation and copy costs:

1. a hidden extendable flat buffer with immutable prefix views for linear
   append histories;
2. an allocation-free immediate representation for ASCII strings of zero to
   five code units.

On `benchmarks/gc/gc_strings.ts`, using the same generated C workload:

| runtime | best wall time | runtime allocation |
|---|---:|---:|
| lazy hash/derived flags baseline | 31 ms | 536.5 MB |
| extendable buffer | 23 ms | 33.3 MB |
| buffer + immediate short strings | 12 ms | 18.0 MB |

The final RT_STATS decision counters were:

| counter | count |
|---|---:|
| builder extension | 223,200 |
| fresh builder buffer | 750 |
| remaining flat concat | 901 |
| immediate short result | 225,150 |

This removes the evidence for adding ropes now. Ropes would add traversal,
flattening, balancing, hashing, and GC complexity to all string consumers while
the remaining benchmark cost is already small and contiguous.

## 2. Extendable flat buffers

### 2.1 Representation

`TS_STR_FLAG_BUFFER` marks an internal `ts_string` storage owner. It is never
returned as a JavaScript value. Its `len` is the written high-water mark and its
capacity is derived from `ts_gc_header.size`, including one trailing NUL code
unit.

Every public result is an ordinary `TS_STR_FLAG_VIEW` with:

- `parent` set to the hidden buffer;
- `offset = 0`;
- `len` set to the immutable prefix visible to that result.

Storage remains one contiguous Latin-1 or UTF-16 allocation. Existing readers,
substring views, regexp integration, JSON, hashing, and C-string conversion
therefore continue to use `ts_strview`.

### 2.2 Tail ownership rule

A concat may extend a buffer only when all of the following hold:

- the left operand is a zero-offset view;
- its parent is a hidden buffer;
- the view length equals the parent's high-water mark;
- the result uses the same storage width as the parent;
- the result fits in the parent's capacity.

The length equality means only the current tail owner can append. For example:

```ts
const prefix = value;
const left = prefix + "left";
const right = prefix + "right";
```

`left` may extend the old buffer. The parent high-water mark then exceeds
`prefix.length`, so `right` must allocate a fresh buffer. No live prefix is ever
overwritten.

### 2.3 Growth and width

Results below 24 code units retain the normal flat/short paths. A fresh builder
starts with at least 32 code units and normally reserves the next power of two
at or above twice the used length. Linear `+=` histories therefore copy only
the appended suffix until capacity is exhausted.

The buffer width never changes in place. Appending UTF-16 content to a Latin-1
buffer takes the fresh-copy path, preserving all older views. A UTF-16 buffer
may accept Latin-1 suffixes because the result width remains UTF-16.

### 2.4 Moving-GC ordering

Both builder paths obey the existing stable-handle discipline:

- EXTEND roots the parent, allocates the result view before mutation, then
  re-fetches parent and suffix storage after the allocation safepoint.
- FRESH allocates and roots the buffer, allocates the result view, then
  re-fetches the buffer and all inputs before copying.

The buffer is an ordinary `TS_KIND_STRING`. Existing view-parent marking keeps
it alive, and moving GC copies its capacity because the allocation size lives
in the normal GC header.

## 3. Immediate short strings

### 3.1 Value encoding

`TS_SEL_SHORTSTR` (`0xFFFE`) is a NaN-box selector for ASCII strings up to five
code units. The 48-bit payload contains:

- bytes 0 through 4 in the low 40 bits;
- the length in payload bits 40 through 42.

These values satisfy `ts_is_str` but not `ts_is_heap_str`. They are excluded
from GC marking, pinning, and write-barrier pointer dereferences.

Compile-time static literals remain static strings and already require no
runtime allocation. Immediate strings primarily cover runtime conversions,
short concat/`concatMany` results, slices, repeat, join, JSON values, property
keys, and similar producers.

Non-ASCII strings and strings longer than five code units continue through the
flat/view/builder representations.

### 3.2 Reader contract

`ts_str_view_typed` presents heap, static, view, buffer-backed, and immediate
strings through one `ts_strview` API. An immediate view stores four bytes in the
struct's former alignment padding and an optional fifth byte in the otherwise
unused hash field while `HASHED` is clear.

This layout is deliberately 24 bytes on 64-bit hosts, matching the pre-feature
ABI. An intermediate 32-byte design caused `string_unicode_search_kernel` to
regress from roughly 80–90 ms to 108 ms because hot view arguments changed
calling convention. The final layout has a compile-time size assertion and the
kernel returned to 86–87 ms.

Content access must use `ts_str_cu_at_view`, `ts_str_view_data` with caller
scratch space, or another `ts_strview` helper. Code must not assume that every
value accepted by `ts_is_str` can be passed to `ts_ptr`.

## 4. Verification

Focused coverage includes:

- linear ASCII growth;
- Latin-1 to UTF-16 promotion;
- UTF-16 buffers with Latin-1 suffixes;
- branched histories and old-prefix immutability;
- slices of buffer-backed strings;
- template/`concatMany` extension;
- Map hashing and equality before and after parent growth;
- immediate strings through methods, Map/Set, property keys, JSON, regexp, and
  Symbol descriptions;
- a 64 MiB branch/slice/checksum fixture under O2 and ASan with
  `TSAOT_GC_YOUNG_THRESHOLD=1`.

Final validation passed:

- typed conformance: 351/351;
- untyped conformance: 351/351;
- bundler: 40/40 in typed and untyped modes;
- GC stress: 21/21 in O2 and ASan, runtime ASan, and the 64 MiB scale gate;
- frozen-emitter parity: 333 identical, 15 known differences, no unexpected
  difference;
- self-conformance: 346 pass, 2 known differences, no unexpected difference;
- all 101 benchmark correctness and time budgets;
- runtime/analyzer units and fast CI.

## 5. Rope reconsideration trigger

Do not add ropes unless a new profile shows a material workload where:

- append histories cannot use tail ownership and repeatedly copy large
  prefixes;
- multiple large results profit from structural prefix sharing;
- consumers can retain or stream rope segments without immediately flattening;
- builder and immediate counters show that the remaining time or allocation is
  still dominated by string construction.

Any future rope proposal must include costs for depth control, flattening,
hash/equality, indexing, substring retention, regexp/JSON adapters, and moving
GC scanning. The current data does not justify those costs.
