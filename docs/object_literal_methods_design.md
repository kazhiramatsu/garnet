# Object-literal method / accessor members — design document

## 0. Purpose

Implement the following 3 forms inside object literals (currently loud-reject, exporter.ts:696):

```js
const o = {
  greet() { return this.v; },     // MethodDeclaration
  get x() { return this.v; },      // GetAccessorDeclaration
  set x(v) { this.v = v; },        // SetAccessorDeclaration
};
```

`this` binds to the object at definition time (`o`).

## 1. Current facts (verified in code)

### 1.1 Object-literal lowering (exporter.ts:659-699)
Handles PropertyAssignment (`{x:1}` / `{g: fn}`), computed key, shorthand, and spread;
everything else (Method/Get/SetAccessor) hits `this.unsupported(p, "object literal member ...")`.
Ordinary properties are stored in the **field-key space** via `StoreField{obj, field: internField(name), src}`.

### 1.2 Resolution of the method call `o.g()` (exporter.ts:1170-1193 / emit_c.rs:2085-2089)
For a non-builtin, non-class (any) receiver, `o.g()` becomes `callee = Method{recvClass:0xffffffff,
method: internName("g")}`. codegen's dynamic path looks up the **method-key space** via
`ts_get(recv, TS_KEY_METHOD(internName_id))` (`method_key_str`, emit_c.rs:737).

### 1.3 The critical asymmetry (root of the bug)
- `{g: fn}` is stored under the **field-key**.
- The `o.g()` call looks up the **method-key**.
- → The key spaces disagree, yielding "method is not a function" (verified).
- Meanwhile `const f = o.g; f()` (extract, then call) works, because it is a LoadField (field-key) (verified).

### 1.4 V8 semantics (verified; guides the design)
```
const o = { greet(){ return 42; } };
typeof o.greet  // "function"   ← retrievable as a value
o.greet()       // 42
const m=o.greet; m()  // 42       ← callable even after extraction
Object.keys(o)  // ['greet']     ← enumerated (an enumerable ordinary property)
```
**Conclusion**: a JS object-literal method is nothing more than "an enumerable ordinary property
holding a function value." It is distinct from a class method (on the prototype, non-enumerable). It
must NOT be placed in the method-key space (an internal optimization). The correct storage is the
**field-key** space, which `o.greet` (LoadField), `Object.keys`, and JSON all see.

## 2. Design

### 2.1 Storage: an ordinary enumerable property (field-key)
For all 3 forms, store the lifted closure (or accessor) under the **field-key**:
- **method** `{ greet() {} }`: lift the closure (this=object, thisParam=true) and emit
  `StoreField{obj, field: internField("greet"), src: closure}`. = the same storage as `{greet: fn}`.
- **get/set** `{ get x(){}, set x(v){} }`: reuse the existing accessor machinery (ts_define_accessor_attr,
  already implemented via defineProperty). The `object.defineAccessor:<g>:<s>:<enum>:<conf>` builtin
  stores an accessor into `obj` under the field-key. **Object-literal accessors are enumerable**
  (V8: `Object.keys({get x(){return 1}})` → `['x']`), so they are defined with enum=1, conf=1.

### 2.2 Key resolution order for the call `o.greet()` (own → prototype)

**Important correction (verified with V8)**: JS property lookup goes own → prototype, and **own shadows
prototype** (shadowing).
```js
class C { constructor(){ this.run = ()=>1; } run(){ return 2; } }
new C().run()   // V8: 1  ← the own field shadows the prototype method
```
Currently tsaot raises a TypeError in this case (it only looks up the method-key and never sees the own field) = an **existing bug**.

Therefore the dynamic method call resolves keys **field-key (own) first, then method-key
(prototype equivalent) second**:
```c
tsv _mv = ts_get(recv, <FIELD_KEY(field_id)>);          // own property (field-key) first
if (!ts_is_callable(_mv)) _mv = ts_get(recv, TS_KEY_METHOD(method_id)); // prototype method
if (!ts_is_callable(_mv)) ts_dynamic_method_missing(method_id);
```
- object-literal method / `{g: fn}` / an own-field function → hits on the 1st lookup (field-key).
- a class instance's prototype method → if not own, hits on the 2nd lookup (method-key).
- the case where an own field shadows a same-named method → field-key first, so it matches V8 (the existing bug is fixed too).
- **perf concern**: every class-method call now looks up the field-key first. The cost is small when
  the own prop map is empty/small, but it must be measured on the hot path (obj_kernel / typed_field
  method calls). If it regresses, restrict the change to: "calls that devirt can statically pin to a
  class method keep the old single method-key direct route, and only Dynamic (recvClass=0xffffffff)
  falls back own→proto" (a statically-pinned class-method call goes struct/vtable-direct and should not
  even pass through ts_get, so under this restriction the hot path is expected to stay unchanged).
  Measure first.

### 2.3 Bridging name-id and field-id
`internName` (the method name space) and `internField` (the field space) are separate ID spaces; the
same string gets a different ID in each. codegen's Method callee only carries the name-id. To fall back
to a field-key lookup, it needs that name's field-id.
**Approach**: when the exporter builds a Method callee, **also internally intern that name's field-id
and give the Method callee a `method_field: FieldId`** (looking up the same string via internField).
codegen tries the own `<field_id>` first and falls back to `TS_KEY_METHOD(method_id)` (own→prototype; see the §2.2 correction).
- Add `method_field: Option<FieldId>` to the IR's `CalleeRef::Method` (backward compatible: existing ones are None).
- Set it at the exporter's 2 Method-callee construction sites (1176-1192) by also calling `internField(name)`.
- escape/devirt pass through untouched (this is extra callee metadata; the operand count is unchanged).

### 2.4 The lifting machinery (this binding)
Reuse what the defineProperty method-shorthand implementation already established
(lowerDefineOneProperty / assignIds / free-var seeding):
- assignIds (exporter.ts:368): already assigns a fnId to `MethodDeclaration name=="get"||"set"` inside an
  object literal. Extend this to **all MethodDeclaration / GetAccessor / SetAccessor** (object-literal members).
- free-var seeding walk (near 4078): likewise, add object-literal method/accessor members to allFns.
- lowerClosure(node, hint, /*thisParam*/ true): lift with this=object (proven approach).

## 3. Stages

- **Stage 1 (method `{ g(){} }`)**: storage (StoreField, field-key, this-bound closure) +
  call fallback (field-key→method-key; own→prototype per §2.2) + adding CalleeRef::Method.method_field.
- **Stage 2 (get/set accessor)**: reuse the existing ts_define_accessor_attr, store with enumerable=1.
  Reading `o.x` uses ts_get's accessor-invocation path (implemented); `o.x=v` uses ts_set's setter path (implemented).

Each stage: full CI green (conf/ci_fast/unit/correct1,2/perf). perf-neutral is mandatory (hot path unchanged).

## 4. Risks

- **perf of the field-key→method-key fallback**: the dynamic method call reads the own property (`<field_id>`)
  first and falls back to the prototype method-key on a miss, so a prototype method resolves on the 2nd lookup.
  This does not regress the hot path — class-method calls go through static/devirtualized dispatch, not this
  dynamic fallback — so only genuinely dynamic receivers pay the extra lookup. Verified with obj_kernel.
- **enumerable**: object-literal methods/accessors are enumerated (V8-conformant). Class methods are
  non-enumerable (prototype). It is correct that the two behave differently.
- **existing `{g: fn}` properties**: the §2.2 fallback makes `o.g()` work for the first time (a secondary improvement).

## 5. Implementation result (DONE)

### Both Stage 1 (method `{ g(){} }`) and Stage 2 (accessor `{ get/set }`) are DONE.

- **Storage (exporter, object literal lowering)**: stored as an ordinary property, as designed.
  - method-shorthand `{ greet() {} }`: lifted via `lowerClosure(this=object)` and stored with
    `StoreField{field: internField(name)}` (field-key). = identical storage to `{greet: fn}`.
  - accessor `{ get x(){}, set x(v){} }`: get/set are **pre-paired** by name and defined with a single
    `object.defineAccessor:<g>:<s>:1:1` builtin (enumerable=1, configurable=1; V8's object-literal
    accessors are enumerated). Aggregating the 2 AST members (get and set) into 1 property avoids the
    "last-write-wins overwrite makes the getter disappear" breakage.
- **Call (emit_c, dynamic method dispatch)**: fixed to own→prototype order.
  - Added `method_field: Option<FieldId>` (the same-named field-key) to `CalleeRef::Method`.
  - The dynamic method call looks up `ts_get(recv, field_key)` (own) first, and if not callable, falls
    back to `ts_get(recv, TS_KEY_METHOD(method_id))` (prototype). Helper `emit_method_value_lookup`.
    method_field is saved on devirt's Dynamic path.
  - This lets object-literal methods / `{g: fn}` / own-field functions be called with method syntax.
    Class methods go Direct/struct-direct via devirt (they do not pass through the dynamic path), so perf is unchanged.
- **Lift machinery**: extended assignIds and the free-var seeding walk to all object-literal method/accessor
  members (Method/Get/SetAccessorDeclaration, both identifier and string names).
- **Verification vs V8**: method(42)/this(10)/consistency of value-retrieval, keys, and call/get(5)/get+set(7)/accessor
  enumerable (shows up in keys)/`{g:fn}` call(9)/a data property overwrites a method, last wins(1).
  The computed-name method `{ [Symbol.iterator]() {} }` is still rejected (computed names are separate).
- perf-neutral (obj_kernel 204ms, typed_field 183ms). All CI green, conf 69/69.
- Updated a stale negative test: replaced rejects_async.sh's "object-literal iterator" with
  "computed-name iterator method" (plain methods are now supported).
- Added conformance: object_methods/{method_shorthand, accessors, property_function_call}.ts.

### A separate known bug (out of scope for this task; needs separate handling)
Found during investigation: the valid TS pattern where **a subclass instance field shadows a same-named
method of the parent class**
```ts
class Base { greet(){ return 2; } }
class Derived extends Base { greet = () => 1; }
new Derived().greet()   // V8: 1, tsaot: 2 (wrong)
```
but devirt statically resolves to the parent method (and further inlines the body via constant folding),
ignoring the own-field shadow. This is a soundness problem in devirt, independent of object-literal methods.
Note: `class C { run; run(){} }` (a field and method with the same name in the same class) is rejected by
TS itself as "Duplicate identifier", so it is a non-issue. Only the subclass shadow remains as valid TS.
Proposed fix (separate task): when a class has a method (own or inherited) with the same name as an own
field, suppress devirt for that method call and drop it to dynamic (own→proto fallback).

## 6. devirt field-shadows-method bug fix (DONE)

Fixed the case flagged in §5 as "a separate bug, needs separate handling": a subclass instance field
shadowing a parent method.
- **Cause**: the exporter built a static Method callee via `recvClass !== undefined && classHasMethod(recvClass, name)`,
  and devirt resolved Direct to the prototype method → ignoring the own-field shadow.
- **Fix**: introduced `classHasField(classId, name)` (walks the class chain searching for an instance field name).
  When deciding a method call's callee, **if a same-named instance field exists, suppress static devirt** and
  drop to the dynamic path (recvClass=0xffffffff). The dynamic path is the §2.2 own(field-key)→
  prototype(method-key) fallback, so it finds the shadowing field first and calls it correctly.
  Prototype methods are registered on the method-key, so an inherited method with no shadow hits on the 2nd stage.
- **Verification vs V8**: `class D extends B { greet = ()=>1 }` over `B { greet(){return 2} }` → 1 (was 2 before the fix),
  field shadows inherited method → 20, inherited method with no shadow → 2 (no regression),
  a normal class method → 3 (no regression).
- perf-neutral (obj_kernel 205ms, typed_field 182ms, inherit_sroa 82ms). Only classes that have a same-named
  field/method take the dynamic path (rare), so the hot path is unchanged. All CI green, conf 70/70.
- Added conformance: object_methods/field_shadows_method.ts.
