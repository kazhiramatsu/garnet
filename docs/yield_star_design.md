# yield* delegation (generator + async generator)

## Semantics (ECMAScript)
`yield* inner` drives the inner iterator to completion, forwarding each produced
value to the OUTER generator's caller, and forwarding values sent via .next(v)
back into the inner iterator. The value of the `yield*` expression is the inner
iterator's return value (result.value when done).

Sync spec (simplified, ignoring throw()/return() on the iterator):
```
let it = GetIterator(inner);
let received = undefined;
let r = it.next(received);
while (!r.done) {
  received = yield r.value;     // hand value to outer caller; capture sent value
  r = it.next(received);
}
=> value of (yield* inner) is r.value
```

## Approach: lower in the exporter to existing primitives
We do NOT add new IR or codegen. `yield* inner` is rewritten to the explicit loop
above using primitives already supported by the flat state-machine:
- it = <inner expr>                          (a Generator/AsyncGenerator object)
- loop with a `Yield` (outer suspension) and a `.next()` call on the inner.
- field reads r.value / r.done (LoadField).
- the yield* expression's value (inner return) = r.value at loop exit.

Because the rewrite uses ordinary Yield + Loop + If + LoadField, the existing
state-machine builder handles suspension inside it automatically (the yield is a
normal outer-suspension; nested yield* compose naturally).

### Sync generator lowering (IR)
```
it   = inner
r    = it.next(undefined)             # CallBuiltin generator.next
loop:
  done = r.done ; if !done: 
    sent = yield r.value              # Yield (operand=r.value, dst=sent)
    r    = it.next(sent)
  else break
value_of_yieldstar = r.value
```

### Async generator lowering
The inner is an async iterator: each step is `r = await it.next(sent)`, and we
`yield r.value`. Only difference from sync: an `Await` wraps the inner .next().
We pick sync vs async by whether the ENCLOSING function is an async generator
(ctx.isAsync && ctx.isGenerator) — matching how `for await` is chosen.

### value of the expression
`yield* e` is an expression; its value is the inner's return value. We materialize
it as the loop's final `r.value` and return that local from lowerExpr.

## v1 scope / limitations
- inner must be one of our Generator/AsyncGenerator objects (the .next() protocol).
  Arbitrary iterables (arrays, Symbol.iterator) are NOT delegated yet — rejected.
- iterator .throw()/.return() propagation into the delegate is not modeled (rare).
- Sync `yield*` only valid in a sync generator; async `yield*` in an async gen.
