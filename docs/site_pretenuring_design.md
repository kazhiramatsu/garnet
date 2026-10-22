# Allocation-site pretenuring by survival feedback

Session 352. Runtime (`ts_rt.c`), emitter (`emit_c.rs`). Follows
`docs/gc_v2_design.md` §6.7-§6.8 (the non-moving heap: a young cell that
survives its first collection is promoted in place) and complements the
static strategies of `docs/pretenuring_design.md` (escape-proven module
roots and loop accumulators) and `docs/pretenured_construction_design.md`
(guarded ES5 constructions, with a global valve).

## Why

In the non-moving heap every young survivor is promoted at its first
collection, so a cell that was always going to survive costs the collector
a mark (its edges traced from the roots or the remembered set), a promotion
(its mark bit and header) and, until then, the write barriers of a young
owner. Allocating it old skips all of that. Allocating every class
instance old (a measurement build of Session 351, outputs identical) made
tsc-ts 3.0% faster, but its peak memory 20% higher and the TypeScript
compiler 0.9% slower: the compiler's class instances die young, and an old
cell that dies waits for a full collection.

Measured per allocation site (the call's return address as the site, a
relinked measurement runtime, one run of each program; "survived" = promoted
at the collection that ended the cycle it was allocated in):

| program | kind | allocations | survived | sites |
|---|---|---|---|---|
| tsc-ts | class instances | 3.41 M | 77.2% | 707 |
| tsc-ts | arrays | 2.41 M | 25.6% | 735 |
| the TypeScript compiler | class instances | 1.26 M | 0.2% | 119 |
| the TypeScript compiler | arrays | 4.48 M | 12.1% | 474 |
| the TypeScript compiler | object literals (layouts) | 1.45 M | 16.7% | 177 |

Survival by site is bimodal. tsc-ts's class instances, sites with at least
64 allocations, by the site's survival rate:

| site survival | sites | share of allocations | share of survivors |
|---|---|---|---|
| < 10% | 90 | 18.3% | 0.6% |
| 10-75% | 75 | 2.7% | 1.8% |
| 75-85% | 6 | 8.4% | 9.0% |
| 85-95% | 38 | 17.0% | 20.5% |
| >= 95% | 199 | 53.3% | 68.1% |

At a threshold of 85%, 237 sites hold 70% of the allocations and 88.5% of
the survivors, and 3.0% of what they allocate dies young (the garbage a
tenured site leaves in the old generation until a full collection). Arrays
at the same threshold: 62 sites, 18% of the allocations, 69% of the
survivors. The TypeScript compiler's class-instance sites all stay below
10% (relation checks, flow analysis): per-site decisions leave them young.

## Design

**Site ids.** The emitter gives a heap class allocation (`AllocObject` with
a class, any strategy but `Stack` and the static `PretenuredHeap`) the id
`IR site + 1` and calls `ts_new_sized_site(sizeof(S), id, proto)` instead
of `ts_new_sized(sizeof(S))` followed by the prototype store. Ids above
`TS_ALLOC_SITE_MAX` (65535; tsc-ts has 12.9 K sites, the TypeScript
compiler 14.5 K) keep the plain call. The runtime keeps a static table of
65536 twelve-byte records (allocations, a count, a state, a listed flag);
the pages of unused ids are never touched.

**Allocation.** `ts_new_sized_site` reads the site's state: tenured sites
allocate old, every other site young. The site id goes into the header's
spare half-word (`ts_gc_header.spare`, unused since D2 removed pinning),
the prototype is stored, and the site's allocation count is incremented.
An old cell needs the barrier for its prototype: class prototypes are
allocated young (`CLASS_PROTO[c] = ts_new_proto()`), and a class evaluated
in a function makes a new one each time. Every other store into a class
instance already carries the barrier (`ts_write_barrier` after each
struct-field store), because any instance may have been promoted.

**Feedback.** Promotion (`gc_promote_survivors`, in both collectors) counts
a survivor for its site and lists the site for the digest. A full
collection's old sweep counts, for a tenured site, each of its old cells
it finds dead. After each collection, `gc_sites_digest` visits the listed
sites only:

- a young site whose window holds at least `g_site_min_allocs` (100)
  allocations is decided: survivors at `g_site_tenure_pct` (90; 85 in
  slice 1, see slice 2) percent or more of the window tenure the site;
  either way the window restarts. A
  site with no survivor is never listed, so its window stays open and its
  later survivors weigh against everything it allocated;
- a tenured site, at a full collection, returns to young for good (`NEVER`)
  when at least 32 of its old cells died and they are more than half of
  the cells it allocated since its last count (the per-site form of the
  constructions' global valve: a phase change, such as a site whose cells
  lived while a file was parsed and die afterwards, costs one full
  collection's worth of old garbage);
- a decision is never made inside an allocation: the digest runs at the
  end of a collection, when every young cell of the cycle is promoted or
  dead, so a window's counts describe the same cells.

**Knobs.** Runtime: `TSAOT_GC_SITE_PRETENURE=0` keeps every site young (the
A/B baseline in one binary); `TSAOT_GC_SITE_TENURE_PCT` (0-100) and
`TSAOT_GC_SITE_MIN_ALLOCS` tune the decision (`=0` and `=1` tenure every
site at its first listed collection: a stress mode for the barriers);
`TSAOT_GC_SITE_LOG=1` prints each decision with the IR site id
(`sites.json` maps it to the source). The statistics build adds
`[rt_stats] alloc_sites: tenured=N reverted=M`. Emitter:
`TSAOT_SITE_PRETENURE=0` emits the plain allocation (the parity oracle's
form, `scripts/emitc_diff.sh`).

## Invariants

- Only allocations the generated code makes through `ts_new_sized_site` can
  be old at birth; the runtime's own allocations are unchanged.
- An old cell's initializing stores carry the barrier: the prototype in the
  runtime, the fields in the generated stores. The emitter writes no
  reference into a heap instance without one (the remaining header stores
  are integers and `undefined`).
- The prototype is evaluated before the allocation (an argument) instead of
  after it; functions with a heap allocation are never lazily framed
  (`body_is_gc_free`), so a prototype held in a local is in the root frame
  across the allocation, as it was when it was read after it.
- Statistics only: a site id in a header never changes what the program
  computes.

## Slice 1 as built

As designed. tsc-ts (emitting the TypeScript 6.0.3 compiler project): 235
sites tenure (the measurement predicted 237 at 85%), 5 small ones return to
young. Eight ABBA pairs each, outputs identical:

| | wall | instructions | cycles | peak memory |
|---|---|---|---|---|
| tsc-ts, against the build before | 0.967 (1.82 -> 1.765 s) | 0.965 | 0.970 | 1.004 |
| tsc-ts, the same binary, feedback off against on | 0.9645 | 0.9615 | 0.9645 | 1.004 |
| tsc-ts, threshold 75% against 85% | 1.000 | 1.000 | 1.002 | 1.007 |
| the TypeScript compiler, against the build before | 0.999 (3.45 s) | 1.001 | 0.998 | 0.997 |

Every class instance old had given tsc-ts 0.970 at +20% peak memory and the
compiler 1.009; per site, tsc-ts gains as much with no memory, and the
compiler, whose class-instance sites all stay young, is unchanged. With the
feedback off the binary retires 0.4% more instructions than the build
before (the site's count, the header store, the promotion's count): the
plumbing's cost, inside the total.

## Slice 2 as built: arrays and object literals

`AllocArray` calls `ts_new_array_site(0, id)` and an object literal
`ts_new_object_site(id)`, `ts_new_object_n_site(n, id)` or
`ts_new_object_layout_site(&layout, id)`, under the same rule as classes
(not for `Stack` and `PretenuredHeap` sites; a literal's or an array's
strategy is an annotation, so an unproved one stays as it was). Their
prototypes are the runtime's (`Object.prototype`, `Array.prototype`), which
the pretenured constructors already store with the barrier. An old array's
element storage is allocated old (`gc_owned_alloc` follows the owner), so
an array that grows after its site tenured keeps a valid payload.

At 85% the arrays made tsc-ts no faster (wall 1.005, instructions 1.006
against slice 1): the statistics build showed a fourth full collection.
Array sites whose survival sits between 85% and 90% leave garbage in the
old generation early in the run, the first full collection (at 16 MB)
reclaims 27% of the heap instead of 13%, and the pacing rule
(`docs/full_gc_pacing_design.md`: the next threshold at twice the live
bytes when a collection reclaims a quarter or more, four times otherwise)
schedules the later ones sooner; the last one, at 284 MB, paused 72 ms. At
90% the run keeps three full collections, reverts 11 sites instead of 18,
and pretenures slightly more cells (3.14 M against 3.12 M). The default
became 90%. Eight ABBA pairs each, outputs identical:

| | wall | instructions | cycles | peak memory |
|---|---|---|---|---|
| tsc-ts, slice 2 at 90% against 85% (one binary) | 0.981 | 0.989 | 0.979 | 1.006 |
| tsc-ts, slice 2 at 90% against slice 1 | 0.992 | 0.996 | 0.992 | 1.013 |
| the TypeScript compiler, slice 2 at 90% against slice 1 | 0.987 | 0.994 | 0.988 | 1.031 |

tsc-ts tenures 307 sites (11 return). The compiler's long-lived literals
and arrays (the measurement's emit nodes among them) pay for the extra
memory with 1.3% of its time.

## Slices

1. Class instances (done, above).
2. Arrays and object literals (done, below).
3. If measurement asks for it: the runtime's own sites with a site passed
   in (`ts_construct`'s generic instances: 222 K in the compiler, all
   surviving; `Array.prototype.slice`).

## Verification

Per slice: unit (with a runtime test of the decisions), parity, bundler,
selfconf, defaults, GC stress (also with every site tenured at once),
conformance (plain, strict, and at every allocation under protect mode,
also with every site tenured), tsc-ts and the TypeScript compiler rebuilt
and run under protect mode, protect with a minor every 64 allocations, and
zap with one every 16 (outputs identical), and A/B on both programs (the
new build against the previous one, and one binary with
`TSAOT_GC_SITE_PRETENURE=0` against itself), with peak memory.
