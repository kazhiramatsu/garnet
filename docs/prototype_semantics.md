# Prototype semantics & the static-optimization contract

This is the most important document in tsaot. JavaScript/TypeScript objects are
**prototype-based and mutable at runtime**; faithfully emulating that on every
access is what makes ordinary JS engines slow. tsaot's central innovation is to
**resolve prototype semantics statically** — at AOT time — whenever a class is
provably *closed and stable*, and to fall back to a real prototype-chain runtime
only when it cannot prove that. This document specifies, precisely, **when the
fast path applies**, so you can write code that stays on it.

Treat the rules below as a contract: code that respects them compiles to
direct-call, fixed-layout native code (the path that beats V8); code that breaks
them is still correct but is compiled through the dynamic prototype-chain
fallback.

---

## 1. The two paths

### Fast path — "specialized" (prototype semantics resolved statically)
For a class the compiler can prove closed and stable, prototype semantics are
**compiled away**:
- **Fields** — laid out at fixed struct offsets (C++-style single-inheritance
  prefix layout). `obj.x` becomes `struct->fN`, a constant offset. No
  prototype-chain walk.
- **Methods** — resolved by devirtualization:
  - **Direct call** when exactly one implementation is reachable (the
    monomorphic case): an inlinable `FN_TABLE[k](...)`. Eligible for inlining and
    SROA (the object can vanish entirely).
  - **Virtual (vtable) call** when several implementations are reachable: a
    single indirect `obj->vt[slot](...)`, O(1) regardless of subclass count.
- There is **no `proto` traversal and no property hashing** on this path.

### Dynamic path — faithful prototype semantics
When the compiler cannot prove the above, it emits the real JS model:
- objects carry a `proto` pointer and an open-addressed property map;
- **property** access `obj.x` / `obj.x = v` on an `any`/unstable receiver is
  `ts_get` / `ts_set`, which **walks the prototype chain**
  (`while (o) { lookup; o = o->proto; }`) exactly like a JS engine;
- this is correct for arbitrary prototype mutation, dynamic property addition,
  and `any`-typed property access — it is just slower.

> **IMPLEMENTATION STATUS — dynamic method dispatch is fully implemented.** A
> method call on a receiver demoted to dynamic (via `any`, or an unstable class)
> resolves through the runtime prototype chain: methods are first-class callable
> values (`ts_func` wrapping a function pointer) registered on a per-class
> prototype object; `obj.m()` does `ts_get(recv, methodKey)` then `ts_call`. This
> handles `any`-typed receivers, inherited methods (chain walk), AND runtime
> method reassignment to an arbitrary closure: `C.prototype.m = function(){…}`
> lowers to `StoreProtoMethod`, which `ts_set`s a new `ts_func` value into the
> same method-key slot, so the dynamic dispatch picks up the replacement. The
> earlier gap (closure reassignment) is closed.

The runtime DOES implement prototypes (`ts_object.proto`, chain-walking
`ts_get`/`ts_set` for properties). The fast path simply doesn't *use* them,
because it has already proven the answer at compile time. The remaining work is
to make a *Dynamic method call* install class methods on the prototype and
dispatch through `ts_get` + closure call.

---

## 2. The contract: when the fast path applies

A method/field access on receiver `r: C` takes the **fast path** if and only if
ALL of the following hold. (Implemented in `class_extract.ts` for stability and
`devirt.rs` for the dispatch decision.)

### A. The receiver is trusted as its static type (`recvStable`)
The receiver value must reach the access site **as its declared class type**, not
laundered through dynamism. `recvStable=false` (→ dynamic) when the receiver
flows through:
- `any` (e.g. `(obj as any).m()`, or a value typed `any` then narrowed by use),
- a type assertion / cast that the compiler can't back with a stable class,
- an index/`unknown` source.

**Write code that keeps the receiver's class type visible.** Annotate, avoid
`any`, avoid casts on values you then call methods on.

### B. The class is stable (no runtime shape mutation observed)
A class is `stable` only if **nothing anywhere in the program** does any of the
following to it (each flips it to dynamic, with a recorded reason):
- **Prototype mutation**: `C.prototype.m = …`, `C.prototype = …`.
- **Prototype/shape via Object.\***: `Object.setPrototypeOf(...)`,
  `Object.defineProperty/defineProperties(...)` targeting the class, its
  prototype, or its instances.
- **Method reassignment**: assigning to a method property of an instance
  (`d.sound = () => …`).
- **Dynamic property add**: writing a property the class didn't declare
  (`obj.newProp = 5`), including element writes `obj["k"] = …`.
- **delete**: `delete obj.x` (or `delete (obj as any).x`).
- **Computed/exotic shape**: computed method or field names, a mixin or computed
  base class (`class C extends mixin(Base)`), where the static layout is unknown.

If any of these is seen *for that class anywhere*, every access to it (and to its
subtree) goes dynamic. Stability is a whole-program property of the class, not of
the individual site.

### C. The closed-world subtree is clean (`devirtualize`)
Given A and B for the receiver class, the analyzer looks at the reachable
subclass set (optionally narrowed by RTA to only-instantiated classes):
- if **any class in that subtree is unstable**, the call goes dynamic;
- otherwise it counts concrete implementations of the method:
  - 0 → dynamic, 1 → **Direct**, ≥2 → **Virtual{slot}**.

### Summary table
| condition | fast path | broken by |
|---|---|---|
| receiver keeps its class type | required | `any`, casts |
| class shape never mutated | required | `prototype`/`setPrototypeOf`/`defineProperty`, method reassign, dynamic prop add, `delete`, computed names, mixins |
| subtree all stable | required | any unstable subclass |
| #impls in subtree | 1 → Direct, ≥2 → Virtual | 0 → dynamic |

---

## 3. How to write fast code (the practical guide)

**Do** (stays specialized — direct calls, fixed layout, SROA-eligible):
```ts
class Vec {
  x: number; y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  dot(): number { return this.x * this.x + this.y * this.y; }
}
const v = new Vec(3, 4);
v.dot();                  // Direct call; v can be scalar-replaced away
```
- Declare all fields on the class (or via constructor `this.x = …`).
- Give methods on the class body; don't reassign them at runtime.
- Keep receivers typed as the class; avoid `any` and casts before method calls.
- A closed hierarchy with one implementation → Direct; with overrides → one
  vtable indirection. Both are fast.

**Avoid** (forces the dynamic prototype-chain fallback for that class):
```ts
const d: any = new Dog();      // (A) receiver laundered through any
d.bark();                       // -> dynamic

Dog.prototype.bark = () => 1;   // (B) prototype mutation -> Dog goes dynamic
Object.setPrototypeOf(d, X);    // (B) -> dynamic
(d as any).extra = 5;           // (B) dynamic property add -> dynamic
delete (d as any).name;         // (B) delete -> dynamic
class M extends mix(Base) {}    // (B) computed base -> unknown layout -> dynamic
```

If you need genuinely dynamic objects (plug-in shapes, monkey-patching), that is
fine — it just won't be on the fast path. The compiler chooses per class/site;
you don't lose correctness, only speed, and only for the dynamic parts.

---

## 4. Why this is sound

Prototype-based dispatch has a fixed result *as long as the prototype graph and
property shapes don't change*. The stability analysis is the proof obligation:
it is **conservative** — a class is stable only if the whole program is free of
every mutation form above, and the *first* sign of mutation (anywhere) demotes
the class. So whenever tsaot takes the fast path, the statically chosen target is
exactly what a prototype-chain walk would have found. When it can't prove that,
it walks the chain for real. There is no configuration in which the fast path
returns a different answer than the dynamic path would.

This mirrors how Java/Rust AOT and tracing JITs treat dispatch (monomorphic/final
→ direct; polymorphic-but-closed → vtable; truly open → lookup/inline-cache), but
tsaot resolves it **ahead of time** and, for non-escaping monomorphic objects,
removes the object and the dispatch entirely (SROA). That erasure — turning
"prototype object with a method" into "a few scalars and straight-line
arithmetic" — is the core innovation and the reason the object kernel beats V8.

---

## 5. Diagnostics (planned)
The stability analysis already records a `reasons` list per class (e.g.
`prototype-mutation`, `dynamic-prop-write:foo`, `method-reassign:bar`). A future
`--explain-dispatch` mode should surface, per call site, whether it is Direct /
Virtual / Dynamic and — when Dynamic — which rule (A/B/C) and which reason
demoted it, so a developer can see exactly why a hot path fell off the fast path
and what to change. This turns the contract above into actionable feedback.

## Relationship to other docs
- `classes_design.md` — the layout/vtable/devirt mechanics this contract rests on.
- `codegen_design.md`, `emit_c_specialized_design.md` — how the fast path is emitted.
- `bench_results.md` — the object kernel (NoEscape, stable, monomorphic) beating
  V8 1.29x via this path + SROA.
- `generics_design.md` — monomorphization extends the same "resolve statically,
  fall back to erased/dynamic otherwise" philosophy to type parameters.


## Inheritance is a real prototype chain (dynamic path)
On the dynamic path, class inheritance is implemented exactly as JS does it: each
class prototype object is linked to its parent's prototype
(`Sub.prototype.__proto__ = Base.prototype`), and method lookup walks that chain
via `ts_get`. Inherited methods are NOT flattened/copied into the subclass
prototype. Consequently, runtime mutation of a parent prototype
(`Base.prototype.m = ...`) propagates to existing subclass instances, matching V8
(verified: `inherited_proto_rewrite` returns 99; `inherit_chain3` resolves a, b, c
across a three-level chain). The fast (specialized) path still resolves inherited
methods statically via the closed, stable hierarchy as described above; the chain
is the faithful fallback when a class is dynamic.


## Object.getPrototypeOf / setPrototypeOf
Both builtins are implemented faithfully on the dynamic path:
- `Object.getPrototypeOf(obj)` lowers to `ts_get_proto`, returning the object's
  actual `proto` pointer (or null). Identity is observable: before/after a
  `setPrototypeOf` the returned prototypes differ, matching V8.
- `Object.setPrototypeOf(obj, C.prototype)` lowers to `ts_set_proto`, which
  relinks `obj->proto`. A `C.prototype` argument resolves to the compiler-managed
  class prototype object (`LoadClassProto`). Subsequent dynamic method/field
  lookups walk the NEW chain via `ts_get`, so e.g. after re-pointing an `A`
  instance at `B.prototype`, `a.m()` dispatches to `B`'s method (verified vs V8).

Stability interaction (fast path): `Object.setPrototypeOf` / `defineProperty`
targeting a class, its prototype, or its instances marks that class UNSTABLE
(reason `Object.setPrototypeOf` / `-on-prototype`), so all access to it is forced
onto the dynamic chain-walking path where the relink is honored. The fast
(specialized) path is therefore never used for a class whose prototype identity
can change at runtime — this is what keeps static devirtualization sound in the
presence of these reflective operations. `getPrototypeOf` is a pure observation
and does not affect stability. Tests: `proto_get_set` (identity change + dynamic
dispatch after relink).

## Lazy function `.prototype` objects

Every function declaration and function expression owns a `.prototype`
property (`FN_HAS_PROTOTYPE`), and nested declarations create a new closure on
each call of their enclosing function. The TypeScript checker allocates about
31M such closures while compiling its own sources, and almost none of them is
ever used as a constructor. Since Session 350 the emitter spells the property as
`ts_set_fn_prototype_lazy(fn)`: the function is marked constructable, but the
prototype object and its non-enumerable `constructor` are created on the first
observation. Observation points are a read of `fn.prototype` (including
`instanceof` on a plain function and `getOwnPropertyDescriptor`), `new fn()`,
and nothing else, because the object is reachable only through the function.
Assigning `fn.prototype = x` before any observation simply drops the pending
object. The legacy eager form `ts_set_fn_prototype(fn, ts_new_proto())` is
still supported (`TSAOT_LAZY_PROTO=0`, used by the frozen parity oracle) and
now also defers only the `constructor` definition. `functions/
lazy_prototype_constructor.ts` covers both spellings' observable behavior.
