# Generator and async function objects

Session 363. Runtime (`ts_rt.c`), emitter (`emit_c.rs`).

## What the specification has

Every generator function has an own `prototype`, an ordinary object without `constructor` that inherits from
`%GeneratorPrototype%`, and a generator takes its prototype from the function's `prototype` when it is made
(`%GeneratorPrototype%` if that is no object). A generator function inherits from `%GeneratorFunction.prototype%`,
not from `Function.prototype`; async functions and async generators have their own objects too.

garnet linked every generator to `%GeneratorPrototype%`, and every function to `Function.prototype`. So
`g() instanceof g` threw, `g.prototype` was undefined, `Object.getPrototypeOf(g)` was `Function.prototype`.

## One prototype per code

A generator's entry is called directly with no function value at hand, so it cannot read `prototype` off the
function. The prototype lives in a slot per function code, `gen_slot_of(fnid)`: made on the first call or the first
boxing, whichever comes first, old from the start.

- The entry links the generator to the slot's object (`ts_gen_new_fn`, `ts_asyncgen_new_fn`): one test more than
  before on an operation that allocates a frame and an object.
- Boxing a function as a value (`FN_KIND`, folded by the C compiler for every other function) sets its prototype,
  and for a generator function its `prototype_prop` to the slot's object (`ts_set_fn_kind`).
- A store to `g.prototype` updates the slot: the store path pays one bit test on a function's `prototype` key.

## Gaps

- Two evaluations of one `function*` share one `prototype` object (V8: one each), and a store through either
  changes both.
- `%GeneratorPrototype%` inherits from `Object.prototype`: there is no `%IteratorPrototype%` yet.
- The constructors reachable through `.constructor` build code from strings: they throw an EvalError.
