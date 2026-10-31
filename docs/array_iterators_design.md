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

## GetIterator's record, and array patterns the types do not settle (Session 361)

Differential tests written while reviewing the iterator state above found three places where the
drivers were not the protocol. All three are silent or nearly so, and the first two give wrong values.

**An array pattern over an `any` was an index walk.** `iterablePatternSource` and
`dynamicPatternDriver` sent `any`, `unknown` and strings to the index path ("read by index"), so
`const [a, b] = v` with `v: any` holding a Set, a generator or a custom iterable read `v[0]` and `v[1]`
and bound undefined, a Map's `[[k, v]]` threw reading `undefined[0]`, and a non-iterable (an object with
a `length`, a number) was accepted where V8 throws. The same held for a parameter `([a, b]: any)`, a
nested pattern and `for (const [a, b] of anys)`. A string pattern split surrogate pairs: `const [a] =
"😀"` bound a lone surrogate.

Such a pattern now goes through `valueIterDriver`, which is the dynamic `for..of`'s pair: `forof.open`
gives an array as it is, or an iterator through GetIterator (a string's code points as an array, a
TypeError for what is not iterable), and `forof.next` gives the element at the index in line, or a
step, with the done marker instead of a result object. So a real array in an `any` keeps its index read
with no iterator object, and `lowerArrayPatternByProtocol` takes the driver's `elemStep`. IteratorClose
at the end of a pattern is `forof.close` (nothing for an array). A pattern whose type is an array, a
tuple or a union of them stays the index path; every other type, a union with a string among them,
takes the driver. `TSAOT_FOROF_DYNAMIC=0` keeps the index reads.

**`next` was read on every step.** GetIterator's record holds the `next` method read once: a `next`
the iterator replaces while it runs is not seen by the loop, and a getter runs once. `ts_iter_step`
read it per step (behind the four-entry cache above), so an iterator that reassigned `this.next`
stopped early: `for (const x of it)` gave `1` where V8 gives `1,2,3`, for an `any`, a class and an
interface alike, and in a pattern. The drivers now read it once when they are set up, into a local:
`iter.method:<id>` (`ts_iter_next_method`: the field key, then the method key) or `forof.method:<id>`
(undefined for an array), and each step takes the local (`iter.stepWith`, `forof.next`,
`ts_iter_step_with`). `ts_iter_step` and its cache are gone, and with them a lookup per step on every
iterator loop, and the class of bug the cache's own-`next` entry had. A driver over one of our generator
objects keeps `generator.step`.

**`ts_forof_open` took any object as an iterator.** An object without `[Symbol.iterator]` was returned
as its own iterator ("an object with next"): `for (const x of { next() {...} })` ran, where V8 throws.
Generator objects have `[Symbol.iterator]` (their prototype's), so nothing needs the fallback: such a
value is a TypeError when the loop or the pattern opens.

Spread, `Array.from`, `new Set`, `new Map`, `Promise.all`, `Object.fromEntries` and a call's spread were
already right (each reads `next` once in the runtime). Not changed: `yield*` over an `any` is a
compile-time reject, and a dynamic `for..of` that exits early does not close its iterator
(`tests/conformance/KNOWN_GAPS.md`: a `try` per loop entry for the sake of the iterators that have a
`return`).

**The review of this slice** (Session 362) found three regressions no gate of the worktree had run into,
and the protocol's other gaps behind the new driver:

- The runtime's two users of `ts_forof_next` (`ts_forof_array_source`, `ts_mapset_cursor_source`: a typed
  loop over a Proxy of an array or a collection) passed their `ts_key` where the step now takes the `next`
  method, and C widened the integer silently. They read the method once as the drivers do.
- The driver's type test asked for `pat.parent`'s type, the checker's error `any` for a declaration with
  a pattern name, so every typed pattern took `forof.*`. It asks for `pat`'s. `const [a, b] = [y, x]` is
  back at no instructions at all (SROA), `for (const [a, b] of rows)` at the index reads.
- A string pattern copied the string (`const [c] = s` on 100 KB: 0.05 -> 526 G instructions). A pattern of n
  elements opens with `forof.open:<n>` (`ts_forof_open_limit`): the first n code points; a rest element
  takes them all.

**IteratorClose in a pattern.** A throw while an element binds (a default that runs code, a nested
pattern, a property target: `risky`) closes the iterator and the throw goes on. `done` stands for the
record's [[Done]]: true across a step, so a `next`, `done` or `value` that throws closes nothing; what the
close throws on a throw completion is dropped (a `TryCatch` around `returnCall` in the catch path). Such a
`try` exists only for a pattern with a risky element. The typed loop's close follows the same rule
(`resolveIterator`'s drivers, lowerForOf's try): `threw` picks the dropping close, a `break` or a
`return` the checking one. `ts_iter_close` itself is the normal completion's: a `return` neither nullish
nor callable and a result that is no object are TypeErrors. A Proxy sees one read of `next` and one of
`return` (the method-key read and the generator test skip it).

**Order and elisions.** An assignment pattern's property target is evaluated before its element's step
(`IterPatternElement.pre`, `lowerAssignRefPre`). An elision steps without reading `value`
(`forof.skip`, `ts_forof_skip_slow`).

**What counts as an object.** `ts_object_like` is the coercion gates' test: an ordinary function is no
object there and a Symbol's cell is. The protocol's checks take `ts_iter_object`: a function with
`[Symbol.iterator]`, a function as an iterator or as a result work, a Symbol is a TypeError. A
`next` that answers no object is a TypeError in the step itself (`iter_step`), for every driver, so a typed
loop no longer spins on it.

**Drivers and arrays.** The drivers take an array for the source, so an array handed back by
`[Symbol.iterator]()` was walked by index, whatever its `next`: the open wraps it in a Proxy (cold). An array
with an own `[Symbol.iterator]` runs that (`array_own_iterator`, behind one load of the property count:
`ts_forof_plain_array`, also in spread). A pattern nested in another, or a loop's assignment target
(`[[a, b]] = v`, `for ([a, b] of v)`), comes without a type and takes `valueIterDriver`; a top-level
pattern over an array or a tuple takes `lowerAssignArrayByIndex`.

**GetIterator by the value.** An `IterableIterator` type goes through `[Symbol.iterator]` (`iter.acquire`),
the value itself was its own iterator; a union with a generator takes GetIterator too (`isGeneratorType`
asks of every member); an object with `next` and no `[Symbol.iterator]` is a TypeError in
`ts_iter_acquire`; a class type closes when a subclass declares `return` (`iteratorMayHaveReturn`).

**for-await over a sync source.** Each value is awaited (`awaitValue`: always for a source the types call
sync, by `g_iter_acquired_sync` when `iter.acquire:1` fell back at run time); an array or a string is
accepted (it was a compile-time reject). A step an `await` separates from the reads of `done` and
`value` never takes the coroutine's scratch result (`generator.next`, `iter.stepFresh`): two loops
sharing a sync generator overwrote each other's.

Still open, listed in `tests/conformance/KNOWN_GAPS.md`: a generator's parameter patterns bind at the first
`next` (V8: at the call), a `next` assigned onto a generator object is not seen by a typed loop.

Fixture `iteration/iterator_protocol_fidelity` (`next` once through every driver, a `next` getter,
patterns over a Set, Map, generator, custom iterable and typed array in an `any`, closing, parameters,
nested patterns, defaults, assignment targets, `for..of` variables, holes, a Proxy of an array, code
points, every non-iterable's TypeError).
