# generators (function* / yield) — design

## Reuse the async coroutine basis
Generators use the SAME stackless state-machine + coroutine frame as async/await.
The state-machine transform (split body at suspension points, spill live locals
into the frame, switch(state) resume fn) is identical. Differences:

| aspect          | async                          | generator                          |
|-----------------|--------------------------------|------------------------------------|
| suspension      | `await e` (wait on a Promise)  | `yield e` (hand value to caller)   |
| on suspend      | park frame, return to scheduler| return the yielded value to .next()|
| resume driver   | microtask queue                | explicit `.next(v)` call           |
| call result     | Promise                        | a generator/iterator object        |

## Generator object
Calling a `function*` does NOT run the body; it allocates the coroutine frame and
returns a **generator object** (a plain ts object, GC-tracked) carrying the frame
pointer. The object exposes `.next(v)` (and is iterable for for-of).

Representation: the frame is the existing `ts_coro`-prefixed `<fn>_frame`. A
generator object is an OBJECT with a hidden field `__coro` holding the frame as a
boxed pointer, plus a `__done` flag. `.next()` is handled specially by the
compiler (a CallBuiltin `generator.next`) -> ts_gen_next(genobj, sentValue).

## Resume function (state machine)
Same shape as async, but:
- `yield e` :  save state=N, store the yielded value into the frame's `yielded`
  slot, return a marker; the public driver reads `yielded` and wraps it as
  `{value, done:false}`. On resume, `yield`'s own value (the arg passed to the
  NEXT `.next(v)`) is read from the frame `sent` slot.
- function end / explicit `return e` : set `done=1`, value = e (or undefined).

Encoding without changing the resume signature `tsv resume(ts_coro*)`:
- The frame gets two extra fields used by the runtime/driver: we reuse
  `ts_coro.result` as the "sent value" handed in on resume, and add `yielded`
  (the value produced by a yield) + `done` to the coro struct.
- `resume()` returns nothing meaningful; the driver inspects `c->done` and
  `c->yielded` after each call. (We set `c->yielded` before returning at a yield;
  we set `c->done=1` at completion.)

## Runtime additions
- `ts_coro` gains: `tsv yielded; int done;`.
- `ts_gen_new(frame)` -> generator object with `__coro` + makes it iterable.
- `ts_gen_next(genobj, sent)` -> result object `{value, done}`:
    fetch frame, set c->result = sent, if c->done return {undefined, true},
    else call c->resume(c); return { c->yielded (or final value), c->done }.
- Result object: `{value, done}` plain object (interned fields "value","done").

## IR additions
- `Yield { dst, operand }` : at a yield point. dst receives the value passed to
  the next `.next(v)` (often unused). operand is the yielded value.
- Function flag `is_generator`.
- `CallBuiltin "generator.next"` for `gen.next(v)`.

## for-of over a generator
`for (const x of gen) BODY` lowers to:
  while (true) { r = gen.next(undefined); if (r.done) break; x = r.value; BODY }
Detected when the for-of iterable's static type is a Generator/Iterable that is
NOT an array/string/map/set. v1: support for-of over a value typed as a
generator (Generator/IterableIterator). Arrays keep the existing index loop.

## v1 scope (mirrors async v1)
- Top-level yields only (yield as a statement `yield e;` or `const x = yield e;`).
- yield inside if/loop rejected loudly (needs general state-machine builder;
  same limitation as nested await). NOTE: this is restrictive for generators
  (loops with yield are common) -> see "loop yields" below; we DO want at least
  yield-in-loop, handled by lowering the loop into the state machine. v1 keeps it
  rejected and we extend next.
- `yield*` (delegation) rejected.
- Generators driven by explicit `.next()` and by for-of.
