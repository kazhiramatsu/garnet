# generics — monomorphization design (planned, not yet implemented)

TypeScript generics are currently handled by **type erasure** (like tsc itself):
`Box<T>` lowers to a single class `Box` whose field `value: T` becomes a boxed
`tsv`, and `identity<T>` ignores `T`. This is correct but forces all generic
code onto the slow dynamic/`tsv` fallback path — `Box<number>` cannot use the
int64/double specialization or SROA that make monomorphic OO beat V8.

The plan is **monomorphization** (the Rust / C++-template approach): keep each
generic definition as a template and emit a dedicated specialization per
concrete type-argument tuple, so `Box<number>` becomes a struct with a real
`double value` and flows through the existing specialization + SROA pipeline.

## Goal & non-goal
- **Goal**: a statically-resolvable generic instantiation gets a concrete,
  specialized layout/function so type-specialization, devirtualization, and SROA
  apply to it exactly as they do to ordinary classes/functions.
- **Non-goal**: implementing TypeScript's type-level computation. We do not
  evaluate conditional/mapped/template-literal/recursive types ourselves (see
  "Complex type operations" below) — we delegate that to the TS checker and only
  consume the *resolved* concrete type.

## Core idea: two layers

### Layer 1 — complex type operations are delegated to the TS checker
TypeScript's type system is Turing-complete (conditional types, mapped types,
`infer`, recursive types, template-literal types). The crucial observation:
**type-level computation has no effect on runtime representation.** A value of
type `DeepReadonly<Foo>` and one of type `Foo` have identical memory layout; the
type operators only constrain what the *checker* accepts.

Therefore tsaot never evaluates type operators. Instead, at each use site we ask
the checker (`getTypeAtLocation`, `getTypeArguments`) for the **already-resolved
concrete structural type**, and decide the layout from that alone:

```
DeepReadonly<Foo>      ─[ TS checker evaluates ]→   { x: number, y: string }
Awaited<Promise<number>>                       →     number
Params<(a:number)=>void>                       →     [number]
                                  │
                                  └─[ tsaot reads the resolved type ]→  C layout
```

This is the same division of labor as Rust monomorphization: rustc resolves
trait bounds / associated types; codegen only sees the final concrete type. The
complexity of the type algebra is the compiler-frontend's problem, not the
backend's.

### Layer 2 — monomorphize what is statically resolvable; erase the rest
Some generic uses cannot be enumerated at compile time. We split:

- **Resolvable** (all instantiations visible in the program): monomorphize →
  fast, specialized code.
- **Unresolvable** (open/exported generic API with unknown callers, type-arg
  chosen by a runtime value, or instantiation that would explode): fall back to
  the current **type-erased `tsv`** version — correct, dynamic, slower.

This mirrors Rust precisely: concrete types / `impl Trait` are monomorphized,
`dyn Trait` is the erased fallback. The hybrid is sound: a generic for which we
can't see every instantiation keeps a single erased version that works for all.

## Pipeline

```
exporter
  ├─ (new) instantiation-collection pass
  │     walk the program; at every generic use (new G<Args>(), g<Args>(),
  │     typed bindings) ask the checker for the concrete type-argument tuple.
  │     Record the set of (generic-def, arg-tuple) pairs actually used.
  │
  ├─ (new) monomorphization engine
  │     for each (def, tuple): clone the generic definition, substitute each
  │     type parameter T with its concrete resolved type, and emit a concrete
  │     class/function with a mangled name (Box$number, identity$number).
  │     Field/param/return types are now concrete -> normal lowering.
  │
  └─ rewrite use sites: new Box<number>() -> AllocObject{class=Box$number} +
        Direct ctor call; g<number>(x) -> Direct call to g$number.

analyzer (unchanged)
  the generated concrete classes/functions are ordinary inputs: devirt, escape,
  int/double specialization, typed structs, and SROA all apply with no special
  cases. Box$number's value:double becomes a struct double field; SROA can scalar-
  replace a NoEscape Box$number into raw locals -> the V8-beating path.
```

## Name mangling
`<generic name>$<arg1>[$<arg2>...]`, where each arg is the concrete type's
canonical key (e.g. `number`, `string`, `boolean`, a class id like `C3`, or a
structural hash for object/tuple types). Mangling must be:
- **deterministic** (same tuple -> same name across runs),
- **collision-free** (distinct resolved layouts -> distinct names; equal layouts
  may intentionally share, e.g. `Box<number>` and a `type N = number; Box<N>`).

## Type-argument key (how a resolved type becomes a mangling/layout key)
Driven entirely by the checker's resolved type:
- primitive (`number`/`string`/`boolean`/`null`/`undefined`) -> its name; numeric
  further refined to int64 vs double by the existing int-inference where known.
- class/interface instance -> the class id (or a structural key for anonymous
  object types: a sorted list of (field, fieldType-key)).
- array `T[]` -> `array$<elemKey>` (uses the dense `ts_array`; element layout per
  elemKey).
- tuple `[A,B]` -> `tuple$<aKey>$<bKey>`.
- function type -> erased to a closure (`tsv`) for now; specialization of
  higher-order generics is future work.
- anything the checker leaves as a type parameter / `unknown` / `any` -> NOT
  resolvable at this site -> forces the erased fallback for this instantiation.

## Specialization examples
```
class Box<T> { value: T; constructor(v:T){this.value=v;} get():T{return this.value;} }

new Box<number>(42)   ->   struct Box$number { ts_object header; double value; }
                           Box$number$ctor(this, double v){ this->value = v; }
                           Box$number$get(this) -> double { return this->value; }

function identity<T>(x:T):T { return x; }
identity<number>(100) ->   double identity$number(double x){ return x; }
```
A NoEscape `Box$number` used only as a Direct-call receiver is then SROA'd to a
bare `double` local — identical to the hand-written monomorphic kernel.

## Soundness & safety rules
- **Closed-world requirement**: monomorphize only when every instantiation of a
  generic is visible (not exported as an open API, not reached through `any`).
  Otherwise keep the erased version. Reuse the same closed-world discipline as
  class devirtualization (`stable`/`instantiated` flags).
- **Instantiation-count cap**: bound the number of specializations per generic
  (template-explosion guard, like C++ `-ftemplate-depth`). On overflow, fall back
  to the erased version for the excess — never fail to compile.
- **Recursion guard**: a generic that instantiates itself with a growing type
  (`G<G<T>>...`) must terminate; cap recursive specialization depth and erase
  beyond it.
- **Explicit fallback logging**: when an instantiation can't be monomorphized,
  record it (file:line + reason) the same way unsupported syntax is reported, so
  "this generic stayed dynamic" is visible, never silent.
- **Erased + specialized coexistence**: a generic may have both a specialized
  `Box$number` and an erased `Box` (for unresolvable uses) in the same program;
  the use-site rewrite picks per site.

## Why complex type operations are tractable here
The hard part of "AOT for generics" is usually imagined as "implement the type
algebra in the backend." We sidestep it: the type algebra never reaches the
backend. The checker reduces `DeepReadonly<…>`, `Awaited<…>`, mapped types, etc.
to a concrete structural type *before* tsaot looks; tsaot's only job is
structural-type → C-layout, which it already does for non-generic code. The
residual hard cases are not type-operator complexity but *resolvability*
(unknown callers, runtime-dependent type args, explosion) — and those are
handled uniformly by the erased fallback.

### Verified prerequisite (the checker really does reduce type operations)
Confirmed empirically with the bundled `typescript`:
- `Awaited2<Promise<number>>` (conditional type + `infer`) → the checker's
  `getTypeAtLocation` resolves to `number`.
- `Pick2<Foo, "x"|"y">` (mapped type) → `typeToString` still prints the generic
  alias `Pick2<…>`, BUT `getPropertiesOfType` returns the concrete members
  `{ x: number, y: string }`.

Implication for tsaot: **decide layout from `getPropertiesOfType` /
`getTypeOfSymbol`, not from `typeToString`.** The printed name may stay generic,
but the structural decomposition is always concrete. This is the API contract
the monomorphization engine builds on.

## Implementation status
**Slice 4 (DONE):** generic parent inheritance. `class Sub extends Base<number>`
now specializes the parent: `resolveSpecializedParent` reads the `extends` clause's
type arguments, specializes the base (`Base$number`) via the Slice-3 machinery, and
rewrites `Sub.parentName` to the specialized base so inherited fields carry concrete
`field_types` (e.g. inherited `value` is "number") and `super(...)`/inherited method
dispatch resolve to the cloned base's ctor/methods. Distinct subclasses of the same
generic base at different type args get distinct specialized parents
(`NumCell:Container$number`, `StrCell:Container$string`). Verified vs V8: super()
init, inherited methods, and subclass methods all match; ASan clean. (NOTE: classes
participating in inheritance are not SROA'd by the conservative guard, so the inherited
number field is correctly typed in `field_types` but kept boxed in the struct until a
typed-struct-field codegen pass lands; correctness is complete, unboxed inherited-field
codegen is future work.)

**Slice 3 (DONE):** full generic CLASS cloning. Distinct type-argument tuples
become distinct classes: `new Box<number>()` and `new Box<string>()` get separate
class ids (`Box$number`, `Box$string`) with their own cloned constructor/methods
(lowered under the T->concrete substitution) and their own concrete `field_types`
(so `Box$number.value` is an unboxed double while `Box$string.value` stays tsv).
`new`-site allocation and method dispatch (`classOfExpr`) both route through
`specializedClassId`, which resolves the checker's concrete type arguments,
caches per (class, type-arg tuple), and assigns dense/contiguous class+function
ids. Handles multiple type parameters (`Pair<number,number>` specializes BOTH
fields; `Pair<string,number>` only the second) and nested generics
(`Box<Box<number>>` clones both the outer and inner box). Guards: recursion-depth
limit (`maxSpecDepth`) for nested generics and an instantiation-count cap
(`maxClassSpecs`) to bound code growth; on exceeding either, falls back to the
erased original class (still correct). Verified vs V8: Box$number/Box$string,
Pair multi-param, and Box<Box<number>> all match; ASan clean; generic_kernel still
wins (~205ms vs V8 219ms) through the cloned class + SROA. The earlier Slice-1
uniform-field path is now subsumed by per-instantiation cloning (it still applies
when a class is only ever used at one type).

**Slice 2 (DONE):** generic FUNCTION monomorphization. A call `f<number>(...)`
to a generic function (declared with type parameters) routes to a specialized
clone `f$number` whose body is lowered under a type-parameter substitution
(`T -> number`), so its parameters/locals/return are classified as the concrete
scalar and stay unboxed (e.g. `long long`/`double`) instead of `tsv`.
Specializations are cached per (function, type-arg tuple) so identical
instantiations share one clone; ids are dense/contiguous (the analyzer indexes
functions by id). Non-scalar or inference-only type args fall back to the erased
original (correct). Verified: `identity<number>` lowers to an unboxed clone.
NOTE (RESOLVED): specialization removed boxing; the call itself is now also
inlined by the A1 small-free-function inliner (see below), so a
trivial `pick<number>(x){return x}` in a hot loop still pays a function-call
overhead (a general small-free-function inliner is separate, future work that
would benefit all calls, not just generics). The class-method/ctor inliner in
SROA already inlines method calls on NoEscape receivers.

**Slice 1 (DONE):** monomorphic instantiation specializes numeric fields. The
exporter collects, per `new C<...>()` site, the checker-resolved concrete type of
each field (`getPropertyOfType` + `getTypeOfSymbolAtLocation`); if every
instantiation of a class agrees on a scalar field being `number`, the class's
`field_types` records it. SROA then types that field's scalar locals as unboxed
numbers and propagates "numeric" through copy chains, so a NoEscape `Box<number>`
is scalar-replaced into raw doubles/int64 with NO box/unbox roundtrip. Result on
a generic Box loop kernel: AOT ~192ms vs V8 ~219ms (AOT wins ~1.14x). Non-numeric
type args (e.g. `Box<string>`) are left on the erased tsv path (correct, slower).
This validates the thesis: monomorphization unlocks the existing specialization +
SROA wins for generics. Full class cloning (distinct `Box$number` structs, generic
functions, multiple type params) remains future work.

## Staged implementation plan (full)
1. **Vertical slice**: `Box<number>` → `Box$number` with a real `double value`;
   show SROA scalar-replaces it and beats V8 on a generic object kernel. Proves
   monomorphization unlocks the existing specialization wins.
2. Generic functions (`identity<T>`), multiple type params, nested generics.
3. Structural/anonymous object type args; array/tuple type args.
4. Closed-world resolvability analysis + erased fallback + explicit logging.
5. Explosion/recursion caps.
6. (Later) higher-order generics over function types; interaction with the P5
   async state machine for `Promise<T>`.

## Relationship to existing components
- **classes**: specialized generic classes are just classes — same prefix
  layout, vtable, devirt, accessors.
- **codegen/SROA**: no changes; concrete fields trigger the existing
  int64/double/typed-struct paths and SROA.
- **closures**: function-type type args currently erase to closures; revisit when
  specializing higher-order generics.
- **devirt closed-world flags**: the resolvability analysis reuses the
  `stable`/`instantiated` machinery.
