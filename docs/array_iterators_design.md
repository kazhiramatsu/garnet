# Array iterators and for..of over values of no known type

Session 350, build `x65`. Exporter (`exporter.ts`), emitter (`emit_c.rs`),
runtime (`ts_rt.c`, `ts_rt.h`).

## Finding

Three silent miscompiles and a loud one around iteration:

- `arr.values()`, `arr.keys()` and `arr.entries()` on a typed array
  returned a copy of the array at the call (`ts_array_values_arr`, ...): a
  `for..of` over them missed elements pushed during the loop and kept going
  after a `pop()` (V8's array iterator tests the index against the current
  length at every step), and as values they had no `next()` (a TypeError).
- A `for..of` over a value whose static type was not an array, a string
  or a known iterable (`any`, `unknown`, a type parameter, a union) was
  lowered as the array index loop: an `any` holding a Map, a Set, a
  generator, a string or a custom iterable iterated zero times.
- A union of different kinds (`number[] | Set<number>`) was classified by
  its printed form, so its first member decided: `for..of` took the
  Map / Set cursor and threw for an array argument.
- `Object.prototype.toString` of a generator object read `[object
  Object]` (no `Symbol.toStringTag` on the generator prototype), and
  `Array.prototype.keys` / `values` / `entries` were missing for dynamic
  calls.

## Change

- **for..of over `arr.values()` / `keys()` / `entries()`** of a built-in
  array walks the array itself with the index loop (live length),
  binding the element, the index, or the `[index, element]` pair; a
  two-name pattern binds both directly, any other pattern destructures a
  fresh pair (`TSAOT_ARRAY_ITER_FOROF=0` keeps the call).
- **As values**, the three are Array Iterator objects (`ts_array_iter_new`
  with a kind: values, keys, entries; the shared `%ArrayIteratorPrototype%`
  with `next`, `@@iterator` and the tag), also reachable dynamically
  (`ts_arrproto_values` / `keys` / `entries`). `TSAOT_ARRAY_ITERATORS=0`
  keeps the copies (the parity oracle), and the exporter no longer counts
  their results as arrays.
- **for..of over a value of no known iterable type** (`lowerDynamicForOf`):
  `ts_forof_open` returns the value itself for an array (walked by index,
  the inline `ts_forof_next`, no iterator object), an array of code points
  for a string, and otherwise GetIterator (`[Symbol.iterator]()`, or the
  value when it is already an iterator); `ts_forof_next` returns the next
  element or `TS_ITER_DONE`. A non-iterable value throws a TypeError. The
  iterator is not closed on an abrupt exit (`KNOWN_GAPS.md`): the
  try/finally that would do it allocates a handler and saves a jump buffer
  at every loop entry. `TSAOT_FOROF_DYNAMIC=0` keeps the index loop.
- **Unions** whose non-nullish members fall into different kinds have no
  builtin receiver kind (`unionMixesKinds`; an interface derived from
  Array, Map or Set counts as that kind, so `NodeArray<Node> | Node[]`
  stays an array): their loops take the dynamic path, their method calls
  the dynamic dispatch. In the compiler this changed four functions, each
  a latent miscompile of the same kind: `flatMapIterator`'s `yield*` over
  `readonly U[] | Iterable<U>` walked any iterable as an array (no
  elements), `mutateMapSkippingNewValues` and `invalidateResolutions` called
  Map builtins on `ReadonlyMap | ReadonlySet` values.
- The generator prototypes carry `Symbol.toStringTag` (`Generator`,
  `AsyncGenerator`).

## Results

The compiler has no `for..of` of an unclassified value and uses no array
iterator as a value; four functions changed through the union rule. A/B
against `x64`: 4.305 vs 4.290 s and 4.335 vs 4.344 s median, neutral.

## Gates

Fixtures `arrays/array_iterators` (live loops over values / keys /
entries with pushes, pops and length cuts, every binding form, iterators
as values with `next()`, spread and `Array.from`, a live iterator value,
tags, dynamic receivers, a long loop) and `statements/forof_dynamic` (an
`any` holding every iterable kind and four non-iterables, a type parameter
bounded by `Iterable`, a union of an array and a Set, live mutation of a
Map, an array and a Set, labels, closures over the loop variable, a long
`any` array loop); both also under GC stress. The parity oracle exports and
emits with the old lowerings.

## The iterator objects' state (Session 361)

vue's reactive arrays are iterated through a wrapped native iterator
(`wrapped.next = () => wrapResult(iter.next(), wrapValue)`, the native
iterator's `next` read and called on every step), and garnet spent 41 ms of
a 980 ms run there against V8's 5. The iterator kept its state in three
hidden data properties (`__array_iterator_source`, `_index`, `_kind`,
listed by no enumeration: `field_is_hidden`), defined one by one at
creation (`ts_define_data`, three shape transitions), read through the
runtime's monomorphic caches and written through `ts_set_ic` on every step.

- **Creation** allocates the three slots in one layout (`g_ai_layout`, as a
  literal's: `ts_new_object_layout` and three `ts_lit_store`), then links
  the prototype. Map and Set iterators the same (`g_mi_layout`: source,
  last order id, kind).
- **`next`** finds the slots of an iterator in its layout's shape
  (`iter_state_slots`: the shape id, the integrity bits aside) and, for the
  values or keys of a dense array, reads them and writes the index in place
  (a number or undefined needs no barrier) before the result object; every
  other source (a typed array, an array-like, entries) takes the general
  step over the same slots. An object made from the iterator prototype
  (`Object.create(proto).next()`) has no such slots and keeps the
  incompatible-receiver TypeError.
- **A frozen iterator steps.** The state was written through the property
  path, so `Object.freeze(arr.values()).next()` threw "Cannot assign to read
  only property '__array_iterator_index'" where V8 steps it (an iterator's
  internal slots are not properties); the slots are now written whatever
  the integrity bits say. Map and Set iterators likewise.
- **The generic step** (`ts_iter_step`, a `for..of` over an iterator the
  type does not classify) keeps an iterator's own `next` (vue's `wrapped`)
  in its four-entry cache by receiver shape beside the prototype entries,
  and `ts_forof_next_slow` reads the result's `done` and `value` through
  the runtime's shape caches instead of two generic lookups per step. The
  cache's probe takes a shaped iterator alone: a dictionary's shape word is
  0, which is what an empty entry holds, and such an entry reads as an own
  `next` in slot 0. (A first cut lacked the test: an iterator with a deleted
  property threw from the generator fallback. Conformance had no such
  iterator; a review of the slice's diff before its commit found it.)
- **An array-like's step.** `length` is the program's code (a getter, a
  trap), which can take the iterator out of its layout's shape (a property
  added and deleted leaves a dictionary): the step finds the slots again
  after reading it, and otherwise writes the hidden properties.
- The native iterator's `next`, inherited from its prototype, is read
  through the inherited reads' table (`docs/hidden_class_design.md`, S1d).

vue's `iterator_next` 41 -> 19 ms. Fixture
`iteration/iterator_objects_state` (every kind by hand, live arrays, holes,
a done iterator after a push, fresh result objects, a frozen iterator, no
own properties, `next` through an object made from the prototype and as a
value, many iterators and arrays, Map and Set iterators across a set and a
delete, inherited reads before and after the prototype's value, method,
accessor and relink change, an iterator in dictionary mode, own `next`s
across shapes beside an inherited one, an array-like whose `length`
restructures its iterator).
