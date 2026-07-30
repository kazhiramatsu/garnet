# Escape-guided pretenuring

Garnet normally allocates objects in the moving nursery. That is the right
default for short-lived values, but it needlessly copies allocations that AOT
analysis can already prove will be retained. Escape-guided pretenuring sends a
deliberately narrow set of those sites directly to the old generation.

## Classification

The interprocedural escape pass records `pretenure_sites` alongside its normal
`NoEscape` / `ArgEscape` / `GlobalEscape` result. A site qualifies only when one
of these structural cases is proven:

1. It is a `Multiplicity::Once`, `GlobalEscape` allocation in
   `__module_init`. Module roots and top-level closures normally live for the
   process lifetime.
2. A loop allocates a fresh value, links it to the previous loop-carried value,
   and replaces that carrier. This is an unbounded retained chain such as
   `head = new Node(head)`.
3. A loop appends a fresh value to a container created outside the loop. Every
   iteration remains reachable through the outer container.

The classifier intentionally excludes indexed replacement (including bounded
ring buffers), a loop-carried overwrite without an edge to the previous value,
and ordinary returned or exported allocations whose call frequency is unknown.
Those sites retain the normal nursery policy.

The result is computed once during escape analysis, before code generation.
Code generation maps a classified site to `PretenuredHeap`; setting
`TSAOT_PRETENURE=0` restores the legacy allocation strategy for A/B testing and
diagnosis.

## Runtime contract

The pretenured object, array, sized-class, closure, and function-prototype
constructors allocate directly into the old-generation list. They still use GC
handles and participate in full marking and sweeping.

An old cell may be initialized with a young prototype, property, element, or
closure capture. Every such store uses the normal write barrier. Runtime tests
force minor and full collections across both object properties and captured
closure environments to pin this invariant.

GC aging has a second, separate old-to-young edge source: a young parent may
promote one collection before a younger child even though their original store
was young-to-young. The minor collector's promotion barrier enrolls every newly
promoted survivor in the remembered set when
`TSAOT_GC_AGE_THRESHOLD > 1`. `tests/gc_aging_promotion_gate.sh` now reproduces
that exact three-minor sequence in normal and ASan stress runs.

## Measured effect

On the retained 300,000-node `gc_deep_chain` benchmark with aging threshold 2,
pretenuring reduced minor collections from 15 to 3 and best-of-seven wall time
from 35 ms to 22 ms on the development machine (about 37% faster). This removes
the recopying that caused the earlier threshold-2 regression.

The bounded `gc_survivors` ring-buffer workload remains nursery-allocated.
Pretenuring itself is therefore neutral on that workload; the separate
[adaptive aging policy](adaptive_aging_design.md) reduces the fixed
threshold-2 minor count from 32 to 17 and wall time from 104 ms to about 92 ms.
Ring-buffer exclusion is enforced as a negative classification test, so the
optimization does not simply tenure all loop allocations.
