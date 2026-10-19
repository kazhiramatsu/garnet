# Dirty slot ranges for remembered objects

## Data (Session 350, statistics relink of `native_s350x10`)

A minor collection rescans every remembered old cell completely: 2.70M
rescans per compile across 612 minors (4.4k per minor), each visiting
every property of the object and marking every key. In the profile the
rescans are `gc_mark_common_props` (1.8%), part of `gc_scan_cell` (2.1%)
and `gc_mark_visit` (1.3%; 27.6M of the 51.3M marked edges point at old
cells and are filtered one by one). Arrays and maps already keep a dirty
card range (`gc_dirty_first`/`gc_dirty_end`, 64 elements per card) and
scan only it; plain objects — the compiler's nodes, links and symbols,
written one property at a time — do not.

## Design (`TSAOT_REMEMBERED_SLOTS=0` keeps the whole-cell rescan)

The unused `hdr_spare` byte of the cell header holds a dirty card range
for `TS_KIND_OBJECT` cells: cards of 8 slots, `first` in the high nibble,
`end` (exclusive) in the low nibble, `0xFF` meaning "every slot". Fifteen
cards cover the first 120 slots; a write beyond, or any write whose slot
the barrier does not know, sets `0xFF`.

- `ts_write_barrier_slot(owner, slot, value)`: the checks of
  `ts_write_barrier`, then the range update and `gc_remember`. Used where
  the slot is known: the inline-cache set paths (the probe reports the
  slot it hit), `ts_lit_store`, the out-of-line named-property writes.
- `ts_write_barrier(owner, value)` (slot unknown: prototype writes, class
  fields of sized instances, closures' environments, promotion) sets
  `0xFF` for an object owner before `gc_remember`, as `ts_gc_remember`
  sets `gc_dirty_all` for arrays and maps.
- `gc_mark_common_props` during a minor collection scans a remembered old
  object's cards only, and skips the class fields of a sized instance when
  the range is precise (a class field is written through the generic
  barrier, which marks everything); a full collection scans everything.
- The post-minor reset clears the range with the `remembered` credit; an
  entry re-enrolled under aging keeps its range, as arrays keep their span.
  A cell promoted during the minor and re-enrolled takes `0xFF`.
- Property deletion and dictionary compaction renumber slots: they set
  `0xFF` on an old object, as array reordering does.

## Expected effect

A remembered node or links object with ten to thirty properties and one or
two dirty cards visits a handful of slots instead of all of them, and no
keys of a shaped object; about two percent of the compile.

## Soundness checklist (the open challenge from this session)

Fixture `gc/remembered_slots`: young values stored into old objects at
low, middle and high slots and beyond the covered range, into dictionary
objects, after deletion, through prototypes, into class instances' fields
and dynamic properties, with minor collections forced between the writes
and the reads (`TSAOT_GC_YOUNG_THRESHOLD=1`, a tiny nursery, forced full
collections), and the GC stress gate.
