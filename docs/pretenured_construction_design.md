# Pretenured construction: guarded constructions allocate old

Implemented in Session 350 (build `x39`, relinked from `x37` with the
full-collection pacing of `x38`); runtime only (`ts_construct_begin_n`
and the full-collection retarget in `runtime/ts_rt.c`). Knob
`TSAOT_PRETENURE_CTORS=0` restores the young allocation.

## Finding

After the full-collection pacing (`docs/full_gc_pacing_design.md`) the
collector's remaining cost is the minor collections: 401 per compile,
about 330 ms of pauses, copying 122 MB of survivors and promoting 125 MB
(`aging: copied_bytes`, `promoted_bytes`), with 359 MB promoted directly
when a nursery cycle ended early (`forced_bytes`). The survivors are the
compiler's nodes, symbols, types, signatures and links objects: built by
ES5-style constructor functions through the guarded constructions of
`x32`, and alive until the end of the compile. Every one of them is
copied once or twice through the nursery and aged into the old
generation, which is where it was always going.

## Change

`ts_construct_begin_n` allocates the instance of a guarded construction
in the old generation (`ts_new_object_n_pretenured`) and runs the
write barrier for the prototype link, instead of a nursery allocation.
The generic construction (`ts_construct`, `NewDynamic`) and every other
allocation are unchanged.

The objects a program builds with constructor functions are usually its
long-lived data, but not always; a program that builds short-lived
objects with a constructor in a loop would fill the old generation with
garbage that only a full collection reclaims. The safety valve: after a
full collection, when the old generation turns out to have been mostly
garbage (more than half of the heap bytes reclaimed), pretenuring is
turned off for the rest of the run. The first full collection runs at a
16 MB heap, so the waste is bounded by that one collection. The
compiler's full collections reclaim 3 MB of 17, 55 and 209 MB, so the
valve never trips there.

## Verification

GC stress gate (all phases, with the pretenured instances and their
barriers), conformance (all tiers), unit tests; the compiler's outputs
validated against Node. The compiler A/B (`x39` against `x38`) and the
statistics are in the TODO entry.

## Results

1.91M pretenured allocations per compile; minor collections 401 -> 325,
pauses 384 -> 251 ms, copied survivors 122 -> 65 MB, promoted 125 -> 67
MB, promoted early 359 -> 114 MB; the three full collections reclaim
3 MB each (the valve stays off). Compiler A/B, `x39` against `x38`, two
rounds of three alternating runs (outputs validated, diagnostics zero):
4.667 vs 4.761 s and 4.686 vs 4.751 s median wall, all six pairs between
-0.8% and -2.0%; peak RSS 821 -> 884 MB. Node 3.28-3.29 s, so 1.42x
Node.
