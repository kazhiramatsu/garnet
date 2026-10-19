# Shaped named properties on arrays

Implemented in Session 350 (build `x44`); runtime only (`ts_rt.h`,
`ts_rt.c`). No knob: the representation of an array's named properties
is internal to the runtime.

## Finding

The per-key histogram of the dictionary lookups (`x41`, `x43`) is led by
the compiler's `NodeArray` properties: `pos` 1.2M, `end` 1.1M,
`transformFlags` 1.1M, `hasTrailingComma` 0.7M per compile. The node
factory sets them on every node list (`array.pos = -1; array.end = -1;
array.hasTrailingComma = ...; array.transformFlags = ...`) and the
parser, binder and checker read them constantly. An array was allocated
with shape 0, so its named properties lived in the dictionary
(`ts_prop` entries scanned linearly), every read went out of line and
no inline cache could serve it: the inline and static probes admitted
only `TS_KIND_OBJECT`, and the cache fill treated an array as a sized
instance (`ts_obj_is_sized` compared the cell size with the plain
object's).

## Change

- An array is allocated with the empty shape (`a->o.shape =
  TS_SHAPE_EMPTY`), so its named properties take shape transitions and
  live in the value vector (`inline_cap` is 0 for an array: every slot is
  external), exactly as a plain object's beyond its in-object slots. The
  GC, enumeration, deletion (to dictionary), freezing and the key order
  already handled shaped receivers through `obj_shaped`.
- `ts_obj_is_sized` is true only for a `TS_KIND_OBJECT` cell whose size is
  not the plain object's: an array is not a sized class instance.
- The kinds are renumbered so that `TS_KIND_OBJECT` (1) and
  `TS_KIND_ARRAY` (2) are adjacent; the inline cache probe and the static
  slot probes admit a receiver with `kind <= TS_KIND_ARRAY`, the same one
  compare as before. The generated C names kinds symbolically, so nothing
  emitted changes.
- The out-of-line cached read and store (`ts_get_pic_checked`,
  `ts_set_pic`, the negative cache) serve an array for any named key but
  `length`: an array's length is virtual, not a slot, and takes the
  generic path as before (`prop_cache_receiver`). Index keys reach the
  caches only through the dynamic path, which is unchanged.

## Verification

Fixture `arrays/named_props_shaped`: reads and writes of named
properties through typed and `any` receivers, `length` and indices beside
them, `Object.keys` / `for..in` order (indices first, then names in
insertion order), `in` and `hasOwnProperty`, delete and re-add, JSON,
slice/concat/spread dropping the names, a frozen array, a sparse array
with names, a plain object with the same keys through the same function,
and 5,000 arrays through the caches. Identical to V8, also under
`TSAOT_GC_YOUNG_THRESHOLD=1`; the array, object, static-slot and
deletion fixtures unchanged; the GC stress gate and all conformance
tiers. The compiler A/B (`x44` against `x43`) is in the TODO entry.

## Results

The first build missed two conformance fixtures: a typed array's virtual
`byteLength` / `byteOffset` / `BYTES_PER_ELEMENT`, and an index-like
dynamic key (`arr["1"]`), both reaching the cached path through the
array receiver; `prop_cache_receiver` now excludes typed storage and
index-like names. Dictionary lookups 14.8M -> 11.5M per compile (`pos`
1.2M -> 0.43M, `end` 1.1M -> 0.27M, `transformFlags` and
`hasTrailingComma` gone); peak RSS 884 -> 865 MB. Compiler A/B, `x45`
against `x43`, two rounds of three alternating runs (outputs validated,
diagnostics zero): 4.536 vs 4.566 s and 4.549 vs 4.563 s median wall,
four of six pairs between -0.7% and -1.3%. Node 3.27-3.31 s, so 1.38x
Node.
