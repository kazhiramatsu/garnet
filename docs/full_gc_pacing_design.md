# Full-collection pacing by reclaimed fraction

Implemented in Session 350 (build `x38`, relinked from `x37`); runtime
only (`runtime/ts_rt.c`, the retarget after a full collection). The
knob `TSAOT_GC_FULL_THRESHOLD_BYTES` still pins the threshold.

## Finding

The profile of `x37` puts the collector at 15% of the samples
(`gc_mark_common_props` 71, `gc_mark_visit` 48, `gc_scan_cell` 38,
`gc_alloc` 38, `gc_free_cell_payload` 24, `ts_gc_collect` 17). The
statistics count 399 minor and 6 full collections per compile, 498 ms of
pauses, the longest 100 ms. The full threshold starts at 16 MB and
doubles after each full collection (`next = live * 2`), so the six run at
heaps of about 16, 32, 64, 128, 256 and 512 MB: the early ones mark a few
MB, the last two mark 250-480 MB of live data, and the compiler's old
generation holds little garbage (125 MB promoted per compile against
486 MB live at the end), so those collections reclaim little.

A quick knob trial on the `x37` binary (`--noEmit`, three alternating
runs each): the default 3.83/3.91/3.94 s; a pinned threshold of 2 GB
(no full collection) 3.75/3.78/3.81 s; 4 GB 3.73/3.76/3.78 s; 600 MB
3.72 s; peak RSS 744 MB against 767 MB without any full collection. The
nursery knobs read worse (16 MB +0.7%, 64 MB +2.7%), as in the earlier
sessions.

## Change

After a full collection the next threshold is `live * 2` as before when
the collection reclaimed at least a quarter of the heap, and `live * 4`
when it reclaimed less: a heap that is mostly live keeps growing, and
collecting it again soon only marks it again. The headroom floor
(`live + 4 MB`) and the pinned-threshold knob are unchanged. The
statistics build records the first 32 full collections (heap bytes
before and after, the next threshold, the pause) and prints them at
exit (`full_gc #n: ...`).

## Verification

GC stress gate (all phases), conformance (all tiers), unit tests; the
compiler's outputs validated against Node. The compiler A/B (`x38`
against `x37`) and the full-collection trace are in the TODO entry.

## Results

Full collections per compile 6 -> 3: the trace reads 16.8 -> 15.4 MB
(2.7 ms), 61.7 -> 61.2 MB (9.0 ms), 244.8 -> 243.9 MB (40.7 ms), each
reclaiming about nothing, so each quadrupled the threshold; pauses 498
-> 384 ms, the longest 100 -> 41 ms; minor collections unchanged (401).
Compiler A/B, `x38` against `x37`, two rounds of three alternating runs
(outputs validated, diagnostics zero): 4.734 vs 4.868 s and 4.752 vs
4.865 s median wall, all six pairs between -2.0% and -3.1%; peak RSS 811
-> 821 MB. Node 3.27-3.29 s, so 1.44x Node.
