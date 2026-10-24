# GC v3 plan: the collector's share of the typed tsc-ts compile (session 352)

Kaz (2026-10-24): go for the collector now. The generated code's profile is
flat after slices AR-AW (no symbol above 2.2%), and the collector with the
allocation path is the largest remaining bucket: by samples about 9% in
collection (`gc_mark_visit` 2.1%, `gc_scan_cell` 1.1%,
`gc_scan_stack_words` 1.1%, `gc_space_refill` 2.2%, `gc_mark_common_props`
0.3%) and 4% in allocation before slices AU and AW. scriptc, the target,
spends its 18.3 G instructions including its own collector.

## What the current design does on tsc-ts

The heap is the non-moving one of `docs/gc_v2_design.md` §6.8: cells in
size-class blocks of a cage, sticky mark bits as generations, promotion in
place, a remembered set of old cells with dirty card ranges
(`docs/remembered_slots_design.md`), and allocation-site pretenuring by
survival feedback (`docs/site_pretenuring_design.md`). tsc-ts keeps most of
what it allocates (the AST, the symbols, the types): the §6.7 measurement
of session 351 had every cell allocated old 5.7% faster than the nursery
(at 41.5 G instructions; the program is 22.7 G now, so the same work is a
larger share), and site pretenuring was built to approach that bound
without losing the TypeScript compiler its nursery.

Not a factor: `malloc`. Every cell and every owned buffer (array data, map
tables, property vectors, sidecars) comes from the cage's size classes; the
remaining malloc calls are cold (registration and interning at start,
`Symbol.for`, stdin, fetch, watch, `bind`/`apply`/`join`/`concat` beyond
their stack buffers, the generated spread calls beyond theirs, and the
amortized growth of the root stack and the remembered set). A breakpoint
count over one compile saw about 30 k frees; no allocator symbol is in the
profile's top 70, and the libc time (8%) is the run zeroing (`bzero`,
`memset`) and the payload reallocations (`memmove`).

## Knob measurements on the current build (three pairs each, under load)

The current binary with the collector's environment knobs changed, against
itself with the defaults (`TSAOT_GC_YOUNG_THRESHOLD` 65536 allocations,
`TSAOT_GC_NURSERY_BYTES` 4 MB, `TSAOT_GC_SITE_TENURE_PCT` 90,
`TSAOT_GC_SITE_MIN_ALLOCS` 100):

| change | instructions | cycles | wall | peak rss |
|---|---|---|---|---|
| nursery x4 (262144 / 16 MB) | +0.7% | +1.5% | +1.5% | 1.00 |
| nursery x16 (1 M / 64 MB) | -0.8% | 0.0% | 1.00 | 1.04 |
| tenure at 75% survival, windows of 32 | **-0.9%** | **-1.2%** | **-1.5%** | 1.01 |
| tenure at 60%, windows of 16 | -0.9% | +0.2% | 1.00 | 1.04 |
| site pretenuring off | +6.5% | +9.2% | +12.6% | 0.99 |

Site pretenuring already carries 6.5% of the instructions; a lower bar
gains another 1% and a larger nursery about as much in instructions but
nothing in cycles (the survivors are traced once either way; what a larger
nursery saves is the per-collection fixed work, what it costs is cache
locality). The plan below starts from these.

Quiet, eight pairs each, the current build against itself:

| bar / window | instructions | cycles | wall | peak rss |
|---|---|---|---|---|
| 75% / 32 | -0.89% | -1.04% | -0.8% | +0.6% |
| 80% / 32 | -0.84% | -1.30% | -0.8% | +0.4% |
| 75% / 64 | -0.78% | -1.07% | -0.8% | +0.2% |

## Slices

- **G1: the pretenuring defaults** become 80% over windows of 32 (the best
  cycles of the three, the least extra memory). The TypeScript compiler's
  class-instance sites survive below 10% (`docs/site_pretenuring_design.md`),
  so the bar leaves them young; its measurement is owed when that benchmark
  is rebuilt (no built TypeScript 6.0.3 checkout is on this machine).
- **G2: fresh statistics** (a `-DTSAOT_RT_STATS` build of the current
  runtime; the statistics binary on disk predated site pretenuring), one
  checker of tsc-ts:

  | | |
  |---|---|
  | collections | 99 minor, 2 full; pauses 106.6 ms in all (about 8.5% of the run) |
  | allocations | 7.50 M cells, 743 MB; 3.10 M of them (313 MB) old at 316 tenured sites |
  | young cells | 4.40 M; promoted 0.75 M (objects 221 k, arrays 170 k, strings 293 k, maps 47 k) |
  | minor phases | mark 57.0 ms, nursery sweep 36.8 ms, remembered-set reset 1.8 ms |
  | full phases | mark 8.6 ms, sweep 1.5 ms |
  | remembered set | 833 k enrollments, 1.375 M full-cell marks; 121 precise card scans (144 slot writes) |
  | cells scanned in minors | objects 1.40 M, strings 321 k, arrays 248 k |

  Site pretenuring has already removed most promotions (2.64 M objects
  promoted in the session-350 statistics, 221 k now). What remains of the
  minor mark is the remembered set: 833 k old cells enrolled per compile,
  8.4 k per collection, each rescanned whole (1.375 M full marks, 121 precise
  scans) because the class-field store of a sized instance goes through the
  generic barrier and a sized instance has no card byte (its header byte is
  its extent). The nursery sweep, 37 ms, is the promotion of 0.75 M
  survivors and the site digest. The full collections are cheap.
- **G3: the remembered set.** The full-cell rescans dominate the minor
  mark. A remembered old sized instance carries no card byte, so the design
  is a side structure: the remembered set becomes a table of (cell, field
  mask) entries, the typed field store's barrier (which knows the field's
  index) merges the field's bit, and the minor collection visits only the
  masked fields of a remembered sized instance (a 32-bit mask: one bit per
  field for the first 31, the last bit for every field beyond). The generic
  barrier (slot unknown) sets every bit, as today's full mark does.
  Measured and not kept (session 352): two forms of the field mask (a hash
  from the cell to its entry, or another entry per later store) both cut the
  collector's own work as the statistics say (minor collections 99 -> 94,
  pauses 106.6 -> 85.2 ms, the minor mark 57.0 -> 41.1 ms, 613 k precise
  rescans of one slot each) and neither paid on the clock against a control
  binary with the same generated code: +1.45% and +0.77% cycles over eight
  quiet pairs. The whole-cell rescans of just-written cells are cheaper than
  their count suggests and the barrier's bookkeeping at a million stores
  costs more (`docs/remembered_slots_design.md`, the last section). The
  remembered set is not where the collector's remaining time is.
- **G4: the minor collection's fixed costs.** The root scan, the frame walk,
  the young log and the sweep per collection; fewer collections (a nursery
  sized by the survival rate) only if G2 shows these dominate.
- **G5: the mark loop.** `gc_mark_visit` and `gc_scan_cell` after the above.

Each slice: outputs identical, the full gates, eight-pair measurements on
tsc-ts and the TypeScript compiler, and a note here.

## The remaining levers, measured (session 352)

After slices G1 and AR-AY the typed compile stands at 22.4 G instructions,
5.2 G cycles and 1.21 s against scriptc's 18.3 G and 1.05 s. The collector's
remaining time (young tracing, promotion) is the design's own, the generated
code's profile is flat, and the small slices pay 0.3-1% each. A
profile-guided build was measured as an experiment, not adopted (Kaz: PGO
goes last): the native build with `-fprofile-generate`, one compile of the
compiler project for the profile, then `-fprofile-use` (the units and the
runtime both; ThinLTO as always), against the current build over eight pairs,
outputs identical:

| | instructions | cycles | wall |
|---|---|---|---|
| current build | 22.52 G | 5.56 G | 1.30 s (under load) |
| profile-guided | 18.98 G | 4.66 G | 1.09 s |
| ratio | 0.843 | 0.838 | 0.838 |

That is within 4% of scriptc's instruction count on its own, with the profile
taken from the same input it is measured on (the usual way to tune a
compiler, and what the benchmark's other side does; a profile from another
project would test the robustness). Adopted the same day as the `default.pgo`
convention (docs/pgo_design.md): the benchmark build trains by default, the
driver applies a profile placed next to the entry file.
