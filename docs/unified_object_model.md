# Unified Object Model Design

## 0. Motivation and Policy (Kaz)

In JS semantics, **every object** (plain object / class instance / Array / Map / Set /
Function / ...) inherits `Object.prototype` via the proto chain, and has:

- Inherited methods (`arr.hasOwnProperty`, `arr.toString`, `m.constructor`)
- Custom named properties on the instance (`arr.custom = 99`)
- Their reflection into `Object.keys(arr)`

Therefore **every GC object should have a proto + prop-map (a dynamic-property foundation)**.

### Design Principles (Kaz)
1. **When dynamic access occurs, always operate under the conventional JS object model (proto + prop-map)**
   — this is the "always correct" baseline.
2. **Optimizations (struct-ification, `->fN` direct access, unboxed, static method dispatch) are applied
   only when the TypeScript type lets us judge them safe.**
3. **Mark the factors that break optimization; values/classes for which those factors exist are not put on
   the optimization route but run on the baseline (dynamic model).**

This principle is already partially implemented in tsaot's class optimization (the `stable`/`unstable`
decision; see §2). This design **generalizes it to all object kinds**, in particular making arrays carry a
proto + prop-map.

## 1. Current State

| Kind | proto | prop-map | Notes |
|------|-------|----------|-------|
| plain object / class instance / proto / Date (`TS_KIND_OBJECT`) | ✓ | ✓ | `ts_object {h, proto, props, cap, len, shape}`. The class struct already embeds a `ts_object header` at its front |
| Array (`ts_array`) | ✗ | ✗ | `{h, data, len, cap}` |
| Function (`ts_func`) | ✗ | ✗ | `{h, code, env, envlen}` |
| Map (`ts_map`) | ✗ | ✗ | `{h, keys, vals, len, cap}` |
| Set (`ts_set_t`) | ✗ | ✗ | `{h, elems, len, cap}` |
| Promise / Coro / Accessor | ✗ | ✗ | Internal values. Users are unlikely to attach properties, but they should still have a proto |

The recent memory-safety guard (early return in `ts_get`/`ts_set` when `kind != TS_KIND_OBJECT`) is a
stopgap to prevent the heap-overflow from reading a `ts_array` as a `ts_object`. It can be removed once this
design is complete.

## 2. Existing detection of "factors that break optimization" (assets to reuse/extend)

`exporter/class_extract.ts` already detects the following and records `stable = false` + `reasons`:
- `prototype-mutation` / `prototype-assign` (overwriting the prototype)
- `method-reassign` / `dynamic-prop-write` (dynamic writes to non-declared properties)
- `dynamic-elem-write` / `dynamic-this-write` (`this[expr] = ...`)
- `Object.defineProperty` / `Object.assign` and other `Object.*`, `Object.*-on-prototype`
- `delete-member`, `computed-method-name`/`computed-field-name`, mixin, `constructor-returns-value`

In stage B, the codegen-side `struct_direct_offset(c, field, classes)` checks `c.stable` and already does
`->fN` direct access only for stable classes, falling back to the canonical path (`ts_get`/`ts_set`) for
unstable ones.

→ **Principle 3 is already implemented for classes.** This design applies the same idea to arrays and the
like (arrays known by their type to be `number[]` etc. take the element fast path; `any` or dynamic-property
attachment falls to the dynamic model).

## 3. Proposed layout: common object header

Apply to every object kind the same approach by which the class struct embeds a `ts_object header` at its
front to obtain proto/props. **Place a common prefix `ts_obj_common` at the front of each struct**:

```c
typedef struct ts_obj_common {
  ts_gc_header h;
  struct ts_object* proto;   /* prototype chain */
  ts_prop* props; uint32_t pcap, plen;  /* dynamic named-property map (lazily allocated) */
  uint32_t shape;            /* reserved for PIC (§6 of property_model_redesign) */
} ts_obj_common;
```

`ts_object` is just this common part (= the same layout as the current `ts_object`). Each specialized type
has the common part at its front, with its own fields following:

```c
typedef struct ts_array {
  ts_obj_common o;           /* proto + prop-map (lazy) */
  tsv* data; uint32_t len, cap;   /* element fast path */
} ts_array;
typedef struct ts_func { ts_obj_common o; void* code; tsv* env; uint32_t envlen; } ts_func;
typedef struct ts_map  { ts_obj_common o; tsv* keys; tsv* vals; uint32_t len, cap; } ts_map;
typedef struct ts_set_t{ ts_obj_common o; tsv* elems; uint32_t len, cap; } ts_set_t;
/* promise/coro/accessor likewise get ts_obj_common at the front */
```

### Lazy prop-map (perf preservation / Principles 1 & 2)
- `props = NULL, pcap = plen = 0` is the initial state. **The prop-map is not allocated until a named
  property is actually attached** (analogous to V8's fast→dictionary demotion).
- The hot array-element access `ts_array_get/set` touches only `data/len/cap`. Prepending the common part
  merely shifts these field offsets back; the logic and complexity are unchanged.
- `ts_get(arr, key)`:
  1. Array-specific special-casing (`"length"` → `len`, integer index → element)
  2. Its own prop-map (`props`; skip immediately if empty)
  3. The proto chain (`arr.o.proto` = Array.prototype → Object.prototype)
  These are traversed "only on dynamic access." A typed array's `arr.join()` etc. still use static builtin
  dispatch as before.

## 4. Setting up the protos

- In addition to `g_object_proto` (existing), add `g_array_proto` / `g_function_proto` / `g_map_proto` /
  `g_set_proto`. Each has `proto = g_object_proto`.
- If the array builtins (`join`/`indexOf`/`slice`/...) are registered as `ts_func` on Array.prototype, then
  `arr.method()` on an `any` type can be resolved via the proto chain (completing the dynamic route).
  - A thin bridge that wraps a builtin in a `ts_func` is needed (recv = args[0]). Callback-taking
    `map`/`filter` also work via `ts_call`.
- Set `o.proto = g_array_proto` in `ts_new_array` etc.

## 5. Generalizing ts_get / ts_set

Remove the `kind != TS_KIND_OBJECT` guard and make them operate on the common part `ts_obj_common`:
- Rebase the current logic — struct-field (class descriptor) check → own prop-map → proto chain — onto the
  common part.
- For Array/Map/Set, `ts_get` first resolves the "kind-specific built-in property (length/size)" before
  proceeding to the prop-map and proto.
- `ts_set` likewise. Attaching `arr.custom = 99` to an array lazily allocates the prop-map and stores the
  value; from then on that array "has named properties." `Object.keys(arr)` enumerates the element keys
  ("0".."n") plus the named properties (the integer-key-first ordering of §3.6 applies as-is).

## 6. Generalizing enumeration (`ts_prop_own_enum`)

Currently `ts_prop_own_enum` rejects `kind != OBJECT`. An array's `Object.keys` is "the integer index keys
("0".."len-1") in ascending order → the prop-map's named keys in insertion order." Integrate with the
existing integer-key-first logic (`prop_key_is_array_index`): enumerate the array's elements as index keys,
then the prop-map.

## 7. Incremental migration (with behavior-invariance gates)

At each stage, confirm "all CI green + ASan clean + no perf regression":

- **U-1**: Define the `ts_obj_common` type. Represent `ts_object` in terms of `ts_obj_common` (layout
  unchanged). Reorganize GC scan/free around the common part. — Behavior completely unchanged.
- **U-2**: Prepend the common part to `ts_array` (`{o, data, len, cap}`). The ~91 field accesses in
  `ts_array_get/set` etc. stay as `a->data` (prepending the common part only changes offsets; if member
  names are unchanged, no edits needed). Set `o.proto = g_array_proto` in `ts_new_array`; the prop-map is
  lazy (NULL). Update GC. Keep the memory-safety guard for now. — Only the array allocation size grows;
  behavior unchanged.
- **U-3**: Set up `g_array_proto` and register the Array.prototype builtins as `ts_func` wrappers. Remove
  the `ts_get`/`ts_set` guards and operate on the common part. Array `length`/element special-casing +
  prop-map + proto. `arr.method()` on an `any` type resolves via proto. `arr.custom=99` is stored in the
  prop-map.
- **U-4**: Make `ts_prop_own_enum` array-aware (index keys + named keys). `Object.keys(arr)` etc. match JS.
- **U-5**: Prepend the common part to Map/Set/Function too and set up their protos (same pattern).
- At each stage, confirm "the typed-array element fast path is machine-code-invariant" and "no perf
  regression in obj_kernel etc."

## 8. Relationship to the optimization route (enforcing Principles 2 & 3)

- Arrays known by their type to be `number[]` etc., with no dynamic-property attachment or proto
  overwriting, keep the element fast path and static builtin dispatch (preserving the current optimization).
- Only when `any` type, dynamic-property attachment, or proto manipulation is involved do they fall onto the
  dynamic model (proto+prop-map).
- This is the same structure as a class's `stable`/`unstable`. In the future we can also introduce, for
  arrays, marks for the "factors that break optimization" (a non-integer key in `arr[expr]=v`, a named
  attachment `arr.x=v`, `Object.setPrototypeOf(arr,...)`, etc.), branching to the fast path when absent and
  the dynamic model when present (an extension from U-3 onward).

## 9. Risks and caveats

- **GC**: Prepending the common part changes the field offsets of every kind. The GC's mark/free
  (`gc_collect`) must follow the offset changes so it correctly traverses each kind's pointers
  (`data`/`keys`/`env` etc.). Verify with ASan + leak checks.
- **Emit side**: The class struct already prepends the `ts_object header`, so there is no impact. Check the
  allocation-size computation in array-literal construction and the `sobj`/`hobj` paths.
- **Perf**: Arrays grow by +~40B/instance. Hot loops use the element fast path (machine-code-invariant), so
  the only CPU impact stems from the allocation size. Measure with the obj/typed_field/int/float/inherit
  kernels and confirm within budget.
- **Blast radius**: ~91 `ts_array` field accesses. Prepending the common part without changing member names
  leaves most of them unedited (`a->data` etc. stay the same). Only the sites that depend on
  `sizeof(ts_array)` need checking.

## 10. Precise semantics of the `new` operator (ECMA-262 conformant)

Reference: "The meaning of JavaScript's new operator" nanto_vi, Days on the Moon (2005-10-24)
https://nanto.asablo.jp/blog/2005/10/24/118564
(Source: ECMA-262 3rd 11.2.2 the new operator / 13.2.2 [[Construct]])

`new F(args)` behaves in the following 4 steps (summary of the article):

1. **Create a new object.**
2. **Set that object's `[[Prototype]]` (`__proto__`) to the value of `F.prototype`.**
   - If `F.prototype` is not an object (a primitive), set `Object.prototype` instead.
3. **Call `F`.** `this` = the object created in step 1; the arguments are exactly those given to `new`.
4. **If the return value of step 3 is an object, return it; otherwise return the object created in step 1.**
   - "Is an object" = not a primitive value (string / number / boolean / undefined / null). `new String("s")`
     etc. is an object; `"s"`/`123`/`true` etc. are primitives.

Pseudocode (from the article):
```
Function.prototype.construct = function () {
  var newInstance = new Object();
  if (this.prototype instanceof Object)
    newInstance.__proto__ = this.prototype;
  var returnValue = this.apply(newInstance, arguments);
  if (returnValue instanceof Object) return returnValue;   // step 4
  return newInstance;
};
```

### Connection to this design (the unified object model)
Because in this design every object has a proto, steps 1–2 of `new` can be expressed uniformly:
- step 1: Allocate an instance carrying `ts_obj_common` (class struct / plain object).
- step 2: `o.proto = F.prototype` (= that class's CLASS_PROTO). The special case where `F.prototype` is a
  non-object is excluded by type in tsaot, so it is normally fixed to CLASS_PROTO. On the dynamic path,
  however, precisely implement the fallback "if `F.prototype` is not an object, use `g_object_proto`."
- step 3: Call the constructor (recv = the instance; the field initializers are already injected into the
  ctor body per §3.5 case A).
- step 4: **If the constructor's return value is an object, use it as the value of `new`.**

### tsaot's current state and the discrepancy (needs fixing; confirmed by measurement)
The current `new C()` lowering is AllocObject → Call(ctor, recv=inst) → return the instance, and **does not
implement step 4** (it discards the ctor's return value). Verification:
- `class A { constructor(){ this.x=1; return {x:99}; } }` → V8 gives `new A().x === 99` (the returned
  object), but tsaot discards the ctor return value and uses the instance (and moreover the current codegen
  breaks and emits `v2 undeclared`). `constructor-returns-value` only marks it unstable and is otherwise
  unimplemented.
- `class B { constructor(){ this.x=7; return 42; } }` → V8 gives `new B().x === 7` (a primitive return value
  is ignored). tsaot also uses the instance, so this one happens to match.

### Fix policy (a precise implementation of new step 4)
A. **Give the ctor call a dst and receive the return value.**
B. **Branch on whether the ctor can return a value (`constructor-returns-value`):**
   - Cannot return (the majority; determined by type): as before, use the instance directly as the value of
     `new` (preserving the optimization route; zero extra branches).
   - Can return: implement step 4 via the runtime `ts_construct_result(inst, ret)` ——
     `return ts_is_object_like(ret) ? ret : inst;` (object-like = non-primitive; a NaN-box selector check
     excluding string / number / boolean / undefined / null).
   This branch rides directly on this design's Principle 3: "mark the factor that breaks optimization (the
   ctor returning a value), and take the optimization route when absent."
C. **Implicit constructors (no ctor) / classes with only field initializers return no value, so they always
   yield the instance** (unchanged).
D. So that step 4 chains in the inheritance case where a parent class's ctor returns a value, align the
   handling of the `super()` call's return value with ECMA (the ES2015 semantics whereby, if a derived
   class's super return value is an object, it becomes `this` — but incrementally, within the bounds of
   tsaot's current class model).

### Addition to the migration stages
- **U-6 (new step 4)**: Give the ctor call a dst. Only for `constructor-returns-value` classes, decide at
  runtime via `ts_construct_result` (adopt an object return value). Otherwise keep the current fast path.
  Confirm V8 agreement with goldens (object return / primitive return / no ctor / inheritance). Can be
  implemented independently of U-1..U-5 (before or after proto unification is fine, but U-3 onward is
  preferable for consistency of the step-2 proto setup).

---
## Implementation log

- **U-1 DONE**: Introduced the `ts_obj_common` type with `typedef struct ts_obj_common ts_object;`. Layout
  completely unchanged (sizeof 48, proto@16, props@24, shape@40). GC and existing code unmodified. CI green.
- **U-2 DONE**: Prepended `ts_obj_common o;` to `ts_array` (`{o, data, len, cap}`, sizeof 64, data@48).
  Keeping member names data/len/cap, `a->data` etc. are unmodified. `ts_new_array` initializes o.proto/
  o.props=NULL via gc_alloc(calloc). Updated GC mark to also traverse `a->o.props[i].val`/`a->o.proto`, and
  free to also free `a->o.props`. ASan clean, perf neutral (element fast path machine-code-invariant, only
  +16B allocation size).
- **U-3 DONE**: Implemented Array.prototype.
  - runtime: `ts_arrproto_*` (26 of them) = each array builtin wrapped in the ts_code signature (this=args[0],
    JS default arguments). `g_array_proto` (proto=g_object_proto) + `ts_array_proto_init/register`.
    `o.proto=g_array_proto` in `ts_new_array`.
  - Relaxed the ts_get/ts_set guard to `kind != OBJECT && kind != ARRAY`. OBJECT and ARRAY alias ts_obj_common
    at offset 0, so they operate via the common header (proto + lazy prop-map). class_field_lookup is
    OBJECT-only (arrays have no class descriptor). func/map/set remain excluded as before until U-5.
  - exporter: emit `arrayProtoMethods` (name/runtime/methodId, 26 methods). emit_c generates
    `ts_setup_array_proto()`, registers each method on the proto via `TS_KEY_METHOD(id)`, and calls it in main
    after the object proto. Added an `array_proto_methods` field to Program (also updated 6 test fixtures).
  - Result (V8 agreement, ASan clean): **dynamic methods on `any`-typed arrays (join/indexOf/includes/slice/
    map/filter etc., including with callbacks) resolve correctly via proto**. **A custom named property on an
    array `a.custom=99` is stored in the lazy prop-map.** The typed-array static fast path is unchanged. Added
    golden any_array_methods (44 total). Updated runtime_anymethod_safe to "array works / map & set safely
    loud-fail." All CI green, perf neutral (typed_field 183ms, obj 202ms, int 382ms).
  - As a result, the original "heap-overflow of arr:any.join()" is not merely made safe but now **works
    correctly**.

### Remaining
- **U-4**: Make `ts_prop_own_enum` array-aware (index keys ascending + named keys). Bring Object.keys(arr)
  etc. into JS agreement.
- **U-5**: Prepend the common header to Map/Set/Function/Promise/Coro + set up protos. Make it possible to
  remove the guard entirely.
- **U-6**: new operator step 4 (if the ctor returns an object, adopt it; §10).

- **U-4 DONE**: Made `ts_prop_own_enum` array-aware. For arrays, first enumerate the index keys in order
  ("0".."len-1", value=element, string-keyed via ts_intern_field), then enumerate the common header's named
  prop map. JSON/console-inspect are unaffected because the array-specific path comes first (it stays [] not
  {}). Fixed spread {...arr}'s ts_object_copy_props and Object.assign to accept an array source (previously
  skipped via ts_is_array). Result (V8 agreement, ASan clean): Object.keys(arr)=0,1,2 / values=elements /
  with custom=0,1,2,custom / entries=[["0",..],..] / {...arr}={"0":..} / Object.assign(t,arr). Added golden
  array_enum (45 total). All CI green, perf neutral (obj 205ms, typed_field 168ms, int 385ms).
  Note: destructuring of a 2-element `any`-typed array `const [k,v] of entries` is a pre-existing issue on a
  different path (array destructuring) and is independent of U-4 (entries itself and non-destructuring for-of
  are correct).

### Remaining
- **U-5**: Prepend the common header to Map/Set/Function/Promise/Coro + set up protos. Make it possible to
  remove the guard entirely.
- **U-6**: new operator step 4 (§10).

- **U-6 DONE (new operator step 4)**: Only for classes whose ctor can return a value (already marked
  `constructor-returns-value` by class_extract), the new lowering gives the ctor call a dst to capture the
  return value and emits `ConstructResult{dst,inst,ret}`. codegen emits `ts_construct_result(inst, ret)`
  (ret if it is object-like; the instance if primitive/undefined/null). escape analysis adds inst+ret to
  op_forces_materialization and, in the escape arm, treats dst as an alias of the instance. The runtime
  `ts_construct_result` classifies number/string/bool/undef/null as primitive (everything else = plain
  object/array/func/map/set is object-like).
  The majority of classes, which return no value, keep the previous fast path (no ConstructResult emitted, no
  dst on the ctor call) = Principle 3 exactly.
  Verification (V8 agreement, ASan clean): object return 99 5 / primitive return 7 (ignored) / normal 3 /
  array return 3 1 (array is also object-like). Normal classes invoke ts_construct_result 0 times (fast path
  preserved). Added golden new_ctor_return (46 total). 7 unit tests PASS (ConstructResult does not break the
  exhaustive match). Fixed the original `v2 undeclared` bug (codegen breaking from discarding the ctor return
  value). Implemented independently of U-1..U-5 (before or after proto unification is fine). This time it was
  done ahead of U-5.

### Remaining
- **U-5**: Prepend the common header to Map/Set/Function/Promise/Coro + set up protos (same pattern as
  U-2/U-3). This makes it possible to remove the ts_get/ts_set guard entirely, and lets map:any.method() etc.
  resolve via proto as well.

- **U-5 DONE (func/map/set given the common header; proto setup partial)**: Prepended `ts_obj_common o;` to
  ts_func/ts_map/ts_set_t (same pattern as U-2; keeping member names code/env/keys/vals/elems, the bodies are
  unmodified). Updated GC mark to also traverse each o.props/o.proto, and free to also free o.props.
  Generalized the ts_get/ts_set guard to `kind_has_common_header(kind)` (OBJECT/ARRAY/FUNC/MAP/SET).
  promise/coro/accessor are internal objects that never become a property-bag receiver, so they are not
  subject to the common header (still outside the guard, as before). proto is NULL-initialized. Registering
  builtin wrappers on the Map/Set/Function prototypes (the same mechanism as U-3's array) is a follow-on. The
  focus this time is establishing memory safety (ts_get/ts_set operate safely via the common header) and the
  structural completion of the unified model.
  Verification (V8 agreement, ASan clean): Map.set/get/size, Set.add/has/size, closure calls, GC stress of a
  500-iteration loop (375250). map:any.keys() safely loud-fails via the common header (no overflow, the guard
  band-aid is no longer needed). runtime + golden green.
  Note: ts_object/ts_array/ts_func/ts_map/ts_set_t are all unified with the ts_obj_common prefix. The original
  "kind != TS_KIND_OBJECT guard (band-aid)" was replaced by a legitimate classification via
  kind_has_common_header.

### Follow-ons (optional)
- Register builtins on the Map/Set/Function prototypes as ts_func wrappers (same pattern as U-3's array) → to
  resolve `any`-typed m.get()/s.has()/fn.call() etc. via proto. Currently these work via static dispatch, and
  only the `any` type loud-fails.
- Give promise/coro/accessor the common header (if it becomes necessary; currently unneeded since they never
  become a property-bag receiver).

- **Follow-on DONE (registering builtins on the Map/Set prototypes)**: Implemented Map.prototype /
  Set.prototype with the same mechanism as U-3's array.
  - runtime: ts_mapproto_* (set/get/has/delete/clear/keys/values/forEach) / ts_setproto_* (add/has/
    delete/clear/values/forEach) = each builtin wrapped in ts_code. g_map_proto/g_set_proto
    (proto=g_object_proto) + init/register. Set o.proto in ts_new_map/ts_new_set. `size` is a property (not a
    method), so it is not a registration target (the CallBuiltin map.size/set.size fast path).
  - exporter: emit mapProtoMethods/setProtoMethods. emit_c generates ts_setup_map_proto/ts_setup_set_proto and
    calls them in main. Added map_proto_methods/set_proto_methods to Program (updated 6 fixtures).
  - Result (V8 agreement, ASan clean): **dynamic methods on `any`-typed Map/Set (get/has/delete/forEach etc.,
    including with callbacks) resolve via proto**. Typed Map/Set keep static dispatch (proto acts only on the
    dynamic path). Added golden any_mapset_methods (47 total). Updated runtime_anymethod_safe to "array/map/set
    all resolve correctly."

### Full CI (U-5 + U-6 + follow-ons)
All green: 7 unit tests / ci_fast (including reject-symbol, anymethod-safe) / golden 47 / all perf within
budget (obj 207ms, typed_field 187ms, int 392ms, float 250ms, inherit 83ms, generic 198ms) / correct1 /
correct2. Unified object model U-1..U-6 + follow-ons complete.

- **Follow-on DONE (Function.prototype: call/apply/bind)**: Implemented after confirming the JS semantics
  against V8.
  - Semantics: f.call(thisArg,a,b)=this=thisArg+individual arguments / f.apply(thisArg,[a,b])=array arguments
    / f.bind(thisArg,...partial)=a new function with this and the leading arguments fixed / a free function
    (no this) ignores thisArg.
  - runtime: `uint8_t takes_this` on ts_func (whether the callee reads args[0] as this). ts_make_fn sets
    f->o.proto=g_function_proto; the takes_this-bearing variant ts_make_fn_t. invoke_with_this (injects thisArg
    into args[0] only when takes_this). ts_funcproto_call/apply/bind. ts_bound_thunk (captures env=[target,
    thisArg,partial...]; ts_call prepends env). g_function_proto + init/register.
  - Extended the ts_get/ts_set entry guard to `ts_is_propbag(v)=ts_is_obj(v)||ts_is_func(v)` (**fixes a bug
    where ts_get previously rejected function values, because a function has the TS_SEL_FUNC selector and not
    TS_SEL_OBJECT**; arrays/Map/Set have the OBJECT selector, so they passed all along).
  - exporter: at sites that reference a top-level function as a value (the f in f.call, callbacks), emit
    AllocClosure to make it a ts_func (fixes a bug where it previously stayed TS_UNDEFINED). Detect an explicit
    `this` parameter (function f(this:T,...)) as thisParam, skip it in the normal parameter loop, and set
    takesThis=true. takes_this on the Function struct, function_proto_methods on Program. emit_c threads the
    fn_takes_this map through Ctx, emits ts_make_fn_t(...,tt) at AllocClosure, and generates
    ts_setup_function_proto.
  - **Direct call of a this-parameter function** (f(1,2)): at a Direct call site, when the callee is in
    funcTakesThisIds, prepend an undefined this slot at the front of args. **Value/callback call**
    (const g=f; g(1,2) / apply2(f)): ts_call_value injects an undefined this into a takes_this callee (ts_call
    is unchanged because via method the this is already at args[0]).
  - **Call of an arbitrary-expression callee** (greet.bind(o)("World") etc., where the callee is a
    CallExpression): in the Unknown fallback, lower the callee to a value and do a Value call (previously it
    fell over with dynamic-dispatch-unsupported).
  - Verification (V8 agreement, ASan clean): call 103 / apply 107 / bind partial application 115 / bind 150 /
    direct call 3 / Value call 9 / free function call 7 / free bind 15 / immediately-invoked bind Hello World.
    Normal callbacks (map/reduce/higher-order functions) are unchanged because takes_this=0 delegates to
    ts_call. Added golden func_call_apply_bind (48 total).

### Full CI (Function.prototype follow-on)
All green: unit 7 / ci_fast / golden 48 / all perf within budget (obj 204ms, typed_field 181ms, int 380ms,
float 251ms, inherit 85ms, generic 193ms) / correct1 / correct2.

### Remaining follow-ons (optional)
- fn.name / fn.length (metadata; currently unimplemented, when needed).
- Give promise/coro/accessor the common header (unneeded since they never become a property-bag receiver).

## Bench speedup + tiered test infrastructure + exhaustive tests (session 3)

### Bench speedup (~33x)
Measurement pinpointed the bottleneck: per benchmark, export ~1.8s (node startup + tsc Program construction),
analysis 3ms, compile 148ms.
- Added a **`--batch` mode** to the exporter (`exporter.ts:batchMain`):
  - The initial idea of "put all files into one `ts.Program`" broke (each benchmark is a global script, so
    `function main()` etc. collide)
  - **The correct answer**: a shared CompilerHost that caches `lib.*.d.ts` + a separate Program per file. First
    time 1.0s, thereafter 18ms/file
- Added a **`--transpile-batch` mode**: uses `ts.transpileModule` to strip types and generate the V8 reference
  .js (appending `if(typeof main==='function')main();` at the end)
- Rewrote `run_benchmarks.sh` to support batch mode, and added `scripts/run_conformance.sh`
- Result: shortened export of all 62 benchmarks to 3.4s, and the 48 golden iterations to 16s (previously ~90s)

### Tiered test infrastructure (`tests/conformance/{basic,exhaustive}/`)
- **V8 is the sole source of truth** (no hand-written expected values; auto-generated by `--transpile-batch`)
- Tests can be added just by dropping in a file
- Distributed execution is possible via `TSAOT_CONF_SHARD=i/n`
- basic (3, regression net) / exhaustive (34, 10 categories:
  numbers/strings/arrays/objects/control/closures/classes/generics/maps_sets/iteration)

### Bugs the exhaustive tests found and fixed (all V8-agreeing, ASan-clean)

**Numeric / type system**:
- Numeric-receiver methods `.toFixed()`/`toString(radix)`/`toPrecision()` — added a number builtin kind +
  runtime (half-away-from-zero to match V8)
- String `lastIndexOf`
- **Unary-minus float truncated to int** (the serious bug `Math.abs(-3.14)→3`) — added UnOp handling to
  `infer_int_locals`; the result's int-ness is determined by the operator and the operand
- Bitwise operators `& | ^ << >> >>>`, `**`, `~` — implemented with JS ToInt32/ToUint32 (NaN/Inf→0, truncate
  toward 0, mod 2^32). Added `ts_to_int32(double)`/`ts_to_uint32(double)` to `ts_rt.h`. `~x` always returns
  int32
- Variadic `Math.max/min` — folded into nested 2-argument calls
- `isNaN`/`isFinite`/`NaN`/`Infinity` globals — added **`ConstVal::NaN/PosInf/NegInf`** (a dedicated tag is
  needed since NaN/Inf are not valid JSON numbers), and treat these as numeric in `collect_non_numeric_consts`

**Control flow / collections**:
- **switch fall-through** (`case 1: case 2: case 3: <body>`) — OR-group the `===` comparisons of empty-body
  cases via a short-circuit If (the `||` BinOp is unsupported in codegen)
- **Variadic `array.push(4,5)`** — append all arguments; the result is the new length
- **for-of over `map.keys()`/`values()`** — a builtin's array return value prefers array iteration over the
  dynamic iterator protocol (generators/custom iterators still go via `resolveIterator` as before)
- **for-of over a string** (`for(ch of "abc")`) — character iteration via `GenericLen` + `string.charAt`
- **`continue` inside a for loop** — move the incrementor to the head of cond_body (guarded by a first flag),
  add loop kind "forc". `continue` jumps to cond_body → the incrementor runs. All perf kernels within budget,
  no regression

**Closures**:
- **A captured parameter is not initialized into its cell** (serious bug): in
  `function compose(f,g){ return x=>f(g(x)); }`, f,g are undefined → "value is not a function". Emit
  `StoreField(cell, VALUE, paramLocal)` at function entry (excluding `this`)
- **Call of an arbitrary-expression callee** (`greet.bind(o)("World")` etc., where the callee is a
  CallExpression) — in the Unknown fallback, lower the callee to a value and do a Value call

### Progress
- exhaustive: 20 → 31/34 pass
- The remaining 3 are recorded in `KNOWN_GAPS.md` and deferred as high-risk:
  - `classes__basic`/`methods` — inliner local collision (when `Math.sqrt(this.x*this.x+this.y*this.y)` is
    inlined, the sqrt argument local is mis-numbered; the free-function `Math.sqrt(x*x+y*y)` works)
  - `closures__capture` — per-iteration capture of a loop `let i` (needs per-iteration cell allocation)

### Full CI (all shards)
unit 7 / ci_fast / golden 48 / all perf within budget / correct1 / correct2 all green.

## Complete resolution of the remaining gaps (session 4)

### Bug 1: inliner local leak
**Symptom**: when `class Point { dist(){ return Math.sqrt(this.x*this.x+this.y*this.y); } }` is inlined, the
argument local of `sqrt` is mis-numbered (the computed sum lands in a different local, and `sqrt` reads an
uninitialized local), so `p.dist()` returns 0.

**Cause**: the `other => out.push(other.clone())` fall-through in `analyzer/src/sroa.rs::inline_callee`.
`CallBuiltinStatic`, `AllocClosure`, `If`/`Loop`/`TryCatch` (nested bodies), and many other variants were
being **raw-cloned without remapping their operands**.

**Fix**: added a `remap_inst_operands(inst, &m)` helper. It covers all `Inst` variants (Rust verifies
exhaustiveness at compile time) and recursively remaps nested bodies. `subst` is prebuilt from
`callee.locals`, so it covers every LocalId in the body.

### Bug 1.5: SROA allocated a non-numeric field as a Primitive (double)
**Symptom**: in `class Stack { items: number[] = []; }` the `items` scalar was created as a double, and
`ts_to_num(array pointer)` corrupted the value. `classes__methods` output `0 NaN 0`.

**Cause**: `process_function`'s `fresh(next, new_locals, false)` was making every scalar a Primitive
regardless of the field type.

**Fix**: decide via `is_numeric = numeric_fields.contains(&(cls, f))`; numeric becomes Primitive, everything
else becomes Reference.

### Bug 1.6: `.push(x)` lowered to ArrayPush without checking the receiver
**Symptom**: even after the above fix, `classes__methods` output `0 NaN 0`. A user class's `Stack#push`
method call was treating the instance as an array and being turned into `ArrayPush`.

**Cause**: the exporter's early path (`fnx.name.text === "push" && argc === 1`) unconditionally emitted
`ArrayPush`.

**Fix**: guarded with `builtinReceiverKind === "array"`.

### Bug 1.7: missing inheritance propagation of `numeric_fields` (performance regression)
**Symptom**: after the Bug 1.5 fix, `inherit_sroa_kernel` was **SLOW at 192ms vs a 130ms budget**.

**Cause**: with `IntBox extends Base<number>`, the SROA target is IntBox (class id 1) and it looks up
`numeric_fields.contains((1, 2))`, but `numeric_fields` only contains `(Base$number=2, value=2)`. The
inherited field is not recognized as numeric, the scalar becomes a Reference, and box/unbox round-trips occur
in the hot loop.

**Fix**: after building `numeric_fields`, walk the parent chain to propagate `(descendant_cls, fid)` to all
descendants. Restored `inherit_sroa_kernel` to 91ms.

### Bug 2: per-iteration capture of a loop `let`
**Symptom**: in `for(let i=0;i<3;i++){fns.push(()=>i);}` all closures see i=3 (V8: 0 1 2).

**Cause**: the prologue allocates only one cell, shared across the whole loop. The spec (ECMA-262 §14.7.4.2
ForBodyEvaluation) creates a new binding on each iteration, and a closure capture should retain the value at
the point of the body.

**Key design point** (`docs/inliner_and_loop_let_capture.md`):
- The spec order: body → CreatePerIterationEnvironment (copy values into a new environment) → update (mutate
  the new environment) → test
- That is, update **mutates the cell of the next iteration** (not the current iteration's cell). A closure
  captured during iter-N's body keeps holding iter-N's cell (the value before the update)

**Fix**: detect a captured-let during `for` statement lowering (`initializer.flags & NodeFlags.Let` and a
single-identifier declarator and the symbol present in `cellBindings`). On detection, generate the
per-iteration cell-allocation structure:

```
init_cell = AllocObject(site_init);
cellLocal = init_cell;
cellLocal.value = E_init;
first = true;
Loop {
  cond_body: {
    if (!first) {
      prev = cellLocal.value;        // value of the current cell (iter-N)
      cellLocal = AllocObject(site_per);  // the cell for iter-N+1
      cellLocal.value = prev;
      update;                          // mutate the iter-N+1 cell
    }
    first = false;
    cond_local = <cond using cellLocal>
  }
  body: { BODY }   // override cellAccess to cellLocal
}
```

`continue` works correctly via the `forc` loop's C `continue` (a jump to cond_body). The prologue's cell
allocation is dead code (gcc removes it).

### Added conformance tests

- `closures/capture_continue.ts`: the interaction of a captured `let i` + `continue`
- `closures/capture_mutate.ts`: a closure that references both i and arr[i]
- `closures/capture_no_alloc.ts`: the single-cell path of a non-captured `let i` (performance regression net)

### Final state (session 4 complete)

- **exhaustive: 31/34 → 37/37 PASS** (including the 3 new tests)
- basic 3/3, golden 48, all perf kernels within budget, correct1, correct2, ci_fast all green
- No known coverage gaps
