# Runtime inline caches for hidden fields; `hasOwnProperty.call`

Implemented in Session 350 (build `x43`); runtime (`ts_rt.c`, the RegExp
adapter), exporter (one call shortcut). No knob: the caches are internal
to the runtime and the shortcut lowers to an existing builtin.

## Finding

The per-key histogram of the dictionary lookups (`x41`) listed, besides
the `NodeArray` properties, the runtime's own reads of hidden fields:
the Map iterator's `__map_iterator_last` 0.57M, `__map_iterator_source`
0.47M, `__map_iterator_kind` 0.38M per compile (three `ts_get` and one
`ts_set` per `next`), the array iterator's `__array_iterator_index` and
`_source` 0.70M, a generator's `__coro` 0.39M (and the key interned by
string on every call at three sites), the RegExp internals
`__tsaot_rx_prefix` 0.71M, `lastIndex` 0.43M, `source` and
`__tsaot_rx_flags_mask` 0.29M each; and `call` 1.22M: `core.ts` binds
`const hasOwnProperty = Object.prototype.hasOwnProperty` and calls
`hasOwnProperty.call(map, key)` 600k times per compile, each looking
`call` up on the function object and then on `Function.prototype`. The
iterator results (`{ value, done }`) were built by two generic stores
(two shape transitions) and read back out of line by the runtime's
consumers (`value` 1.05M, `done` 1.05M).

## Change

- `ts_get_ic` / `ts_set_ic` (`ts_rt.h`): a monomorphic inline cache for
  the runtime's own field accesses, one shape word and slot per call site,
  filled from the own-property lookup of a shaped receiver (data property;
  writable for a write), any other receiver taking `ts_get` / `ts_set`.
  The shape word carries the integrity bits, so a frozen receiver misses.
  Applied to the Map/Set iterator's three fields and position write, the
  array iterator's two, the generator's `__coro` (the key interned once),
  and the RegExp object's `source`, `flags`, prefix, flags mask and
  `lastIndex` reads and writes in the runtime and the adapter.
- Iterator results come from a fixed two-key layout (`value`, `done`):
  one allocation, no transitions, the same shape every time, so the
  loops' cached reads hit.
- `hasOwnProperty.call(o, k)` and `Object.prototype.hasOwnProperty.call(o, k)`
  (the method itself, or a module `const` bound to it) lower to the
  own-property builtin of `o.hasOwnProperty(k)`. That builtin
  (`ts_has_own_dyn`) now throws the TypeError of ToObject on a null or
  undefined receiver, which `o.hasOwnProperty(k)`, `Object.hasOwn(o, k)`
  and the `.call` form all do in V8; it returned false silently.

## Verification

Fixture `object_methods/hasown_call` (own and inherited keys, class
fields, array indices and `length`, string and number receivers, a
missing key, Map receivers, null and undefined receivers). The iterator,
generator, Map/Set, regexp and spread fixtures unchanged, also under
`TSAOT_GC_YOUNG_THRESHOLD=1`; the GC stress gate, conformance (all
tiers), parity, selfconf, bundler, unit. The compiler A/B (`x43` against
`x42`) is in the TODO entry.

## Results

Dictionary lookups (`prop_find`) 19.6M -> 14.8M per compile: `call`
gone, `value`/`done` 1.19M -> 0.30M, the Map iterator fields gone, the
generator's `__coro` 0.39M -> 0.29M; root pushes 30.8M -> 28.5M.
Compiler A/B, `x43` against `x42`, two rounds of three alternating runs
(outputs validated, diagnostics zero): 4.595 vs 4.632 s and 4.601 vs
4.641 s median wall, five of six pairs between -0.4% and -1.3%. Node
3.27-3.29 s, so 1.40x Node.
