# Cursor-driven `for..of` over Map and Set

Implemented in Session 350 (build `x42`); exporter, emitter (five static
builtins) and runtime. Knob `TSAOT_FOROF_CURSOR=0` keeps the iterator
protocol (the parity oracle sets it on its exporter line).

## Finding

The per-key histogram of the dictionary lookups (`x41`, `prop_find`
11.6M calls per compile) put the iterator protocol near the top: `value`
1.05M, `done` 1.05M, `next` 0.70M, `__array_iterator_index` 0.70M. A
`for..of` over a Map or Set (or over `keys()` / `values()` / `entries()`
of one) was lowered to the protocol: `map.entries` builds an iterator
object holding its source, position and kind as named properties, every
step is a dynamic `next` method call that reads those three properties
through the dictionary, binary-searches the insertion-order ids,
allocates a result object, writes `value` and `done` into it and, for
entries, allocates the `[k, v]` pair; the loop then reads `done` and
`value` back through the dictionary. About a million steps per compile,
each with four dictionary lookups and two or three allocations.

## Change

The exporter lowers such a loop to a cursor over the collection itself:

    last = -1
    loop while (idx = map.cursorNext(coll, last)) >= 0:
      last = map.cursorOrder(coll, idx)
      k = map.cursorKey(coll, idx); v = map.cursorVal(coll, idx)   # or cursorPair
      <bind the loop variable; body>

The runtime functions share the protocol's insertion-order ids
(allocated lazily on the collection as the iterators do): `cursorNext`
binary-searches the first live entry whose id exceeds `last`, so entries
added during the loop are visited, deleted ones skipped, the current
entry deleted and re-added visited again at the end, and compaction is
harmless. `clear()` empties the dense arrays, so the next step ends the
loop. A `[k, v]` pattern of two plain names binds the key and the value
directly (no pair array); any other pattern, a plain variable or an
assignment target receives the pair (`cursorPair`) and goes through the
usual destructuring. `keys()` binds the key, `values()` the value; on a
Set both are the element and `entries()` gives `[v, v]`. Per-iteration
capture cells are set up exactly as in the protocol-driven loop, and
`continue` is a plain jump (the step is in the loop condition). A
receiver that is not a Map or Set at run time (an `any` flow) throws a
TypeError, as the protocol's `map.entries` did. Map and Set iterators
have no observable `return`, so nothing closes on `break`.

Not covered: iterators consumed elsewhere (spread, `Array.from`,
`arrayFrom(iter)` in the compiler's `core.ts`, generators that take an
iterable) still go through the protocol.

## Verification

Fixture `maps_sets/forof_cursor`: all six forms on both collections,
mutation during the loop (add, delete the current, delete a later one,
re-add, clear and refill), destructuring with defaults, holes, rest and
nesting, a plain variable and an assignment target receiving the pair,
nested loops over the same map with `break` and `continue`, closures
capturing the loop variables, large collections in the indexed mode
with deletions, number keys, and a non-collection receiver. Identical to
V8 with the cursor, with the knob off and under `TSAOT_GC_YOUNG_THRESHOLD=1`;
the existing Map/Set iterator and `for..of` fixtures unchanged.

## Results

Kernel `benchmarks/patterns/map_forof.ts` (a 2,000-entry Map walked as
entries, keys and values, and a 2,000-element Set, 400 rounds, with
insertions): 348 ms with the protocol, 161 ms with the cursor and the
binary search per step, 48 ms with the previous-index hint; Node 66-71 ms
(5.2x -> 0.73x). The compiler is neutral (`x42` against `x41`: 4.641 vs
4.611 s and 4.627 vs 4.632 s median): its Map iteration runs through the
`core.ts` iterator helpers typed `Iterable`, where the protocol stays.
