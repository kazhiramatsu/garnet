# Slot-first inline-cache probe

## Data

A statistics build of the compiler (`native_s350s_stats`, Session 350)
counted which path each of the 592.6M property reads per compile took in
the inline probe `ts_prop_ic_probe_fixed_inline`:

| path | reads | share of hits |
|---|---:|---:|
| entry 0 shape compare (monomorphic) | 214.3M | 36.7% |
| entries 1–3 shape compare | 13.5M | 2.3% |
| slot/key validation (same slot, other shape) | 360.4M | 61.7% |
| out of line | 13.4M | — |

The compiler's objects are shape-polymorphic (every `Node` acquires
different optional properties after construction) while the key sits at
the same slot in all of them, so the dominant path was reached only after
all four shape compares had failed and a second loop over the entries had
started.

## Change

The probe now tests entry 0 twice before anything else: its shape (the
monomorphic hit) and then its slot validated against the receiver shape's
key vector (`g_ts_shape_keys[shape][slot] == key`, the same check the
out-of-line probe performs). Entries 1–3 keep their shape compares and
their slot validations after that. Nothing about filling or invalidation
changes: the validation reads the shape's own key vector, so a stale entry
can only miss, never hit a wrong slot.

Cost per read on the dominant path: one failed shape compare plus the
validation (length, key-vector row, key) instead of four failed compares, a
loop and the validation. Monomorphic reads are unchanged.
