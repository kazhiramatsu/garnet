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
   `this` and its fields are what its accesses assume, in open programs too:
   - the flag's test of a struct access (a method's `this`, a class-typed
     parameter) checks the analysis class's interval (`cls`), not only the
     sized layout, once the flag is up: a sized instance of another class
     fails it;
   - new raise points: a relink of any object (a sized one too) behind a
     class with struct fields; `call` / `apply` / `bind` of a struct method
     with a `this` that is not an instance of the method's class; `delete`
     of a struct field (the instance becomes a plain object behind its
     prototype: the struct area turned into in-object slots, the remaining
     fields and its own properties re-added in order); a method value that
     leaves a call position (`x.m` not called, a method read through `any`
     or a computed key: the emitter marks each such site);
   - a relinked sized instance's layout from its allocation class, not from
     its prototype (the generic paths read a relinked instance at the new
     prototype's class offsets today);
   - the closed-receivers pass treats the new points like the old ones: a
     method value leaving a call position (except as an iteration method's
     callback or a `bind` with a `this` of the method's class) and `delete`
     on a value that can be a class instance open the program.
   As built: `ts_typed_outside(x, lo, span)` is the flag's test of a
   struct access through a class with an interval (the analysis class's),
   and a Range guard drops the flag's term (an index in the interval is a
   sized, unrelinked instance); a relink marks the instance's word
   (`TS_CLS_RELINKED`) instead of clearing it, so the generic paths find its
   layout from its allocation class (`layout_proto_of`) and `instanceof`
   walks its chain; a struct method's prototype is kept with its code, and a
   borrow raises unless `this` is a sized, unrelinked instance whose chain
   holds it; `delete` of a struct field converts the instance
   (`obj_abandon_layout`: its fields and own properties into a property
   dictionary, the struct area into in-object slots, a TypeError for a
   frozen or sealed instance in strict code as V8 throws); a method read as a
   value is noted in line (`class.methodEscape`, a load and a branch once the
   flag is up), as is a computed key or a method name read on a value that
   may be a class instance, a method taken by a pattern and a descriptor read
   off one. The structural reads' slow path is `ts_get_checked`, so a method
   called bare throws V8's TypeError reading its `this`.
   The flag has two bits: ANY (a Proxy, a relink, a converted instance:
   typed accesses test their receivers) and THIS (a method read as a value,
   a borrow: a foreign `this` may arrive). THIS alone costs the typed
   accesses nothing; a struct method's entry tests its `this` against its
   class interval while THIS alone is up, and raises ANY when a foreign one
   arrives, so the accesses it reaches (its own and those `this` is passed
   on to) test from then on. The first version raised one flag for both:
   the TypeScript compiler (open) reads a method as a value early and every
   typed access took the interval test, 1.5% slower; with the bits, THIS
   rises, ANY never, and the A/B is neutral (wall 1.0011, 0.45% more
   instructions: 32 method entries and the notes). The closed pass
   opens a program on each such site and on a `delete` or
   `Reflect.deleteProperty` on a value whose type has no index signature;
   tsc-ts has none of them (still closed); the TypeScript 6.0.3 compiler has
   33 (it was open already). Fixtures `classes/grafted_methods` and
   `classes/deleted_fields`; 43 verdict tests.
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

## Slice 3 (Session 353): borrows wait for the method-value pass; library relinks

- A `call`, `apply` or `bind` of a function value that is not syntactically a
  plain function (a parameter, a property of a record, a field) opened the
  program on sight. A struct method can only reach such a site as a value,
  and pass 5 already finds every way a method becomes a value (read, passed,
  taken by a pattern, a computed key on an instance), so those borrow sites
  are now deferred (`deferredBorrows`) and open the program only when pass 5
  found a method value anywhere (`... (the program reads methods as values)`
  in the reasons). Pass 5 gained the descriptor routes: `Object.
  getOwnPropertyDescriptor(s)`, `Reflect.getOwnPropertyDescriptor` and
  `Reflect.get` on a value that may be an instance hand out a method or an
  accessor as a value. `Reflect.apply` still opens on sight.
- The Node library's own prototype work goes through host primitives that
  refuse a class layout instead of `Object.create`/`setPrototypeOf`:
  `__garnet_node.createObject(proto)` (Buffer's prototype over
  Uint8Array's) and `relink(obj, proto)` (Buffer adoption, `util.inherits`)
  throw a TypeError when the chain reaches a registered class with fields or
  the object is a class instance or prototype, so the typed-slow flag can
  never be raised through them and the proof has no site to count.
- Measured: tsc-ts compiled against lib/node (fs, path, os, perf_hooks,
  child_process; the worker_threads and scriptc shims remain) is closed; the
  first attempt was open at 32 sites (events' `listener.apply`, stream's
  `callback.call`, util's `fn.call`, Buffer's relinks, and `chunk.length`
  read off `any` where some class has a `length` method), each now gone
  from the library or deferred. Verdict tests: 52.
- The runtime's borrow check compared the `this`'s chain with the method's
  home prototype only. A class declared in a function gets a fresh prototype
  per evaluation (`ts_clone_class_proto`, registered with the class's own
  field table), so `l.m.call(l)` on such a class raised the flag in a closed
  program; the on-sight rule had opened every program with a borrow of a
  non-plain function, which hid it until this slice (`classes/
  static_members`: a static method bound with `null` and a local class's
  method bound to its instance). The check now also accepts a chain link
  registered with the home's field table (`proto_chain_has_class_of`, after
  the chain test fails, so the common path is unchanged). Fixture
  `classes/local_class_borrow`.
