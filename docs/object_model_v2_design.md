# Object model v2 — shape-owned keys, value vectors, in-object slots

Track A of `v8_parity_roadmap.md`. This note fixes the representation and
the slice boundaries before any code changes, so each slice can be gated on
its own (conformance, parity, selfconf, GC stress, benchmarks, compiler A/B).

## Today

`ts_obj_common` (72 bytes): header, `proto`, `ts_prop* props`, `cap`, `len`,
`prop_index`, `prop_index_cap`, `shape` (29-bit hidden class + 3 integrity
bits). Every own property is a 16-byte `ts_prop {key, val, flags}` in a
malloc'd vector; shape ids name key sequences through a transition table but
carry no data of their own; deletion moves an object to shape 0 (dictionary).
A monomorphic read is therefore handle → cell → vector → entry.

## Target representation (slices A2 and A3)

- **Shaped object** (`shape != 0`): `props` points at `tsv vals[]`, 8 bytes
  per property. Keys and attribute flags are owned by the shape descriptor.
  No `prop_index`.
- **Dictionary object** (`shape == 0`): unchanged `ts_prop[]` vector with keys
  and flags per entry, optional `prop_index`. Sized class instances stay here.
- **Shape descriptor** `g_shapes[id]`: parent, key, flags of the last
  property, depth, and a lazily materialized key vector (and flag vector)
  for the whole sequence; shapes with eight or more keys also get a small
  open-addressing index. Transitions are keyed by `(parent, key, flags)` so
  the flags are part of the hidden class: defining a non-enumerable property
  moves to a different shape than an ordinary store of the same key.
- **In-object slots** (A3): objects allocated with inline capacity keep the
  first `inline_cap` values inside the cell; `vals` then addresses the
  overflow vector. The PIC entry records inline/external and, for a slot
  known to be plain data, the flags, so the inline read never consults the
  shape table.

`ts_obj_common` keeps its 72-byte layout in A2 (the `props` pointer is
reinterpreted by `shape`); A3 adds the inline area after it for objects
allocated through the sized constructors.

## Invariants

1. `shape != 0` ⇔ `vals` representation; the key order of the object is the
   shape's key sequence; `len` is the shape depth.
2. Attribute redefinition of an existing property, deletion, and integrity-
   preserving operations that today rewrite flags convert a shaped object to
   a dictionary first (`obj_to_dictionary`), then proceed as today.
3. Every property read/write/enumeration path goes through the accessors
   `obj_key_at`, `obj_val_ptr`, `obj_flags_at`, `obj_prop_count`; no site
   indexes `props[]` directly except the two representation-specific helpers.
4. The PIC contract (`property_pic_design.md`) is unchanged for callers: a
   shape hit yields a slot; the inline read loads `vals[slot]`; accessor and
   non-writable slots never complete inline (the entry's flag byte says so).
5. GC scans `vals[0..len)` for shaped objects, `props[i].val` for
   dictionaries, and symbol keys from the shape key vector; moving copies
   the cell and (A3) its inline area, not the overflow vector.
6. Emitted C text does not change (all of this lives in `ts_rt.h` inline
   helpers and `ts_rt.c`), so the byte-parity oracle stays as it is.

## Slices

- **A2a — shape descriptors.** Add `g_shapes`, transition keyed by flags,
  lazy key/flag vectors, `obj_to_dictionary`. Keep the `ts_prop` vector as
  the only representation; assert in debug builds that a shaped object's
  entries match the shape. Gate: full set. No performance claim.
- **A2b — value vectors.** Switch shaped objects to `vals[]`; convert the
  ~85 property sites to the accessors; the small-buffer pool serves 4-slot
  value vectors (32 bytes) and 4-entry dictionary vectors (64 bytes).
  Gate: full set plus GC stress and the property kernels; compiler A/B for
  RSS and time.
- **A3 — in-object slots.** Allocation-size policy (literal count, learned
  constructor estimate, default small capacity), inline/external addressing
  in the accessors and PIC entries, moving-GC support. Gate: full set,
  GC stress with forced moving, compiler A/B.

## Expected effect

A2 halves property memory and keeps one key vector per shape instead of one
per object; its time effect comes from cache density. A3 removes one
dependent load from most property reads of small objects, which the Session
350 profile puts in the largest bucket (generated code, 57% of samples).

## Status (Session 350)

- A2a: implemented. Shape descriptors with flag-aware transitions,
  `props_define`, `obj_to_dictionary`; instrumented `SHAPE_CHECK`. All gates
  passed on the real compiler workload with the check active.
- A2b: implemented. Shaped objects store `tsv vals[]`; keys and flags come
  from the exported `g_ts_shape_keys`/`g_ts_shape_flags` vectors (eager per
  shape, with a per-shape open-addressing index from eight keys); the
  property reference `ts_pref {object, slot}` replaced `ts_prop*` throughout
  the runtime; the inline probe returns a value pointer plus the slot's
  attribute flags (cached in the top byte of the entry's slot word); deletion
  and attribute redefinition convert to a dictionary first. Dictionary objects,
  sized class instances, arrays, functions, maps and sets keep the entry
  representation. Gates and the compiler A/B are recorded in `TODO.md`.
- A3 (in-object slots): implemented (Session 350). The GC header's pin word
  carries `inline_cap`, the number of value slots that follow the 72-byte
  header of a plain object (`ts_obj_inline_vals`); slot `i` of a shaped
  object lives in-object for `i < inline_cap` and in the external vector
  otherwise (`ts_obj_slot_ptr`, used by the inline PIC probe and the
  `obj_val_at` accessor), and `o->cap` counts external slots only. Sized
  class instances are told apart by `ts_obj_is_sized` (cell size versus header
  plus inline area) instead of the old `size == sizeof(ts_object)` test.
  Sizing policy: object literal sites allocate exactly their field count
  (`ts_new_object_n`, emitted from the literal's type shape;
  `TSAOT_INLINE_SLOTS=0` keeps `ts_new_object()` for the parity oracle),
  plain-function constructors learn an instance size (`ts_func.inst_slots`:
  first instance 12 slots, then the largest observed count plus 4), and the
  default is 4. A dictionary conversion keeps the inline area allocated but
  never reads it; moving collections copy the cell by its size, so inline
  values travel with it. Fixture `objects/inline_slots`.

## Shape chains (slice N, session 352)

A new shape used to copy its parent's key and flag vectors and rebuild its own
index, so a dictionary-like object built one key at a time (an enum's forward
and reverse maps, `Diagnostics` with its ~2000 entries, a keyword table) cost
O(n^2) in shape creation: tsc-ts's parse-only run created 16,967 shapes almost
all at module initialization, 4.9% of its samples in `shape_transition_f` plus
the mallocs, copies and zeroing under it.

Now the shapes along a linear transition chain share one `ts_shape_vec`: one
growing pair of key and flag vectors and one open-addressing index. A shape's
entries are `[0, depth)`; entries `[depth, claimed)` belong to its descendants
on the chain. A child appends in place when its parent is the last shape that
claimed an entry (`claimed == parent depth`); any other child is a branch and
copies the parent's prefix into vectors of its own, with room for the chain to
double. Growing the shared vectors moves them, so the public per-shape pointers
(`g_ts_shape_keys`, `g_ts_shape_flags`) of every shape on the chain are
re-pointed by walking the parent links from the appending shape; the static
slot probe rows stay per shape. The shared index holds every claimed entry, so
`shape_index_find` accepts an entry only when its slot is below the probing
shape's depth; keys are unique along a chain, so a key found above the depth is
absent. Every reader of the vectors indexes below the object's own length, so
a shared tail is never observed. `runtime/ts_rt_test.c` (`test_shape_chains`)
and `objects/dictionary_chain` cover the chain, a branch, prefixes and a prefix
object that later continues the chain.
