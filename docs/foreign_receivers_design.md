# Foreign receivers of typed class-field accesses

Session 350, build `x55`. Emitter (`emit_c.rs`, the three struct-access
guards), runtime (`ts_rt.h`, `ts_rt.c`). Closes the open hazard noted in
`ts_object_create` and in `docs/TODO.md` (6b).

## Finding

A typed read or write of a declared class field is a struct offset:
`((Class0*)ts_ptr(this))->f3`. It assumes the receiver is a sized instance
of the class (allocated by `new`, `ts_new_sized` or a stack struct). The
only receivers that break the assumption on purpose were Proxies, and the
access is emitted as `(g_has_proxies && ts_is_proxy(x)) ? ts_get(...) :
struct`. Plain objects reach the same accesses through ordinary JavaScript:

- `Object.create(C.prototype)` then `p.x = 5; p.sum()`: the stores go to
  the property map, `sum` reads the struct offsets of a bare object (0 or
  whatever follows the cell; V8 `11`).
- `Object.setPrototypeOf({ y: 9, x: 8 }, C.prototype).getX()`: the struct
  offset reads the literal's first in-object slot (`9`; V8 `8`); the same
  literal with the keys in declaration order happened to work.
- Borrowing: `C.prototype.getX.call({ y: 60, x: 50 })` reads `60`;
  `C.prototype.setX.call({}, 42)` writes past the end of an empty object's
  cell (heap corruption) and the property never appears.

The dynamic paths (`ts_get`, `ts_set`, keys, `in`, JSON) already treat such
objects correctly: a class descriptor applies only to cells large enough
to hold it (`gc/unsized_with_class_proto` reads them through `any`).

## Change

- **The guard.** The three emitted guards test `(g_typed_slow &&
  ts_typed_slow(x))`: `g_typed_slow` is a new one-way flag, `ts_typed_slow`
  is true for a non-object, a Proxy and an object without the
  sized-instance layout (`ts_obj_is_sized` false: the cell is exactly the
  bare object header plus its in-object slots, the test the dynamic paths
  already use). Such a receiver takes `ts_get` / `ts_set`, which handle
  all of them. The parity oracle keeps the old text
  (`TSAOT_TYPED_SLOW=0`).
- **The flag** is raised where a foreign receiver can come into being, so a
  program that never does any of this keeps one predictable branch:
  creating a Proxy (with `g_has_proxies`); a user-level prototype change
  (`ts_set_proto_user`: `Object.setPrototypeOf` as a call or as a value,
  `Reflect.setPrototypeOf`) or `Object.create` that puts a registered class
  prototype with struct fields (own or inherited) behind an object without
  the layout; and `call` / `apply` / `bind` / `Reflect.apply` of a method
  of such a class (the code pointers of the functions on a registered
  class prototype, collected when the class is registered) with a `this`
  that lacks the layout. The class setup keeps `ts_set_proto`: the static
  setup runs before the classes are registered, but a class extending a
  value is linked at run time by a `SetProto` without a result (the
  program's `setPrototypeOf` has one). The first build checked inside
  `ts_set_proto` and the compiler's own module init raised the flag that
  way: every typed field access of the compiler took the layout test, 5%
  slower.

## Not covered (known gaps)

- A method grafted onto a plain object (`o.m = C.prototype.m; o.m()`) and
  called through the dynamic method path: no hook sees the receiver; it
  would need a check at every method entry.
- A borrowed method called on a sized instance of an unrelated class (the
  layout test is size-based, not class-based).
- A plain object cast to a class type (`({} as any) as C`) is a type lie
  (V8 would not find the method either); typed mode trusts it.
- `o.__proto__ = P` is not modeled at all (an own property named
  `__proto__`; `KNOWN_GAPS.md`).

## Gates

Fixture `classes/foreign_receivers` (the cases above through typed and
`any` access, sized instances unaffected, a Proxy receiver), the existing
`unsized_with_class_proto` and `proxy` fixtures; conformance, parity
(old text under the knob), unit, GC stress, bundler; A/B of the compiler
(the flag stays down there: no relinking of class prototypes).
