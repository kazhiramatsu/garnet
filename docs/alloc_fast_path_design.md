# The young allocation's fast path (Session 360)

## Problem

A small allocation that dies young costs V8 about ten instructions: a bump
of the new space's top below its limit and the header's map word. The same
allocation in garnet cost 110 to 130 instructions. For a class instance,
`new P(i, i + 1)`, the cost broke down as follows:

- two calls: the generated code calls `ts_new_sized_site`, which calls
  `ts_new_sized_impl`;
- the collection triggers (`gc_before_alloc`): five loads and five compares
  at every allocation (young cells, young bytes, payload bytes, heap bytes,
  the configuration flag);
- the size class looked up through a table;
- the size class's bump, then the three counters the triggers read: young
  cells, young bytes and heap bytes;
- the allocation bit of conservative roots: one read-modify-write of the
  allocation bitmap per cell, since every program built in the default mode
  scans its stack conservatively;
- the header's stores.

The allocation kernels below spent 186 to 411 instructions per iteration
(an allocation, a store that makes it escape, a read back). V8 runs them
in 10 to 20 cycles.

## Design

The fast path is the bump of the size class's pointer below the class's
**limit**. Everything else moves to the class's slow path, which runs when
the run is exhausted or when the class's grant of the collection budget is
spent.

- **The grant.** A class takes a grant of the collection budget: the bytes
  it may hand out before it counts them and runs the triggers again, at
  most `GC_YOUNG_GRANT_MAX` (64 KB) and at most what the budget has left.
  The budget folds in the three young triggers: the cells left before the
  young threshold (times the class's size), the young bytes left before
  the young cap, and the heap bytes left before the full collection's
  threshold. A grant spans runs: a compile's young runs average a few
  cells (the gaps its survivors leave), and counting and running the
  triggers per run cost what the bumps saved.
- **The limit** is the end of the fast allocation: the end of the run, or
  where the grant runs out, whichever comes first. The young families
  (`g_cclass`, the zeroed runs, and `g_cclass_sized`, the unzeroed runs of
  class instances) carry it; the old and payload families do not.
- **Closing and counting.** `acc` is the position in the run up to which
  the class's cells were closed. The slow path closes `[acc, ptr)`: the
  cells' allocation bits are set (below), their bytes join the class's
  pending bytes, and the grant is reduced by them. When the grant is spent,
  the pending bytes are counted into the counters the triggers read (young
  cells, by a multiply with the class's reciprocal; young bytes; heap
  bytes), `gc_before_alloc` runs (it may collect), and a new grant is
  taken. A collection counts every class first, and at its end every class
  has no grant and nothing pending (`gc_young_restart`).
- **The class by arithmetic.** A size of 256 bytes or less is its class by
  arithmetic (the classes step by 16 bytes up to 256 bytes); a larger one
  goes through the table, as before. The slow path has no division.
- **Budgets crossed elsewhere.** The payload heap and the ArrayBuffer
  allocation count bytes the young classes do not see. When a payload
  crosses the payload budget, or an ArrayBuffer's bytes push the heap past
  the full threshold, every young class's limit is set to its pointer and
  its grant to nothing (`gc_young_limits_force`). The next young
  allocation then runs the triggers, as the per-allocation test did.
- **The debug modes** put every allocation through the slow path: a grant
  of one cell under the zap and protect modes, ASan, the statistics build,
  the stack check and the young-log probe of the tests
  (`g_alloc_every_slow`). The young log then sees every cell, and a
  collection comes at the same allocation as before.
- **Large cells** (over `GC_PAYLOAD_SMALL_MAX`) keep the per-cell path
  (`gc_alloc_large_young`): the triggers, the counters and the young log at
  each one.

### Conservative roots: the bits of a closed range

The conservative stack scan validates a candidate word through the
allocation bitmap (docs/conservative_roots_design.md). The allocator set a
young cell's bit when it handed the cell out, a read-modify-write per
allocation that kept the fast path from being a bare bump. A closed range
`[acc, ptr)` now gets the bits of all its granules at once, a word move per
64 granules (`gc_alloc_bits_fill`). Every collection closes every class
before it scans, so each young cell has its bit when a scan can see it. The
scan tests a cell's start, which the block's class gives, and the settle
after the collection keeps the survivors' starts alone (alloc &= marks), so
the bits of the other granules do no harm.

Two other designs were built and measured first:

- Setting a bit per cell in a batch at the slow path cost 29% on the
  allocation kernel: a read-modify-write chain over the bitmap words.
- Young cells without bits, validated by a record of every run the young
  classes handed out since the last collection, were fast on the kernels
  but not on a compile: its young runs are a few cells each, 1.08 M
  records over a compile and 17,728 in one cycle, and the scan walked 51.6
  M records for 14,591 candidates (tsc-ts +1.7% instructions).

## What changed in the pacing

- The young bytes count the cells' footprint (the size class), where they
  counted the requested bytes, so the young cap bounds the young
  generation's real size. A program whose cells round up reaches the cap
  sooner: an array with its four inline elements requests 104 bytes and
  is handed 112, and the arrays kernel below ran 269 young collections
  where it ran 250.
- The other classes' outstanding grants are not counted when a class takes
  its grant, so a collection can come late by up to a grant per class that
  is allocating (64 KB each). tsc-ts ran 92 young collections where it ran
  93; the instance and object kernels 154 before and after.

## Runs

A compile's young runs are small: tsc-ts took 1.08 M of them, 58% a single
cell, 19% two, 8.5% three (its survivors, promoted in place, leave gaps of a
cell or two in the blocks they nearly fill). Skipping a gap of fewer than
four cells cut the refills to 263 K but took 334 more blocks (RSS 646 to 668
MB) and gained no cycles; it was not kept. The grant spanning runs is what
made the small runs cheap.

## Measurements

The allocation kernels: per iteration, an allocation that escapes through
a module variable and a read back, 10 M iterations. Instructions and
cycles per iteration, before and after phase 1 (the run-record build,
which differs from the final one only on the slow path):

| kernel | instructions before | after | cycles before | after |
|---|---|---|---|---|
| `[i, i + 1]` (arrOnly) | 186 | 119 | 21.7 | 17.9 |
| `new P(i, i + 1)` (onlyAlloc) | 225 | 163 | 25.4 | 20.8 |
| `{ a: i, b: i + 1 }` through `globalThis` (objOnly) | 411 | 349 | 51.8 | 44.6 |

tsc-ts (one checker, five rounds, against the commit before): -0.5%
instructions, cycles within +0.1 to +0.4% over two runs (the noise floor of
an A against itself is 0.1%), RSS 646 to 641 MB.

## In the generated code (phase 2)

The generated code reached the allocation through two calls
(`ts_new_sized_site`, then `ts_new_sized_impl`); after them the C compiler
could not see that the value was an object of the class it had just
allocated, so the constructor's field stores and the reads after them kept
their receiver tests. The header now has the young fast path in line for
the allocations a site names:

- `ts_new_sized_site_in`: a class instance. It bumps the unzeroed run of the
  instance's size class below its limit and writes the header word: the
  kind, the young generation, the sidecar and sized flags, the site and the
  extent, all constants of the site. It then writes the prefix (prototype,
  class word, shape, sidecar pointer) and counts the site's allocation.
- `ts_new_array_lit4_site_in` and `ts_new_array_lit_site_in`: an array
  literal whose elements fit in the cell (at most 256 bytes). The bump is in
  the zeroed run, so the fields the literal does not set are zero, as
  `gc_alloc` leaves them.
- `ts_new_object_layout_site_in`: an object literal of a resolved layout. It
  writes the layout's shape and the slots' initial words (undefined; zero
  for an integer slot).

The site's pretenuring state is read in line: a tenured site, a layout not
resolved yet (its first allocation), a size over 256 bytes, a class without
struct fields (its instance is a plain object), and an exhausted run or
budget all take the runtime's call as before. The debug modes keep every
limit at its pointer, so they never take the in-line path. The size
classes (`g_cclass`, `g_cclass_sized`), the site table and the Array and
Object prototypes are exported to the header (`ts_gc_pclass`,
`ts_alloc_site`). The runtime's call is followed by an assumption that its
result is an object, so after the merge of the two paths the C compiler
folds the receiver tests of the stores that follow.
`TSAOT_INLINE_ALLOC=0` makes the emitter call the runtime instead (the A/B
knob).

### The short string slice

A slice shorter than 13 units (V8's sliced-string threshold) is flat. It
went through the view constructor, then the copy constructor: two root
pushes, two views of the source, a `memset` call for the terminator, a
`memcpy` call for the units and a scan of the copy for its ASCII flag.
`ts_string_slice_view` now makes it in one cell (zeroed, so only the
terminator is stored), copies the units with two to four overlapping word
moves (`ts_copy_small`; a byte loop becomes a `memcpy` call), and keeps the
source's ASCII flag (a slice of an ASCII string is ASCII), scanning only
when the source has none.

### The barriers' remembered fast exits

A store of a young value into an old container called the barrier's
out-of-line half at every store, though after the first such store the
container is remembered and its card is dirty. Two exits are now in line:

- An old array (`ts_array_remember_inline`, in the in-line element store
  and push): the array is remembered and the slot's 64-element card is in
  its dirty range, or the whole array is dirty.
- An old class instance (`ts_write_barrier_hdr`): a remembered sized
  instance is scanned whole at the next young collection, whatever the
  value.

### Measurements (phase 2)

The kernels, per iteration (instructions, cycles), before and after the
in-line allocation (A), then with the short slice and the barriers' exits
(B). Node's time is in ns.

| kernel | lean (phase 1) | A | B | B ns | Node ns |
|---|---|---|---|---|---|
| `new P(i, i + 1)` to a module variable | 166.8 / 21.4 | 73.0 / 11.2 | 45.3 / 7.6 | 1.53 | 4.44 |
| `[i, i + 1]` | 122.5 / 19.0 | 64.0 / 11.4 | 64.0 / 11.4 | 2.45 | 2.10 |
| `[i, i + 1]` into a ring of 1024 | 213.6 / 28.9 | 168.2 / 22.3 | 147.4 / 19.2 | 4.32 | 5.48 |
| an eleven-element literal into the ring | 277.0 / 41.0 | 184.3 / 30.6 | 163.2 / 30.6 | 6.94 | 7.89 |
| `{ a: i, b: i + 1 }` into the ring | 313.2 / 41.5 | 235.5 / 29.6 | 213.5 / 26.7 | 5.66 | 4.31 |
| `new P(i, i + 1)` into the ring | 327.3 / 40.8 | 251.6 / 33.6 | 230.6 / 28.3 | 6.20 | 4.26 |
| an eight-unit slice into the ring | 434.7 / 55.0 | 434.6 / 56.1 | 269.3 / 34.3 | 7.55 | 6.84 |
| a closure into the ring | 309.9 / 41.4 | 308.9 / 40.7 | 283.8 / 36.2 | 8.31 | 7.76 |

### The literal's slots and stores (Session 361)

- The in-line literal (`ts_new_object_layout_site_in`) filled its slots
  with undefined in a loop, which clang turned into a `memset_pattern16`
  call at every site (90 calls in vue's binary for three or four slots, 1%
  of its samples); the fill is now relaxed atomic stores, which the
  compiler leaves as `n` stores.
- `ts_lit_store` was a call (`static inline`, not inlined): it is now in
  line for an in-object slot of a shaped object that is not old (a literal
  just made in the young space, a stack cell), which needs no barrier, and
  out of line otherwise (`ts_lit_store_slow`: an old object, an external
  slot, a dictionary object). vue's compiler phase 318 -> 293 ms with the
  `for..in` change of the same session.

## Calls to module-level const functions

A module-level `const f = (...) => ...` is called directly when the
caller can supply its captures (`TSAOT_CONST_FN_DIRECT`). The test asked
whether the caller had captured each free binding of the callee by name.
A callee that reads another binding of its own module (vue's
`isIntegerKey` reads `isString`) captures that module's scope record,
and a caller in another module holds the same record for the bindings
it imports, but not the name `isString`. Such a call made a closure on
the stack and called it through the value path: the function cell
built, its name and arity set by a call, and the generic entry with an
arguments array. The test now asks whether each capture slot can be
supplied (`slotSuppliable`: a value, a cell, or a record the caller
holds or the module's global record), which is what the direct call's
cell arguments then pass. vue made 141 such closures at call sites and
makes 90 now (the rest are callbacks); its reactivity phase ran 675 ->
660 ms. `TSAOT_SLOT_DIRECT=0` keeps the per-name test. Bundler case
`const_arrow_capture`.

WeakMap.get and WeakMap.has with an object or function key probe the
indexed weak map in line (`ts_weakmap_get_ref`), as a Map with a
reference key does; vue reads its target and proxy maps on every
reactive access (reactivity phase 660 -> 650 ms).

## Next

- The kernels above were built without a tsconfig, so the strict type
  profile, and with it the class hints, were off: a field read back went
  through a property cache. Under a strict tsconfig, as the real projects
  build, `ring[j]?.b` on a class instance reads the field behind the class
  interval test, and the class instance ring kernel runs at 3.49 ns (Node
  4.26).
- An object literal's stores each test the shape, the slot and the
  generation in line (Session 361); the layout's shape tested once, with
  the object young, would let every store be a plain store, as the integer
  slots' stores already are (`_ts_lkok`).
- An anonymous object type (`{ a: number; b: number }`) has no static slot
  hint (the hint needs a named type's producers), so its reads take the
  sized cache.
- Closures are allocated by the runtime: the function cell, its
  environment in the payload heap, then the name and arity in a second
  call. They are the next allocation kind to bring in line.
- tsc-ts gains little: its hot allocations are at tenured sites, and 5,053
  sites in line grew its binary from 44.1 to 45.0 MB. A profile-guided
  build lays the cold ones out of the way.
