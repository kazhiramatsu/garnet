# Absent property reads in line (proposal)

## Measurement

Kernel `links_objects` (3.2x Node, the worst pattern after the probe
tables): 32% of its samples are in `ts_get_pic_checked`, nearly all of them
reads of a property the receiver does not have (`l.count === undefined`,
`l.target`; tsc's `SymbolLinks` pattern). The compiler reads absent
properties about 5.4M times per compile (`absent_cache_hits`), so the
compile itself gains little; the kernel gains up to a third.

An absent read today: the inline probes miss, the out-of-line
`ts_get_pic_checked` tests null / undefined, counts, hashes (site, receiver
shape) into the global absent table (`g_prop_absent_cache`), compares the
entry's site, shape, key and epoch, then walks the current prototype chain
(at most three links) comparing each link's shape with the snapshot, and
tests the chain's end.

## Options

A. Per-key "defined on some prototype" bits, so that a receiver shape
   without the key proves absence. Every way an object becomes a prototype
   (some sixty link sites in the runtime and the emitted class setup, lazy
   function prototypes, `Object.create`, `setPrototypeOf`, proxies) would
   have to keep the invariant; one missed site is a silent wrong value.
   Rejected.

B. The same check in line, per site: an absent record in the site's cache
   (receiver shape, epoch, depth, up to three prototype shapes), filled by
   the out-of-line path where it fills the global table today. After the
   present-property probes miss, the inline path compares the receiver's
   shape and the epoch, walks `depth` links comparing shapes, tests the end
   and yields `undefined`. Same validation as the table, minus the call, the
   prologue and the hashing; one record per site (about 32 bytes, 49k
   sites: +1.5 MB of static data, which the measurements must weigh).

C. Prototype validity cells (V8's design): a prototype object owns a cell
   invalidated when its own keys or its chain change; an absent entry keeps
   the receiver shape and the direct prototype's cell, an O(1) test. The
   larger change; for later if B leaves the kernel far behind.

## Plan

B, gated by a knob, with a fixture that mutates prototypes between absent
reads at the same sites (a key added to the prototype, a relinked
prototype, an accessor defined on the chain, a proxy in the chain, a
dictionary prototype), run under GC stress. Measure `links_objects` and the
compiler A/B; keep it only if the compiler does not lose.

## Implementation (option B, as built)

**Record.** A read site's `ts_prop_ic` keeps its absent record in the bytes
a store site uses for its addition record (`add_*`,
`docs/site_add_transition_design.md`): an anonymous union, so the cache
stays 80 bytes and no static data is added (49.5k of the compiler's 57.6k
caches are read sites, which never used those bytes). The record holds the
key, two receiver shape words, the chain's depth and up to three prototype
shape words. `rec_epoch`, outside the union, is the epoch of the addition
cache for an addition and the same epoch with `TS_ABSENT_EPOCH_TAG` (bit
31) set for an absent read, so neither check accepts the other's record,
whatever a cache was used for. The epoch now saturates below that bit
instead of wrapping: the sites' records cannot all be cleared, so once it
is exhausted nothing is filled and nothing matches any more (the old wrap
cleared the global addition table only, and the per-site addition records
and the absent table could match stale entries after 2^32 moves).

**Check.** `prop_absent_site_hit` (`ts_rt.c`) validates the record as the
table validates its entries: the key and the epoch first (most records are
empty or stale), then a plain object (`TS_KIND_OBJECT`; the array's
virtual `length` is why) whose shape word is one of the two, each current
prototype link a plain object with the recorded shape word, and the chain
ending after the last one. It runs at the top of `ts_get_pic_checked` as a
leaf (no frame, no saved registers: seven instructions when the record does
not apply), in front of the slow read, now `ts_get_pic_checked_slow`,
reached by a tail jump. Every read helper's miss path already ends in that
call, the lazily linked ones through `ts_get_linked`, so no read site gains
code: `__text` +716 bytes, all in the runtime.

**Fill.** The slow read copies a verified entry into the site's record
where it answers from the global table and where it fills the table (plain
objects only: the table also serves named reads on arrays). A record stays
for its epoch: a second receiver shape with the same key and chain joins it
once, and any other absent read of the site is left to the table. The two
shapes are independent facts (a shape fixes the receiver's own keys, the
chain's shape words the inherited ones), so a record is sound for either
shape under its chain. `TSAOT_ABSENT_SITE=0` fills no record;
`TSAOT_NEGATIVE_PIC=0` disables the table and the records.

**Variants measured and dropped.**

- The check in line after every read helper's probe: the kernel 1% faster
  than the leaf, about 45 instructions of code at each of 49.5k read sites
  (the `x63` per-site entries cost 6.6 MB of `__TEXT` for the same reason).
- In line only in the reads of lazily linked frames, before they link
  (3.2k sites): `__text` +842 KB (2.2%); compiler cycles 1.0093 against
  `ih`, eight pairs, none faster.
- Records replaced on every table hit (the latest shape wins): 2.6M record
  rewrites per compile at sites with more than two absent shapes; compiler
  cycles 1.0034 (leaf only). The sticky records answer 3.34M of the 5.43M
  absent reads per compile instead of 2.80M.

## Measurements

Kernel `links_objects`: 39.0M absent reads, all answered by the records
(slow reads 39.0M -> 18); against the previous runtime, eight alternating
runs: cycles 0.921, instructions 0.898, wall 466 -> 427 ms.

Compiler (one compile of the compiler project with emit, runtime
statistics): 5.43M absent reads, 3.34M answered by the records, 2.06M by
the table, 24k walked; slow reads 7.0M -> 3.67M. A/B against `ih` (the same
compiler object relinked; the header's in-line code is unchanged), sixteen
ABBA pairs: cycles 0.9996 (lower in 9 of 16), instructions 0.9996 (16 of
16), wall 1.0000. An A/A of `ih` read cycles 0.9990, wall 0.9975: neutral,
as expected from 5.4M absent reads in a 17G-cycle compile.

What remains on the kernel is the chain walk itself: a check without it
(unsound, measured only) gives cycles 0.828 against 0.921. Option C (a
validity cell for the chain, an O(1) test) would take about another 10% of
the kernel, and about nothing on the compiler.

## Verification

Fixture `objects/absent_site_records` (in the GC stress filter): three
receiver shapes over one chain with the prototype gaining the key, an
accessor and a data property again, then losing it; the lazily linked
readers with a key on the prototype, an own key and a relinked receiver;
method calls whose field read is absent, an own field shadowing the method
and the prototypes' methods replaced; one dynamic-key site with alternating
keys; a plain object and an array with the same own keys and chain at one
dynamic-key site (`length`); a proxy and a function inserted into the
chain; frozen and sealed receivers, a prototype turned into a dictionary;
collections between the reads; static-slot reads of receivers of another
layout; `Object.prototype` gaining and losing the key, last (a deletion
leaves a prototype in dictionary mode, which nothing records afterwards, so
every case has prototypes of its own). The records answer 16k reads of the
run. Built against runtimes with one test removed, the fixture fails without
the chain walk (seven cases), without the key test (the dynamic site) and
without the receiver's kind test (the array); removing the epoch test, the
end-of-chain test or the links' kind test alone is not observable, as a
relink always moves the epoch (they are kept as defence in depth).

## Arrays and primitives (Session 355)

The table's chain rule admitted plain-object links only, and `Array.prototype` is an
array-kind object, so a named absent read on an array (`arr.__v_raw` in vue's
`createReactiveObject`) was never recorded and walked the chain on every access; a number, a
string or a boolean receiver (vue's `isRef(v)` reads `v.__v_isRef` on every value a trap
returns) went to the generic read, which walked the wrapper prototype's chain each time. A
chain link may be an array-kind prototype now (`absent_chain_link_ok`: a plain object or an
array with a shape word; the array's own keys the shape fixes are its named ones, `length`
and the indices being outside the table's keys anyway), so an array receiver records and
hits as a plain one. A primitive receiver reads through its wrapper prototype's entry in the
slow read: `Number.prototype`, `Boolean.prototype` or `String.prototype` (after the string's
own `length` and indices) stands in as the receiver whose shape keys the entry, the chain
above it recorded as usual, and a miss walks the chain and fills the entry without touching
the site's own record (`prop_absent_fill_impl(.., 0)`), which stays with the site's objects.
A property added to or deleted from any of those prototypes afterwards changes its shape
word and misses the entry, as for a plain receiver. vue: 36.996 -> 36.023 G instructions
(-2.6%), 5.571 -> 5.299 G cycles, 1,277 -> 1,231 ms alternating (Node 756: 1.63x).
