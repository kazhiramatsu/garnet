# Arbitrary iterator protocol (for-of / for-await / yield* over custom iterators)

## Scope
Support driving objects that expose the iterator protocol's core: a `next()`
method returning `{value, done}`. This covers hand-written iterator objects and
classes with a `next()` method. We do NOT implement the full Symbol.iterator
well-known-symbol machinery (computed `[Symbol.iterator]` methods); instead we
recognize objects whose static type has a `next` member and drive them directly.

The common real patterns covered:
- a class instance with `next(): {value,done}` used in for-of
- an object literal { next() {...} }
- our own Generator/AsyncGenerator (already handled by the builtin path; the
  iterator path is the fallback for everything else with a next()).

## Detection (exporter)
isIteratorType(expr): the static type has a callable property `next`. Implemented
via the checker: getTypeAtLocation -> getProperty("next") exists and is callable.
isAsyncIteratorType(expr): the `next` returns a Promise (async iterator).

Dispatch order in for-of / yield*:
  1. our Generator/AsyncGenerator (builtin ts_gen_next / ts_asyncgen_next) — fast.
  2. array (index loop) — fast.
  3. otherwise, if isIteratorType -> generic iterator protocol (dynamic .next()).
  4. else reject (no known iteration strategy).

## Lowering: drive via a DYNAMIC .next() method call
for (const x of itObj) BODY ->
  const it = itObj;
  let r = it.next();            // DYNAMIC method call (prototype-chain dispatch)
  while (!r.done) { x = r.value; BODY; r = it.next(); }
The `.next()` here is lowered as an ordinary method Call with a Method callee
(sentinel recvClass -> Dynamic dispatch), NOT the generator builtin. r.value /
r.done are LoadField reads (the result object's `value`/`done` fields).

for await (const x of itObj) BODY ->   (async iterator)
  const it = itObj;
  let r = await it.next();
  while (!r.done) { x = r.value; BODY; r = await it.next(); }

yield* itObj (in a generator) ->
  drive it.next() dynamically, yielding each value, forwarding sent values; the
  yield* value is the final r.value. (Same loop as generator yield*, but .next()
  is a dynamic method call instead of the builtin.)

## Field names
value / done are interned the same way as for generators (F_value/F_done). The
result object from a user .next() must store its props in the prop map; since we
read value/done via LoadField (field-id), and user iterators build {value,done}
object literals, those go through the prop-map path -> compatible.

## Limitations (rejected loudly)
- computed [Symbol.iterator]() returning a separate iterator object is not
  auto-called; the object itself must be the iterator (have `next`). This matches
  the very common "iterator is the iterable" pattern (next + [Symbol.iterator](){return this}).
- iterator close (.return()) on early break is not invoked (rare; most iterators
  don't rely on it).
