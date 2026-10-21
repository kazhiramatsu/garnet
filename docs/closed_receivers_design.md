# Closed receivers: a whole-program proof that no foreign receiver arises

Session 351. Exporter (`class_extract.ts`), emitter (`emit_c.rs`), runtime
(`ts_rt.c`). Follows `docs/foreign_receivers_design.md` (the flag) and
`docs/receiver_class_hints_design.md` (the guards).

## Why

A typed class-field access is a struct offset behind a guard. What each
part of the guard costs, measured on tsc-ts emitting the TypeScript 6.0.3
compiler project (six interleaved rounds, output identical in every
variant; the variants drop guard parts without proof, for measurement):

| variant | instructions | cycles |
|---|---|---|
| guards as emitted | 52.6 G | 1 |
| no guards at all | 45.8 G | 0.823 |
| no `g_typed_slow && ts_typed_slow(x)` term | 47.3 G | 0.843 |
| no object test (`!ts_is_obj(x)`) | 52.0 G | 0.992 |
| no class interval test | 52.3 G | 0.985 |

The flag term is on about 59,000 accesses: every `this.f`, every access
through a class-typed parameter, every store. While `g_typed_slow` is 0
it is a load and a branch, but its slow path (`ts_get` / `ts_set`, which
can run any code) is a call the C compiler must assume writes the frame
slots and the globals, at every access. tsc-ts never raises the flag
(checked at exit, emitting and checking only).

## The fact

The runtime raises `g_typed_slow` at five points:

1. `ts_new_proxy`: any Proxy.
2. `ts_set_proto_user` (`Object.setPrototypeOf`, `Reflect.setPrototypeOf`,
   as calls or as values): the new chain has a registered class with
   struct fields and the object lacks the layout.
3. `ts_object_create`: likewise.
4. `invoke_with_this` (`Function.prototype.call` / `apply`, bound
   functions, `Reflect.apply`): a struct method with a `this` that lacks
   the layout.
5. `ts_funcproto_bind`: likewise.

A program that can reach none of them never raises the flag, so the flag
term of every typed access is false for the whole run and can be dropped
without changing any behavior. The exporter proves it (the program has
*closed receivers*) by finding none of these in the program's source, every
module and the host shims included:

- a reference to `Proxy`;
- `Object.setPrototypeOf`, `Reflect.setPrototypeOf`, `Object.create`
  (except a call whose prototype argument is the literal `null`);
  `__proto__` as a property name, an element key or a literal key;
- `call`, `apply` and `bind` of `Function.prototype` (the members the
  lib declares on `Function`, `CallableFunction`, `NewableFunction`),
  `Reflect.apply`, `Reflect.construct`, except on a function that cannot
  be a method: a function or arrow expression, a function declaration, a
  `const` initialized with one;
- a dynamic route to any of them: a property of an `any` or `unknown`
  value named like one of them (`(f as any).call(t)`), an element access
  with a computed key on an `any` or `unknown` value, on a function or on
  one of the namespaces that hold them (`Object`, `Reflect`, `Function`,
  `globalThis`), and the `Function` constructor.

Symbols are resolved by the checker (shadowing respected, import aliases
unwrapped), as builtin detection does everywhere else.

## Emission and runtime

- `program.json`: `closedReceivers: { closed, reasons }`, the reasons naming
  each site that opens the program (`TSAOT_CLOSED_LOG=1` prints them).
- `emit_c.rs`: in a closed program the flag term is `0`, so the C compiler
  folds it away: a field the receiver's analysis class declares is a plain
  load or store, a root field keeps the object test, an interval field the
  object and interval tests. `TSAOT_CLOSED_RECEIVERS=0` keeps the term (A/B;
  the parity oracle).
- `ts_rt.c`: the program's setup sets `g_closed_receivers`; in a closed
  program each raise point stops the program with a message naming the
  operation. The analysis missed a route there: a loud internal error, never
  a silent wrong value.

## Measured

- tsc-ts: closed (the first draft's two sites were a record's `call: Node`
  field, which no function can satisfy; a user member named like a builtin
  opens the program only when its type is callable). Emitting the
  TypeScript 6.0.3 compiler project, eight interleaved rounds, output
  identical: 2.895 s -> 2.448 s (x0.845), 52.6 G -> 47.3 G instructions,
  faster in 8 of 8.
- The TypeScript 6.0.3 compiler itself stays open (80 sites: `call` of its
  own helpers, `Object.setPrototypeOf` in its object allocators, computed
  keys on `any`): its accesses keep the test, its C is unchanged.
- `tests/closed_receivers.sh` (in `gate.sh unit`): 31 small programs, each
  rule and each exception (a method bound to its own instance, a library
  function's `call` / `apply`, a sized instance as `this`, a `null`
  prototype, a record field named `call`).

## Known gaps this slice leaves as they are

Found while measuring; both are silent wrong values in open and closed
programs alike, independent of the flag:

- A method grafted onto an object of another class, `d.m =
  C.prototype.m; d.m()`: no raise point sees it, and the flag's layout test
  is size-based, so a sized `d` of another class would pass it anyway. The
  typed `this` read takes C's offsets in a D (V8 `undefined`, garnet `NaN`).
- `delete` of a class field does nothing (V8 removes the property: `in`,
  `Object.keys` and `JSON.stringify` stop listing it).

And one loud gap: `{ __proto__: P }` in a literal makes an own property
(`KNOWN_GAPS.md`), so `P`'s methods are not found (TypeError).

## Next slices

1. This one: the flag term.
2. Grafted methods and deleted fields (the gaps above), so that a class's
   `this` and its fields are what its accesses assume: a method value that
   leaves a call position (`x.m` not called, `C.prototype.m`, a method
   read through `any` or a computed key) and `delete` on a value that can
   be a class instance are the whole-program sites to find; a class whose
   methods never leave call positions needs nothing at run time.
3. Object tests that do not merge back: in a closed program a non-object
   in a stable class's position can only be `null` or `undefined` (any
   other value needs an `any` flow or a cast, which the structural pass
   already seeds), so the object test can throw V8's TypeError from a
   function that does not return, instead of taking the generic path.
4. Trusted receivers: a receiver whose class is proven, not asserted (no
   downcast, no array or container covariance into its position, no
   method parameter made narrower by an override), needs no interval test.
5. Reusing a guard: the layout of an object is fixed at its allocation, so
   a guard proven for a local holds until the local is assigned again.
