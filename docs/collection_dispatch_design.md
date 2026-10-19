# Collection dispatch: derived interfaces, loud receivers, the cached `next`

Implemented in Session 350 (build `x46`); exporter and runtime. Knob
`TSAOT_MAP_INTERFACES=0` keeps the dynamic dispatch for interfaces that
extend Map/Set.

## Finding

After the hidden-field caches (`x43`) and the shaped array properties
(`x45`), the dictionary-lookup histogram was led by `next` 0.79M per
compile (the iterator protocol's method lookup on every step: the
runtime helper interned the key by string and walked to the prototype
each time) and `get` 0.45M: Map methods called through interfaces that
extend Map, which the exporter did not classify as maps. The compiler's
`core.ts` declares `MultiMap<K, V> extends Map<K, V[]>` with its own
`add` and `remove`; 48 `get`, 18 `set` and 11 `has` sites went through
the dynamic method dispatch (two cached lookups that never hit, since
the inline caches do not serve a Map receiver, then the generic call).

## Change

- A receiver typed as an interface whose base types reach the ambient
  Map/ReadonlyMap or Set/ReadonlySet (`derivedCollectionKind`) takes the
  collection path for its *builtin* members: the method calls that have
  a Map/Set builtin (`get`, `has`, `set`, `delete`, `clear`, `forEach`,
  `keys`, `values`, `entries`), `.size`, and `for..of` (the cursor loop).
  Its own members (`add`, `remove`) keep the dynamic dispatch, so the
  first attempt, which classified the whole receiver as a map and
  rejected `add` as an unimplemented stdlib method, is replaced by a
  member-aware check. Mirrors the array-derived interfaces (`NodeArray`).
- The Map/Set builtins throw the TypeError V8 throws for a method called
  on an incompatible receiver (`Method Map.prototype.get called on
  incompatible receiver`) instead of returning undefined, 0 or the
  receiver silently; `size` through a lying type throws too where V8
  reads a plain property (a loud reject in place of a silent one).
- `ts_iter_step` (the generic `.next()` of `for..of` and `yield*`)
  interns the key once and looks `next` up through a four-entry inline
  cache (own slot, prototype slot or absent, by receiver shape): the
  Map/Set and array iterators and the generator objects are a handful of
  shapes.

## Verification

Fixture `maps_sets/map_interfaces`: a MultiMap with its own `add` /
`remove` over the builtins, an interface deriving from it with an extra
property, a readonly view, a Set-derived interface, `for..of`, `forEach`,
`keys` / `values` / `entries`, `clear`, incompatible receivers (TypeError
in both), and 20k additions. Identical to V8 with the classification on
and off and under `TSAOT_GC_YOUNG_THRESHOLD=1`; the Map/Set, iteration and
generator fixtures unchanged. The compiler A/B (`x46` against `x45`) is in
the TODO entry.

## Results

Dynamic `get` dispatch sites 48 -> 0 in the compiler; dictionary lookups
11.5M -> 10.7M per compile with `next` gone from the histogram (the
first cache attempt through `ts_get_pic_checked` did nothing, since that
path fills no entry for an inherited hit; the shape-and-prototype cache
replaced it). The 0.45M `get` lookups that remain are not the dynamic
dispatch; their source is still to be found. Compiler A/B, `x47` against
`x45`, two rounds of three alternating runs (outputs validated,
diagnostics zero): 4.556 vs 4.533 s and 4.560 vs 4.555 s median wall,
pairs between -0.1% and +0.7%: neutral within the noise. Node 3.27-3.29
s, so 1.39x Node.
