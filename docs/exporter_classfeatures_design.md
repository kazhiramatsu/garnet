# Exporter: accessors, parameter properties, super lowering

Three class features wired into the exporter, all verified end-to-end through
devirt + escape on real exporter output.

## 1. get/set accessors
- `setupClasses` assigns a FunctionId to every getter/setter and records it under
  key `classId:getter:name` / `classId:setter:name`; method bodies are lifted with
  `this` as param 0.
- A property *read* `obj.x` where `x` is a getter lowers to a method `Call`
  (not a `LoadField`); a property *write* `obj.x = v` where `x` is a setter lowers
  to a method `Call` passing `v` (not a `StoreField`).
- Getter and setter use **distinct interned names** (`get x` / `set x`) so they
  occupy separate vtable slots and never collide with each other or a data field.
- The `classes` table emits getter/setter `ownMethods` entries with the matching
  `get x` / `set x` names and `kind`.
- Stability fix: assigning **through a setter** is legitimate; the shape-stability
  scan no longer misclassifies `obj.setterName = v` as `method-reassign`
  (distinguishes member kind: only clobbering a *plain method* is unstable).

## 2. Parameter properties
- `constructor(public x, private y)` ⇒ the constructor is lifted (FunctionId under
  `classId:ctor`) and its prologue emits `this.x = x` / `this.y = y` as `StoreField`
  on the `this`-local, so the fields exist in the IR object exactly as JS would
  initialize them. The fields are already collected into `ownFields` by
  class_extract.ts.

## 3. super lowering (Direct, no devirt needed)
- `super.m(...)` resolves statically to the **parent class's** definition of `m`
  and lowers directly to `CalleeRef::Direct{func}` with `recv = this` (same
  instance). No devirt round-trip — the parent is fixed by the syntactic position.
- `super(...)` constructor call lowers to `Direct{func: parent ctor}` with
  `recv = this`.

## Verified (real exporter output -> devirt -> escape)
- `classfeat.ts` / `classfeat2.ts`: parameter-property stores in ctor; super ctor
  call ⇒ `Direct(Animal.ctor)`; `super.describe()` ⇒ `Direct(Animal.describe)`;
  getter `this.tired` and `dd.tired` ⇒ `Direct(Dog.tired)`; setter `this.boost=`,
  `dd.boost=` ⇒ `Direct(Dog.boost)`. Dog correctly stays `stable` despite setter
  writes.
- Regressions green: class_extract tests, classcall (RTA→Direct), classcall2
  (poly→Virtual), closures e2e 27/27, sample e2e 7/7.

## Remaining for codegen
The `classes` table now carries methods + accessors (with get/set slot-distinct
names) and parameter-property fields; super/accessor calls are already normalized
to Direct/Method. Codegen can emit struct layout (prefix fields), per-class vtables
(method + accessor slots), and Direct/Virtual/Dynamic dispatch.
