# Runtime header and inline policy

Garnet compiles generated C separately from a cached `ts_rt.o`. Without LTO,
only definitions in `ts_rt.h` are visible while the generated translation unit
is optimized. The header therefore needs selected fast paths, but it must not
become an amalgamation of the complete runtime.

This document defines the boundary.

## Goals

1. Keep representation-level operations visible to generated C when doing so
   enables constant folding or removes a call from a common mutator path.
2. Keep substantial loops, fallback behavior, allocation, and uncommon object
   traversal in `ts_rt.c`.
3. Reserve forced inline expansion for cases where the call-site state is part
   of the optimization contract.
4. Avoid requiring LTO for normal builds.

Putting a definition in a header does not itself guarantee expansion:
ordinary `static inline` remains subject to the C compiler's cost model.
`TS_RT_ALWAYS_INLINE`, on the other hand, uses `always_inline` under Clang and
GCC and therefore needs a much stricter allowlist.

## Three tiers

### Tier 1: forced call-site fast paths

`TS_RT_ALWAYS_INLINE` is limited to the property PIC wrappers:

- the emitted site owns the cache;
- shape and slot guards need to execute directly at that site;
- only a data-property hit completes inline;
- misses, accessors, exotics, errors, and cache updates call canonical
  out-of-line helpers;
- the four-entry probe explicitly disables loop unrolling.

Generated numeric helpers use the separate `TS_AOT_INLINE` macro. The emitter
only applies it to non-async, non-generator functions with at most eight
straight-line IR instructions from the small arithmetic/field/return
allowlist. Functions with loops or control flow are excluded.

### Tier 2: ordinary bounded header helpers

Ordinary `static inline` is appropriate for:

- NaN-box tag tests and boxing/unboxing;
- short-string extraction;
- flat-string view construction;
- code-unit loads and stores;
- frame push/pop;
- the generational write-barrier guard;
- the one-byte, one-code-unit `memchr` search path;
- small type checks such as array and nullish tests.

These helpers contain no allocation. They either have bounded work or represent
a very small leaf operation. The compiler remains free to emit a local
out-of-line copy if repeated call sites make expansion too expensive.

### Tier 3: precompiled runtime workers

The following implementations live in `ts_rt.c`:

- recursive parent-view traversal;
- general forward and backward string scanning;
- allocation-free replace and split/join metric loops;
- JSON quoted-string length scanning.

The header retains short guards and declarations. In particular,
`ts_str_find_forward_view` handles empty/impossible searches and the common
one-byte single-unit `memchr` case before calling
`ts_str_find_forward_view_slow`. Backward search keeps only normalization and
bounds checks in the header. Flat and immediate strings are handled by
`ts_str_view_typed`; only a heap view enters `ts_str_view_typed_slow`.

This split keeps the frequently specialized cases visible without replicating
the complete scanner and metric loops in generated C.

## Measured tradeoff

The boundary was measured on arm64 macOS with `cc -O2`, using
`string_unicode_search_kernel` as the representative generated translation
unit.

| measurement | previous header implementation | split implementation |
|---|---:|---:|
| generated-C compile, one run | 0.10 s | 0.08 s |
| generated object | 74,248 B | 72,640 B |
| cold runtime compile, one run | 1.54 s | 1.74 s |
| runtime object | 545,496 B | 585,600 B |
| representative libc-linked executable | 451,064 B | 471,192 B |

The runtime object is cached by the normal driver, so repeated application
builds benefit from the smaller generated translation unit. The executable
difference includes a 16 KiB Mach-O text-segment step. If runtime size becomes
material, the next step is separate worker objects or function-section garbage
collection, rather than returning the general loops to the public header.

Runtime performance did not regress in the targeted gates. Dynamic replace and
split/join metrics remained at 4 ms and 3-4 ms, JSON at 4-5 ms, and the
UTF-16 search kernel remained within its existing range and budget (83 ms after
the split versus 89 ms in the recorded pre-change run). The complete string and
JSON benchmark selection passed all 31 budgets.

## Regression guard

`tests/runtime_inline_policy_gate.sh`, run by the runtime test suite, verifies:

- substantial worker names have declarations in the header and definitions in
  `ts_rt.c`;
- those workers are not declared `static inline` or
  `TS_RT_ALWAYS_INLINE`;
- the bounded string/view wrappers remain present;
- no runtime helper outside the PIC allowlist gains
  `TS_RT_ALWAYS_INLINE`.

Semantic coverage remains in the runtime, conformance, bundler, string/JSON
benchmark, and GC-stress suites.
