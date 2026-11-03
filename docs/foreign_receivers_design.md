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

## Structural values (session 350, `exporter/class_extract.ts` pass 3)

The receivers above are foreign at run time. TypeScript makes another kind
legal statically: classes are typed structurally, so an object literal, an
instance of an unrelated class or an interface-typed value is assignable to
a class type without private members, and `any`, `unknown` and casts admit
anything. Such a value read through the class type took a struct offset (a
literal with its keys in another order gave another field's value) or the
class's method in place of its own (silent wrong values; fixture
`classes/structural_class_values`, wrong on fourteen of its fifteen lines
before).

The class extractor now finds where a value can acquire a class type and
marks the class unstable (the existing fallback: its receivers take the
dynamic paths):

- every contextually typed expression (an initializer, an assignment, an
  argument, a return, a property or element of a literal, a default): its
  own type against the contextual type, matched by position (union members
  one by one, a class target against the source as a whole, object targets
  property by property, type arguments argument by argument); `any` or
  `unknown`, a non-class type assignable to the class, or an unrelated class
  assignable to it seeds the class. A literal itself is checked against the
  classes at the top of its contextual type only (its elements are checked
  one by one); an empty library container (`new Map()`, whose zero-argument
  signature says `Map<any, any>`) holds nothing yet; the operands of `??`,
  `||`, `&&`, `,` and the branches of `?:` are checked themselves.
- casts and type guards narrow: any non-class source seeds the target, a
  union narrowed to a member related to the target excludes the other
  members, and a double cast through `unknown` or `any` reads what it
  reinterprets (`this as unknown as IndexType` is a downcast).
- type arguments (inferred or explicit, of calls, `new` and heritage
  clauses) against their parameters' constraints, so a value typed as a
  type parameter constrained by a class is an instance of it.
- flows between classes of one hierarchy (an upcast or a downcast) carry a
  marked class's values along, and a marked class marks its ancestors (an
  inherited method reads its `this` as the ancestor).

Downcasts between classes stay trusted, as before. `TSAOT_STRUCTURAL_LOG=1`
prints each marked class, its reason and the flow's site. Marked: tsc-ts six
classes (worker data cast from `any`, two structurally swapped completion
classes), the TypeScript 6.0.3 compiler two (casts from interface types),
the self-hosted analyzer none.

## Direct calls on a borrowed `this` (Session 364, planned)

`D.prototype.d.call({ m() { return 1; } })`, where `d` is `return this.m()`: the call in `d` was resolved from D's
hierarchy (`devirt.rs`, one implementation in the subtree: `Direct`) and inlined, so the borrowed method ran D's `m`
whatever `this` was, a plain object's own `m` and a sibling class's override alike (silent; older than Session 363,
CLAUDE.md's known items). Field accesses are guarded since slice 2 of docs/closed_receivers_design.md; calls are not.

The rules a fix has to keep: a closed program pays nothing (it has no foreign `this`); an open one pays one predictable
branch per call while no foreign `this` has arrived (the ANY bit down), which is every run of vue, hono and hono_app but
for vue's Proxies, whose ANY is up from the start and whose calls would take the interval test, a load and a compare.

Plan:

- `devirt.rs`, in an open program: a call whose receiver is the function's own `this` and whose dispatch is `Direct` becomes
  `t = class.foreignThis:<class>(this); if (t) { the call by name, as Dynamic } else { the direct call }`. The site's
  inlining (`sroa.rs`) still sees the direct call in the else branch. `SiteDispatch` has no consumer past the pass, so
  the shift of the instruction indices is free.
- `class.foreignThis:<c>`: `(g_typed_slow & TS_TYPED_SLOW_ANY) && ts_typed_outside(this, lo, span)`, the test field
  accesses already make, with c's interval, for a class with struct fields. A class without any (D above, and every
  class of the reported case) has plain objects for instances, `cls` 0: the interval would send each of them to the
  dynamic call. Its test is the prototype: `proto == CLASS_PROTO[c]`, else the chain (`ts_instanceof`), a subclass's
  instance being the rare case.
- A method that has such a call gets the entry test of slice 2 even when its class has no struct field (`METHOD_CLASS`
  holds only those today), so the first foreign `this` that enters raises ANY.
- Receivers other than `this` stay trusted, as typed accesses through them are (a value typed as a class that is none is
  a type lie).

To measure: the A/B of hono, hono_app, vue and tsc-ts (closed: identical C expected), the binaries' size (each site gets
a second call), and a kernel of `this.m()` calls in a loop in an open program.
