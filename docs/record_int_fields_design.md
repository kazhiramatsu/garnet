# Integer slots for the numeric fields of records

Records here are the objects TypeScript types structurally: object literals
typed by an interface or by their own literal type (`{ kind, v }`, `TextRange`,
a scanner's token record), as opposed to instances of classes with declared
fields, which `docs/int32_fields_design.md` already stores in integer slots.
This design gives a record's integer-valued fields the same representation
and, where a whole-program proof allows, the same integer typing of the
values read from them.

## Why

The pattern kernels against V8 (October 26 2026, the strict profile,
`scripts/pattern_bench.sh`): `switch_dispatch` 2.77, `small_calls` 2.19,
`flags_truthy` 1.91, `ctor_functions` 1.77, `object_arrays` 1.66. Their
receivers are records, and their numeric fields are NaN-boxed doubles in the
object's slots. Every integer use of such a field (`n.flags & F`,
`switch (n.kind)`, `n.v ^ 5`) is a load, an `fmov` into the floating-point
register file (about five cycles on this core) and an `fjcvtzs` (about
five); a `| 0` written back to a local adds an `scvtf`. In `switch_dispatch`
the loop-carried chain `sum = (sum + visit(n)) | 0` is a double add, the
conversion and the conversion back, about fifteen cycles, and the kernel
runs at sixteen cycles per iteration whatever its instruction count:
force-inlining `visit` took it from 8.95 to 8.28 G instructions and raw slot
reads to 4.0 G, the cycles unchanged (1.59 G). V8 keeps `sum` and the fields
as Smis.

The generated C of `switch_dispatch` rewritten by hand to what this design
would emit (the two fields stored as integers in their slots, the same
static-slot shape probes before each read, the values read as integers,
`visit` returning an integer, the accumulator an integer local; the output
identical):

| variant | instructions | cycles | wall |
|---|---|---|---|
| today (boxed doubles) | 8.95 G | 1.59 G | 0.35 s |
| integer slots, the call kept | 6.03 G | 0.75 G | 0.17 s |
| integer slots, `visit` inlined | 5.53 G | 0.62 G | 0.14 s |
| node (60 ms of startup included) | 3.83 G | 0.61 G | 0.14 s |

The integer slots alone are 2.1x in cycles (V8's 2.77x becomes 1.2x); the
remaining fifth is the call, which clang declines to inline because every
generated function also has a wrapper in `FN_TABLE` (a second caller), a
separate item (S3 below).

What it does not buy: tsc-ts. Its nodes, symbols, types and links are classes
with declared fields, and a `-DTSAOT_RT_STATS` build compiling the compiler
project single-threaded counts 4.7 M property-cache reads and 145 K
static-slot reads in a 22 G-instruction run, about 0.3% of its instructions.
This design is for pattern parity and for programs written the way most
TypeScript is written: interfaces and literals.

## The representation

- **The kind is part of the shape.** A shape transition is keyed by
  (parent, key, attribute flags) already (`shape_transition_f`). An
  `int32` bit in the attribute byte makes a field stored as an integer a
  different shape from the same key stored boxed: siblings with the same
  keys. Nothing else about shapes changes: `g_ts_shape_keys` stays pure,
  `obj_flags_at` carries the kind to the generic paths, and the shape word
  of an object says, through its shape's vectors, which of its slots hold
  integers.
- **The slot holds the int32 zero-extended** in its 64-bit word. The
  collector's slot scan is unchanged: a word with its top bits clear is
  never a heap tag (a sign-extended negative would be: `-1` is all ones,
  which is a tagged word). The range is int32, like an enum field's; a
  larger integer is stored boxed (below, generalization).
- **The probe vectors carry the kind.** `g_ts_probe_rkeys`/`wkeys[sid]
  [slot]` hold the key with a tag bit (a high bit no key base uses; the
  user symbols start at 2.1e9, `TS_KEY_NONE` is all ones) when the slot is
  an integer. A read the emitter types as an integer compares the vector's
  word against `key | INT`: the same one load as today, the integer path
  on equality; against `key` for the boxed path. A boxed read compares
  against `key` and takes the out-of-line read (which boxes) for an integer
  slot. The write vector likewise.
- **The generic paths box.** One accessor pair, `obj_slot_value(o, i)` and
  `obj_slot_store(o, i, v)`, reads an integer slot as `ts_num((double)
  (int32_t)w)` and stores by the slot's kind; every reader of a slot value
  goes through it or is audited: `obj_val_at` (13 uses), `pref_val` (13),
  `pref_valp` (16), `ts_obj_slot_ptr` (8), `prop_ic_read` (7), the inline
  cache fast paths (`ts_get_pic_checked_inline` and the static probes:
  their flag test treats the `int32` bit like the accessor bit, so an
  untyped site never reads an integer slot in line and stays correct; only
  typed sites take the integer path), JSON, `Object.keys/values/entries`,
  spread and rest, `for-in`, the message codec, `publish`, `Object.assign`,
  `defineProperty`, the dictionary conversion (`delete`: integer slots are
  boxed into the dictionary entries), `console.log`, the comparisons.
- **Generalization, not a trap.** A store of a value that is not an int32
  into an integer slot moves the object to the sibling shape in which that
  slot is boxed (`shape_generalize(sid, slot)`: the transition from the
  integer shape to a shape with the same keys and the bit cleared, cached
  as the other transitions are) and converts the slot. The object alone
  changes; other objects of the shape, the inline caches (keyed by shape:
  the moved object misses and refills) and the static-slot sites (the
  vector of the new shape says boxed) are untouched. The representation
  layer therefore has no deviation from V8: an `any` route storing `1.5`
  stores `1.5`.
- **Creation.** `ts_lit_layout` gains a kind per key; `lit_layout_shape`
  walks the kind-bearing transitions; the literal's stores write by kind.
  The exporter marks a key `int32` when its initializer is an int32
  constant, an enum member, an integer local or fact, or a bitwise result,
  and only under the strict profile (the plain profile and the parity
  oracle see no kinds). Additions through a typed store (`o.count = 0` on an
  object lacking `count`) stay boxed in S1; S2 may add the integer kind at
  additions whose value is a proven int32.

## Typing the values read (the proof)

The experiment's full win needs more than the slot: `visit` returning an
integer and `sum` staying an integer local need every object that reaches
the read to hold the field as an integer, or the local must be a double. A
record's objects can come from anywhere a structural type admits: a literal
elsewhere, `JSON.parse`, a cast from `any`, `Object.create`, a spread. So
the integer *type* of a read is a whole-program fact, as it is for classes:

- **Closed records.** For a field `f` of a record type `T`: the values of
  type `T` are produced only by literal sites whose `f` is integer-kinded
  (and typed stores of int32 values), with no `any`, `unknown`, cast, JSON,
  spread or structural flow of another origin into a `T` position. The
  structural pass that seeds classes (`docs/foreign_receivers_design.md`,
  "Structural values", class_extract pass 3) is the machinery: the same
  contextual-type walk over initializers, arguments, returns, elements and
  defaults, applied to interface and literal types instead of classes. A
  type that fails is open: its fields keep the per-object representation
  and the bitwise consumers' fast path, and nothing is typed from them.
- **Under the proof** a read of `f` into an integer local is the probe and
  one integer load; a function whose returns are all integer expressions of
  such reads returns `long long` (the existing i64-return machinery); the
  int-local inference admits the reads. The one route the proof does not
  see is a dynamic store (`(t as any).f = 1.5`, a computed key): it is
  refused with a TypeError naming the field, the deviation the class design
  keeps and the README lists, behind the same knob
  (`TSAOT_INT_STORE_FIELDS`); without the proof there is no deviation at
  all, since the representation generalizes.

## Emitter

- `LoadField` of a number-typed record field: `(vector[slot] == key|INT)
  ? (int32_t)slot : ts_to_num(out of line)`; under a closed proof the
  destination is an integer local and the slow branch converts with the
  exactness rule of a store.
- `StoreField`: an integer value stores by the slot's kind (the write
  vector's tag); a double or boxed value takes the out-of-line store, which
  generalizes when it must (or, under the proof, refuses).
- Returns and locals: as for classes (`infer_int_locals`, the i64 returns).
- Knobs: `TSAOT_INT_RECORD_SLOTS=0` (no kinds in layouts: the parity oracle,
  A/B), `TSAOT_INT_RECORD_SLOTS_LOG=1` (the kinds decided, the closed and
  open types with the opening site).

## What it should buy

The kernels: `switch_dispatch` 2.77 to about 1.2 against V8 (1.0 with S3),
and the record-heavy stragglers (`small_calls`, `flags_truthy`,
`object_arrays`, `ctor_functions`) a measured share of their conversions;
the expectation is 1.3 to 2x, to be measured per slice. tsc-ts: identical
output and instructions within noise, by construction (its hot reads are
struct fields; its literal records with integer initializers, `{ pos, end }`
and the like, gain the kind and a two-compare probe at their reads, which
the A/B must show neutral).

## Slices

- **S1, the representation**: the kind bit, the sibling transitions, the
  probe vectors with the tag, the slot accessors and the audit of every
  reader, generalization, layouts with kinds and the exporter's marking of
  literal initializers, the inline fast paths' flag test. Fixtures:
  `objects/int_record_slots` (integers, negatives, zero, the int32 edges,
  a fraction stored later and the same object read before and after,
  JSON, `Object.keys/values/entries`, spread, `for-in`, `delete`,
  `freeze`/`seal`, `defineProperty` on the slot, a shape shared by an
  integer-kinded literal and a boxed one, reads through `any`, a message
  to a worker, console.log). Unit tests: the collector's scan over negative
  integer slots under GC stress, generalization under the shape limit.
  Gates: the full set; parity through the knob; tsc-ts identical and within
  noise; the kernels' instructions and cycles.
- **S2, the typing**: closed records (the structural pass over record
  types), integer locals and returns from record reads, the deviation and
  its knob, the log. Measured on the kernels (the experiment's second row
  is the target for `switch_dispatch`).
- **S3, the call**: a free function with one call site (the wrapper's
  reference aside) inlined by the IR inliner or its wrapper emitted only
  when the function is used as a value, so clang's last-call heuristic
  applies. Measured on `switch_dispatch` (the third row) and tsc-ts.

## Risks

- A slot reader missed in the audit reads an integer word as a boxed value:
  a silent wrong value. The fixture set above exists to make every generic
  path read an integer slot; the untyped conformance run
  (`TSAOT_UNTYPED=1`) and the GC-protect run are part of the gate.
- Shape growth: a key stored as an integer at one site and boxed at another
  doubles the shapes of that key sequence; `TS_SHAPE_MAX` and the reserved
  tables (P10) bound it; the log counts siblings.
- Code size: a typed read gains a compare; the sized-class paths are
  untouched.
- Under the proof, the TypeError on a dynamic non-integer store is a
  deviation V8 does not have; it is loud, documented and behind a knob, and
  it does not exist for open types.
