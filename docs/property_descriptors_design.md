# Object.defineProperty — Property Attributes (descriptor) Design Document (Draft for Agreement)

## 0. Purpose of this document

At present, `Object.defineProperty` accepts only two forms — the **default data-descriptor form** (`{ value }` with
`enumerable`/`writable`/`configurable` omitted or all `true`) and the **function-valued
accessor form** (`{ get: ()=>..., set: (v)=>... }`) — and everything else is
loud-rejected as `unsupported` (exporter.ts 957-1063, 8 rejects).

This document is the plan for **correctly modeling `enumerable`/`writable`/`configurable`**
and, under one consistent design, implementing the following associated features:

- `Object.defineProperty`'s default attributes (**all `false` when omitted**) and honoring optionally-specified attributes
- `Object.defineProperties`
- `Object.getOwnPropertyDescriptor` / `getOwnPropertyDescriptors`
- The accessor method-shorthand `{ get() {} }`
- The behavior of `writable: false` / `configurable: false` (ignore write / ignore delete)
- Making enumeration (`Object.keys`/`for-in`/`JSON`/spread) respect `enumerable`

**Foundational premises**: `property_model_redesign.md` (stages A-1 through A-2c-1 implemented) and
`accessor_props_design.md` (the function-valued accessor form is implemented). This design builds on top of these, and its
highest-priority constraint is to **not break** their invariants (single-site consolidation of the canonical path, `ts_key` tagged-key, shape/PIC reservation).

> The actual canonical path in the implementation (verified against the code): the design document
> `property_model_redesign.md` notates the canonical API as `ts_prop_get/set/...`, but
> **the implementation actually promotes the existing `ts_get`/`ts_set`/`ts_delete_prop` to be the canonical path**, and
> no alias functions named `ts_prop_*` have been created. Only enumeration was newly added as a
> dedicated function `ts_prop_own_enum`. From here on, this document describes things using the names that actually exist
> (`ts_get`/`ts_set`/`ts_delete_prop`/`ts_prop_own_enum`).
> `delete obj.prop` is **already implemented** via `DeleteField` IR → `ts_delete_prop`
> (making honoring configurable possible). Since the largest GC kind is currently `TS_KIND_ACCESSOR=9`, the
> newly-added data-desc is **`TS_KIND_PROPDESC=10`**.

---

## 1. Current structure (facts)

### 1.1 Runtime property representation (no attribute flags)

```c
typedef struct { ts_key key; tsv val; } ts_prop;     // ts_rt.h:143 — no flags
```

- `ts_object.props` is `ts_prop[]` (lazily allocated). `key` is a 32-bit `ts_key` (only the STRING tag
  uses a real value; SYMBOL/INDEX/WKSYM are reserved).
- **Accessors are already modeled**: `ts_accessor { getter, setter, g_this, s_this }` (kind
  `TS_KIND_ACCESSOR`) is stored OBJECT-tagged in the prop's `val`. `ts_get`/`ts_set`
  check `is_accessor()` and invoke the getter/setter (`accessor_props_design.md`, implemented).
- Fields of a typed class instance are stored in a C struct (`->fN`) and do not go through the prop map
  (hot path). The concept of attributes is only needed for "**properties carried on the dynamic prop map**".

### 1.2 The canonical enumeration path (implemented — this is where attributes take effect)

`ts_prop_own_enum(obj, cb, ud)` (implemented in stage A-2b-2, shared by 8 enumeration sites) is the sole enumeration path.
Currently it visits "struct fields in declaration order → prop-map data props in insertion order", and skips accessor slots.
**Making the `enumerable` attribute take effect only needs this one site** (the design's greatest advantage).

### 1.3 The forms the exporter currently accepts/rejects (facts)

| descriptor form | current state |
|---|---|
| `{ value: v }` (attributes omitted) | accepted → `StoreFieldDynamic` (= an ordinary enumerable, writable prop) |
| `{ value: v, enumerable: true, writable: true }` | accepted (on the assumption that all-true matches an ordinary prop) |
| `{ value: v, enumerable: false }` etc. | **reject** ("per-property flags not modeled") |
| `{ get: fn, set: fn }` (function values) | accepted → `ts_define_accessor_dyn` |
| `{ get() {} }` (method shorthand) | **reject** (lifting does not assign an id) |
| `{ get: fn, enumerable: true }` etc. | **reject** (accessors are always treated as non-enumerable) |
| both `{ value, get }` | **reject** (a TypeError even per spec) |
| non-literal descriptor | **reject** (the form cannot be checked statically) |

### 1.4 Current semantic error (a place we're silently getting it wrong)

**Critical**: at present `{ value: v }` (attributes omitted) is `StoreFieldDynamic`-ed as an "ordinary enumerable prop".
But per the JS spec, **attributes omitted in `Object.defineProperty` are
`false`** (unlike assignment `o.x = v` via a `{}` literal). That is:

```js
const o = {};
o.a = 1;                                   // a is enumerable:true
Object.defineProperty(o, "b", {value: 2}); // b is enumerable:FALSE
Object.keys(o);  // V8: ["a"]   ← b does not appear
```

At present tsaot treats `b` as enumerable too and returns `["a","b"]` (silently diverges).
This is an **existing silent miscompile** stemming from the absence of attribute flags. This design closes it.

---

## 2. Design goals

1. **Represent `enumerable`/`writable`/`configurable` per-property.** But
   put no cost whatsoever on the hot path (typed struct fields).
2. **Keep it confined to the canonical path.** Enumeration at the one site `ts_prop_own_enum`, write suppression at the one site `ts_set`/
   `ts_prop_set`, delete suppression at the one site `ts_prop_delete`. Do not scatter it.
3. **Consistent with shape/PIC (§6).** Choose a data structure that does not conflict with a future extension
   giving `ts_shape_field` attributes.
4. **"Don't silently get it wrong."** Attribute combinations that cannot be modeled (see below) continue to be loud-rejected.
   But **minimize** the scope of rejects (today we reject entire features wholesale).
5. **Backward compatibility.** All existing golden/bench pass unchanged. Do not change the layout of `ts_object`
   (avoid repeating the shape-slot mistake).

---

## 3. Proposed model

### 3.1 Where to put the attribute bits (comparison of 3 options → Option A adopted ← Kaz's decision)

The crux is where to store the per-property 3-bit attributes (enumerable/writable/configurable).

**Option A: add a `uint8_t flags` to `ts_prop`. ← adopted (Kaz's decision: more memory OK, slowdown not OK)**
```c
typedef struct { ts_key key; tsv val; uint8_t flags; } ts_prop;
// flags bits: bit0=enumerable, bit1=writable, bit2=configurable
//   default (a bare property created by a literal/assignment) = 0b111 (all true)
//   so that uninitialized slots and paths where existing code does not write flags mean "all true",
//   set the bit polarity to "set means allowed" (mind the compatibility initialization below).
```
- Pros: **the most straightforward, with no unwrap on the read path** (favorable over Option B on speed = matches Kaz's "slow is not OK").
  Each prop holds its own attributes directly. Accessors stay as the existing `ts_accessor` (minimal change).
- Cons: `ts_prop`, which was 16 bytes (`{key:4, val:8}` = 12 → padding), grows to **24 bytes** with flags+padding
  (key4 + pad4 + val8 + flags1 + pad7). The prop map of a dynamic object grows
  1.5×. **A typed struct (hot path) does not use the prop map, so kernel benches are unaffected**.
  Definitely confirm perf on obj_kernel (heavy dynamic-prop use).
- **The crux of compatibility (most important)**: every path in existing code that creates a `ts_prop` (allocating a new slot via `find_slot`,
  the plain store in `ts_set`, etc.) must **initialize flags to 0b111 (all true)**.
  Otherwise "existing ordinary properties get treated as enumerable:false" and all golden
  break. → Consolidate slot allocation into one site (the `find_slot` family) and always set `flags = TS_PROP_DEFAULT`
  (=0b111) there. Do not rely on `calloc`'s zero-initialization (0 = all false, which is dangerous — the opposite).
- **shape consistency**: when shape is introduced in the future, move the attributes into `ts_shape_field.numeric_mask_or_flags` (reserved in §6.1).
  Until then, the prop holds them directly. Migration is just swapping the flags references in `ts_prop_own_enum` etc. for shape references.

**Option B: push the attributes into a "special value wrapper" (isomorphic to accessors).**
Wrap a data property that has non-default attributes in a `ts_data_desc` heap wrapper.
- Pros: `ts_prop` layout unchanged, minimal memory.
- Cons: **one level of unwrap on the read** of an attributed prop (slightly unfavorable on speed). Since Kaz says "more memory OK,
  slowdown not OK", this con is the deciding factor and it is **not adopted**.

**Option C: a parallel bitmap.** Syncing 2 arrays on every prop add/delete = a hotbed of bugs. Rejected.

→ **Option A adopted (Kaz's decision).** Accept 1.5× memory (dynamic prop only) and put no unwrap on the read
path = speed first. The typed struct hot path is unaffected. Compatibility is guaranteed by consolidating everything into the single point of "always set flags=0b111 when allocating a slot".

> **Design vs shipped (read before §3.2–§3.7).** §3.1 selected **Option A** (attributes in `ts_prop.flags`) and Stage 1 shipped exactly that — see §8. The `ts_data_desc` / `TS_KIND_PROPDESC` value-wrapper mechanism elaborated throughout §3.2–§3.7 (and referenced in §4–§7) is the **Option B** design and was **not** implemented; `ts_data_desc` does not exist in the code. Read §3.2–§3.7 for the descriptor *semantics* to preserve (enumerable/writable/configurable behavior, enumeration order, GC), which the shipped code realizes via `ts_prop.flags` rather than a heap wrapper.

### 3.2 Definition of "default attributes" (note the two different defaults)

JS has **two attribute defaults depending on context**. Confusing them leads to a silent bug like §1.4:

| creation path | enumerable | writable | configurable |
|---|---|---|---|
| literal `{a:1}` / assignment `o.a=1` | **true** | **true** | **true** |
| `Object.defineProperty(o,"a",{value:1})` (omitted) | **false** | **false** | **false** |
| explicitly specified in `Object.defineProperty` | given value | given value | given value |

The correspondence in tsaot's value representation:
- "all true" = **a bare value** (no wrapper). Literals/assignments create this. **As-is**.
- "at least one is false" = a `ts_data_desc` wrapper. The shorthand `{value}` of `defineProperty` has
  **all three false**, so it always becomes a wrapper (this is the fix for §1.4).

### 3.3 Changes to the canonical path (only 3 sites)

**(a) Enumeration `ts_prop_own_enum` (respect enumerable)**
```
if the prop's val is:
  - ts_accessor       -> skip (as-is. a defineProperty accessor defaults to enumerable:false)
  - ts_data_desc      -> cb(key, desc.value) only when desc.enumerable is true
  - otherwise (bare value) -> cb(key, val) (= treated as enumerable:true, as-is)
struct field          -> always enumerable (a class field is enumerable:true). As-is.
```
With this, all 8 paths — `Object.keys`/`values`/`entries`/`JSON.stringify`/`assign`/spread/`object_rest`/
`for-in` (if implemented) — respect `enumerable` in one stroke.

**(b) Write `ts_set`/`ts_prop_set` (respect writable)**
```
an own slot is found and its val is:
  - ts_accessor    -> invoke the setter (as-is)
  - ts_data_desc   -> if desc.writable is true, desc.value = v; if false, NO-OP (sloppy. strict throws, but v1 is no-op)
  - bare value      -> overwrite (as-is)
(accessor lookup along the proto chain is also as-is)
```

**(c) Delete `ts_delete_prop` (respect configurable)**
```
if the own slot is ts_data_desc and desc.configurable is false -> NO-OP the delete (return false. strict throws)
otherwise -> delete as-is
```
Note: `delete obj.prop` is already implemented via `DeleteField` IR → `ts_delete_prop` (verified).
Delete suppression for configurable:false can be honored by adding it at this one site. Note that
configurable also covers "no reconfiguring attributes / no data↔accessor conversion", but v1 honors **only delete suppression**
and defers forbidding re-define (to avoid over-implementing).

**(d) Read `ts_get`/`ts_prop_get` (unwrap the data_desc)**
```
if the slot's val is ts_data_desc -> return desc.value (unwrap)
(accessor invokes the getter as-is)
```

### 3.4 GC

Register `ts_data_desc` as GC kind `TS_KIND_PROPDESC` and add a "mark `desc.value`"
case to `gc_mark` (isomorphic to how an accessor marks its getter/setter).
calloc-allocated, freed by the sweeper. Low risk because it **directly traces the accessor's GC implementation**.

### 3.5 Runtime API

```c
// Define a data property with non-default attributes on an own slot (redefine if it exists).
// When all 3 attributes are true, store a bare value without creating a wrapper (fast path, memory saving).
void ts_define_data(tsv obj, ts_key key, tsv value,
                    int enumerable, int writable, int configurable);
void ts_define_data_dyn(tsv obj, tsv keyv, tsv value, int e, int w, int c); // dynamic-key version

// For getOwnPropertyDescriptor: build and return the descriptor object of an own property
// ({value,writable,enumerable,configurable} or {get,set,enumerable,configurable}).
// undefined if not own.
tsv ts_get_own_property_descriptor(tsv obj, tsv keyv);
```
- `ts_define_accessor` already exists (attributes always default to false). If this design also honors
  "accessor + explicit enumerable", then either add an enumerable bit to `ts_accessor`, or
  extend accessors to hold the same 3-bit attributes as `ts_data_desc` (covered in §3.7).

### 3.6 Changes to the exporter (minimizing rejects)

Rewrite the lowering of `Object.defineProperty(obj, key, desc)` entirely.
When the descriptor is an object literal, classify its members:

```
data descriptor (has value, no get/set):
  e = the specified value of enumerable (false if omitted)
  w = the specified value of writable (false if omitted)
  c = the specified value of configurable (false if omitted)
  -> ts_define_data_dyn(obj, key, value, e, w, c)
     (when e=w=c=true the runtime automatically optimizes to bare-value storage. the exporter does not care)

accessor descriptor (has get/set, no value):
  function-valued form { get: fn } -> closure-ize as-is (accessor_props_design.md, implemented)
  method shorthand { get() {} } -> handled in §3.8 (assign an id in lifting)
  specifying e/c -> pass the attributes to ts_define_accessor (§3.7)

both value and get/set -> continue to loud-reject (a TypeError even per spec, so a correct rejection)
non-literal descriptor -> continue to loud-reject (the form cannot be read statically. dynamic descriptors are a separate task)
enumerable/writable/configurable being a non-boolean-literal (a variable, etc.) -> loud-reject
  (because the value cannot be read statically. `{writable: someVar}` is rare. the dynamic version is a separate task)
```

**This resolves 4 of the current 8 rejects (per-property flags / accessor+attr /
accessor shorthand / value-without-descriptor)**, and the remaining rejects narrow to the **3 legitimate ones**:
"both value+get/set", "non-literal descriptor", and "non-literal attribute value".

### 3.7 Accessor attributes (enumerable/configurable)

At present accessors are always fixed as non-enumerable. Since a `defineProperty` accessor also defaults to
enumerable:false, **this is correct in most cases**. However `{ get: fn, enumerable: true }`
is currently rejected. To honor it, add attribute bits to `ts_accessor`:
```c
typedef struct { ts_gc_header h; tsv getter, setter; uint8_t g_this, s_this;
                 uint8_t enumerable, configurable; } ts_accessor;  // +2 bytes
```
- Change the accessor branch of `ts_prop_own_enum` to "if `enumerable` is true, invoke the getter and
  pass its value to cb" (calling the getter during enumeration is the same behavior as V8).
- **Decision point (needs agreement)**: enumerable accessors are rare. Split into stages: **first complete the data property
  attributes** (§4 stages 1-2), and handle enumerable accessors in stage 3 or continue to
  reject them. Avoid over-implementing.

### 3.8 The accessor method shorthand `{ get() {} }`

The reason it is currently rejected is "lifting does not assign a fn id to `GetAccessorDeclaration`".
The fix is, in the exporter's lifting prepass, to also assign a fn id to
`{ get() {} }`/`{ set() {} }` within a defineProperty descriptor (ObjectLiteral members that have
`ts.isGetAccessorDeclaration`/`isSetAccessorDeclaration`), and closure-ize them the same as the function-valued form.
- Since the method shorthand is **equivalent to a function-expression (`this` = the object)**,
  `g_this/s_this = 1`.
- This is a localized lifting extension. **Decision point (needs agreement)**: defer to stage 3 or do it at the same time.

### 3.9 `Object.getOwnPropertyDescriptor` / `defineProperties`

- `getOwnPropertyDescriptor(obj, key)`: the runtime `ts_get_own_property_descriptor`
  looks at the own slot and builds the descriptor object. data is `{value,writable,enumerable,configurable}`,
  accessor is `{get,set,enumerable,configurable}`, a struct field is
  `{value, writable:true, enumerable:true, configurable:true}` (class-field defaults).
- `getOwnPropertyDescriptors(obj)`: an object collecting the above for all own keys. It needs an internal enum
  that iterates `ts_prop_own_enum` in an "all-own (regardless of enumerable)" variant (a different callback from the one for enumeration).
- `Object.defineProperties(obj, descs)`: repeat the `defineProperty` equivalent for each own property of `descs`.
  Expand it in the exporter (static expansion if descs is a literal, reject if non-literal).
- **Decision point (needs agreement)**: these are stages 2-3. Demand for getOwnPropertyDescriptor is foreseeable, so I'd like to ask about its priority.

---

## 4. Migration strategy (staged — full CI + perf-invariant at each stage)

Each stage is independently committable, gated on full CI green (conformance/ci_fast/unit/correct1,2/perf).
Follows the discipline of `property_model_redesign.md`.

- **Stage 0 (sanitization, upfront)**: decide whether to **first turn into a loud-reject**, or to fix all at once in stage 1, the
  bug (§1.4) where the current `{value}` shorthand misbehaves as enumerable:true.
  → If doing stage 1 right away, stage 0 can be skipped (fixing is better).

- **Stage 1 (data property attributes, core)**: add `ts_data_desc` + kind `TS_KIND_PROPDESC`,
  GC mark, `ts_define_data[_dyn]`, the data_desc branch at the 3 canonical-path sites (enum/set/get, or 4 sites if delete is included),
  rewrite the exporter's data-descriptor lowering (honor false when omitted).
  Verify against V8: `defineProperty({value})` does not appear in `Object.keys`, `writable:false` ignores writes,
  an all-true specification behaves identically to a bare value. **Resolves 2 rejects** (per-property flags /
  value-without-descriptor).

- **Stage 2 (getOwnPropertyDescriptor + defineProperties)**: runtime descriptor construction +
  exporter. Static expansion of literal descriptors.

- **Stage 3 (accessor attributes + method shorthand)**: enumerable/configurable on `ts_accessor`,
  method-shorthand lifting, getter invocation during enumeration of enumerable accessors. **Resolves 2 rejects**
  (accessor+attr / accessor shorthand).

After each stage, the remaining `unsupported` converges to only semantically legitimate ones (both value+get/set, non-literal
descriptor, non-literal attribute value).

---

## 5. Risks and mitigations

- **hot path regression**: `ts_get`/`ts_set` gain one data_desc branch. But only **after finding a dynamic prop
  slot**, and the typed struct field path (direct `->fN` read) does not go through it. Since the accessor's
  `is_accessor()` check is already at the same location and had a track record of being perf-neutral, the isomorphic
  `is_data_desc()` should also be neutral. Confirm on the obj_kernel bench.
- **layout backward compatibility**: the `ts_object` layout is unchanged; as shipped (Option A) `ts_prop` gains a `uint8_t flags` (16→24 bytes), initialized all-true so existing golden
  objects keep behaving as bare values. *(The original "change neither `ts_prop` nor `ts_object`" was the Option-B goal — see the note under §3.1.)*
- **double wrapping**: when the same key is redefined via `defineProperty`, discard the old desc and replace it with the new one
  (no nesting of wraps). Inside `ts_define_data`, look at is_data_desc/is_accessor and
  update in place.
- **GC**: failing to mark a data_desc's value causes UAF. Trace the accessor's implementation and confirm with ASan.
- **enumerable propagation**: for `Object.assign`/spread, copying **only enumerable own** is correct.
  Since it is confined to the canonical `ts_prop_own_enum`, fixing one site makes all paths correct (the design's advantage).

---

## 6. Consistency with shape/PIC (things to keep now)

Follow the constraints of `property_model_redesign.md` §6:
1. Do not change the `ts_object` layout (the shape slot is reserved; this design does not touch it either).
2. For now attributes are held in the `ts_data_desc`/`ts_accessor` value wrappers, but when shape is introduced,
   move them into `ts_shape_field.numeric_mask_or_flags` (reserved). Keep it in a form where it suffices to just swap the canonical path's one "data_desc branch"
   site for a "shape flags reference".
3. Maintain enumeration order = insertion order (`ts_prop_own_enum` already guarantees this). Do not change the order by introducing attributes.

---

## 7. Points to agree on (confirmation for Kaz)

1. **Scope of stage 1**: is it OK to "fix" the existing bug of §1.4 (omitted `{value}` getting enumerable wrong) in stage 1
   (correcting it all at once without going through a loud-reject)? I will confirm there is no applicable case in golden,
   but if something depends on it, the behavior changes.
2. **Option A vs Option B — RESOLVED: Option A adopted** (add `flags` to `ts_prop`, +memory but no unwrap; see §3.1/§8). The Option-B alternative (value wrapper: hot-path-unaffected and layout-invariant, but one heap per attributed prop) was declined because "slowdown is not OK."
3. **Accessor attributes (§3.7) and method shorthand (§3.8)**: is it OK to assume these are deferred to stage 3,
   or, given demand, do you want them included in stages 1-2?
4. **Priority of getOwnPropertyDescriptor (§3.9)**: is stage 2 OK, or if unneeded, defer it or leave it out of scope?
5. **strict behavior of writable:false / configurable:false**: is v1's **no-op** (equivalent to sloppy mode, no throw) OK?
   A strict throw is possible since there is an exception mechanism, but it requires determining the strict context at compile time, and the proposal is that no-op is the safe choice for v1.

(Since the delete path was confirmed to be already implemented via `DeleteField`/`ts_delete_prop`, the original point 6 is resolved.
Delete suppression for configurable:false can be honored by just adding one site there.)

---

## 8. Implementation progress

- **Stage 1 (data property attributes, core) — DONE.** Implemented with Option A (`uint8_t flags` on `ts_prop`).
  - runtime/ts_rt.h: added `flags` to `ts_prop`. `enum { TS_PROP_ENUMERABLE=1, WRITABLE=2,
    CONFIGURABLE=4, DEFAULT=0b111 }` and predicates `prop_is_enumerable/writable/configurable`.
  - runtime/ts_rt.c: consolidated slot allocation into `find_prop` (returns ts_prop*, initializes a new slot with
    `flags=TS_PROP_DEFAULT`=all true). `find_slot` is a thin alias of it (returns &val,
    backward compatible). `ts_set` no-ops the write if the own data slot is writable:false.
    ANDs `prop_is_enumerable` into `prop_enum_data` (takes effect on all 8 enumeration paths in one stroke).
    `ts_delete_prop` no-ops the delete (returns false) if configurable:false.
    Newly added `ts_define_data[_dyn]` (takes e/w/c and sets flags. all-true behaves identically to a bare property).
  - analyzer/emit_c.rs: emits builtin `object.defineData:<e>:<w>:<c>` → `ts_define_data_dyn`.
    (`CallBuiltinStatic` escapes all args to Global, so obj is not eliminated by SROA.)
  - exporter: rewrote the lowering of defineProperty's data descriptor. Honors attributes as **false when omitted**
    (the Object.defineProperty spec; distinct from the all-true of literal `{x:1}`). Attribute values other than boolean-literals
    (`{writable: someVar}`) are loud-rejected (dynamic descriptors are a separate task).
  - **Fixed the existing silent bug of §1.4**: the omitted `{value}` that was treated as enumerable:true and
    appeared in Object.keys is now correctly non-enumerable.
  - **Resolved 2 rejects** (per-property flags / the former of value-without-descriptor). The remaining rejects are
    the 5: both value+get/set, non-literal descriptor, non-literal attribute value, accessor+attr, and accessor
    method-shorthand (the first 3 are legitimate, the latter 2 are stage 3).
  - Verified vs V8: omitted → non-enumerable (`a`) + readable (2), writable:false → write ignored (1), configurable:false →
    delete ignored (false 1) / true → deleted (true undefined), JSON/spread/values respect enumerable, all-true →
    identical to a bare property, non-literal attribute → reject. conf 61/61.
  - **Updated a stale negative test**: removed the "defineProperty
    enumerable:false" line from tests/rejects_bigint_etc.sh (now supported). Accessor-related rejects are left in place.
  - **perf neutral** (ts_prop 16→24byte, but the hot path uses the struct field path and does not use the prop map):
    obj_kernel 207ms (budget 290), typed_field 188ms. All CI green.
  - Added conformance: defineproperty/{data_attrs,writable,configurable,enum_paths}.ts.
- Next: stage 2 (getOwnPropertyDescriptor / defineProperties), stage 3 (accessor attributes +
  method shorthand `{ get() {} }`).

- **Stage 2 (getOwnPropertyDescriptor / getOwnPropertyDescriptors / defineProperties) — DONE.**
  - runtime: newly added `ts_get_own_property_descriptor(obj, keyv)`. An own struct field (class
    instance) is `{value, writable:true, enumerable:true, configurable:true}`, prop-map data
    is `{value,writable,enumerable,configurable}` from slot flags, an accessor is
    `{get,set,enumerable,configurable}` (getter/setter from ts_accessor, e/c from slot flags).
    undefined if not own. `ts_get_own_property_descriptors(obj)` scans all of the struct fields (declaration order) +
    prop-map (insertion order, including non-enumerable and accessors) to build `{key: descriptor}`.
    descriptor-building helpers build_data_descriptor / build_accessor_descriptor / ts_own_descriptor_by_key.
  - emit_c: routes `object.getOwnPropertyDescriptor` / `object.getOwnPropertyDescriptors` to runtime calls.
  - exporter: added getOwnPropertyDescriptor(argc2)/getOwnPropertyDescriptors(argc1) to namespaceBuiltin.
    `Object.defineProperties(obj, {k: desc, ...})` statically expands the object-literal and routes each entry to
    lowerDefineOneProperty (non-literal descriptor map / non-literal key / non-object-literal
    descriptor value are loud-rejected). Factored out defineProperty's single-descriptor logic into the lowerDefineOneProperty
    helper and shared it between both.
  - Verified vs V8: gOPD data (all true) / defined non-enumerable (5 false false false) / nonexistent → undefined /
    accessor (function undefined false true), defineProperties (1 2 3 / keys=a).
- **Stage 3 (accessor attributes + method shorthand) — DONE.**
  - **Important finding**: `{ get() {} }` is parsed not as a GetAccessorDeclaration but as a **MethodDeclaration named "get"**
    (`{ get x() {} }` is a GetAccessor). Taking this into account, fixed the classification (nm==="get"&&
    (PropertyAssignment||MethodDeclaration)), assignIds (assigns fnId to method-shorthand
    get/set within an object-literal), and the free-var seeding walk (adds the same method to allFns). Lift it in lowerClosure
    as this=object (thisParam=true).
  - accessor attributes: refactored ts_define_accessor into ts_define_accessor_attr (takes e/c) and
    stored the attributes in the **slot's flags** (the accessor object holds getter/setter, the slot flags hold e/c;
    the writable bit is unused for accessors). Extended ts_define_accessor_dyn to take e/c, and
    extended emit_c's builtin to `object.defineAccessor:<gThis>:<sThis>:<enum>:<conf>`.
    With this, gOPD correctly reports an accessor's e/c. Honors configurable:true.
  - **enumerable:true is loud-rejected**: the enumeration model (prop_enum_data) always skips accessor slots,
    so it cannot enumerate an enumerable accessor. Honestly reject rather than silently get it wrong (the decision of design §3.7).
    enumerable:false / omitted (default) work correctly.
  - Verified vs V8: shorthand get (42) / shorthand get+set+this backing (7,25,25) / function-valued form (regress 99) /
    gOPD accessor e/c=false / configurable:true honor / accessor default non-enum (keys=a) / enumerable:true → reject.
  - Final state of rejects: what remains is **only 4**: both value+get/set, non-literal descriptor, non-literal attribute value, and
    accessor+enumerable:true (all semantically legitimate or an honest reject at the model's limit).
    From the original 8 rejects, 6 features were resolved via implementation.
  - **Updated a stale negative test**: removed the "defineProperty getter shorthand"
    line from tests/rejects_bigint_etc.sh (now supported). "accessor + enumerable" is left in place.
  - perf neutral (obj_kernel 201ms, typed_field 181ms, all within budget). All CI green, conf 64/64.
  - Added conformance: defineproperty/{get_own_descriptor, define_properties, accessor_shorthand}.ts.
- All stages (1/2/3) of property_descriptors_design.md complete.

- **Stage 3 addendum (enumerable accessor) — DONE.** Implemented
  `Object.defineProperty(o, k, { get..., enumerable: true })`, which was previously an honest reject.
  - The core of the design decision: emitting an accessor's "value" during enumeration requires invoking the getter, but Object.keys
    must not call the getter (V8 doesn't either). So **remove the `!is_accessor`
    condition from prop_enum_data** (decide by the enumerable bit alone) and separate the accessor's value resolution to **the value-consuming callback side**, which calls
    `enum_resolve_value(receiver, stored)` (if an accessor, invoke the getter with this=receiver;
    otherwise the bare value). Object.keys (cb_push_key) does not use the value, so it does not
    call the getter = no side effects. Object.values/entries/JSON/assign/spread/rest do call it.
  - Added `recv` (the source object) to each enum callback's ctx (for the getter's this).
    Added recv to all of enum_arr_ctx / enum_copy_ctx / json_obj_ctx / enum_rest_ctx, and set it at each setup site.
  - console.log (inspect), like Node, **does not invoke** the getter and displays `[Getter]`/`[Setter]`/`[Getter/Setter]`
    (avoiding side effects). Added an accessor branch to cb_inspect_obj_prop.
  - exporter: removed the enumerable:true reject and passes enumAttr to the enum bit of `object.defineAccessor:<g>:<s>:<enum>:<conf>`.
  - Verified vs V8: enumerable accessor → keys(a,x)/values(1,2 getter invoked)/JSON({"a":1,"x":2}),
    non-enumerable accessor default → keys(a) and direct read (9), console.log enum accessor → `{ a: 1, g: [Getter] }`,
    get+set → `[Getter/Setter]`, a class-syntax getter is non-enumerable via the vtable (regression OK: x {"x":1}).
  - **Final state of rejects: only 3** (both value+get/set, non-literal descriptor, non-literal attribute value,
    all semantically legitimate). From the original 8 rejects, 5 features were resolved via implementation, and accessor enumeration is also complete.
  - perf neutral (obj_kernel 206ms, typed_field 188ms). All CI green, conf 65/65.
  - Updated a stale negative test: removed the "accessor + enumerable" line.
  - Added conformance: defineproperty/enumerable_accessor.ts.

- **Stage 4 (dynamic descriptor / resolving the remaining rejects) — DONE.** Resolved all remaining cases where a statically-unreadable descriptor was
  loud-rejected, via a dynamic path with runtime inspection.
  - runtime: newly added `ts_define_property(obj, keyv, desc)`. Inspects the descriptor's own properties
    (value/get/set/enumerable/writable/configurable) at runtime with `ts_has_own`+`ts_get`+`ts_truthy`
    and dispatches to data/accessor. Attributes are **false when the key is absent** (the defineProperty spec).
    Coexisting value+get/set is `ts_throw(TypeError string)` (catchable). The getter/setter's this
    is determined as g_this/s_this from the function's `takes_this` (function-expr → this=receiver, arrow → lexical).
    `ts_define_properties(obj, descs)` iterates each own key of descs via `ts_prop_own_enum` and
    calls `ts_define_property` (cb_define_one/defprops_ctx). It is placed after ts_get_own_property_descriptors
    (a position where ts_prop_own_enum/ts_has_own/ts_get/ts_throw come into scope).
  - emit_c: `object.definePropertyDyn` → `ts_define_property`, `object.definePropertiesDyn` →
    `ts_define_properties` (both void, so a dedicated emit block). `CallBuiltinStatic` escapes all args to
    Global, so obj/descriptor are not eliminated by SROA.
  - exporter: non-literal descriptors (variables, etc.), non-literal attribute values (`{value:1, writable:w}`),
    non-literal defineProperties maps / dynamic entries — rather than rejecting, lower the descriptor object
    as an ordinary expression and route it to the dynamic path. Literal descriptors keep the existing static fast path.
    An empty descriptor `{}` / no value (`{enumerable:true}` etc.) is allowed by synthesizing value=undefined
    (resolving the old reject).
  - Verified vs V8: dynamic descriptor (42 x) / variable attribute writable:false (1) / empty `{}` (true undefined 0) /
    dynamic defineProperties (1 2 a) / value+get TypeError catch / dynamic accessor (fn get+set, 20) /
    dynamic arrow getter (5) / static-literal regression (9 x).
  - **Only 3 rejects remain, all semantically legitimate**: (1) coexisting value+get/set in a literal descriptor
    (loud-rejecting the spec TypeError at compile time; the dynamic form is a runtime TypeError), (2) get/set not being
    a function (`{get:5}`), (3) an unsupported form of get/set. Note that an object literal that puts `{ get(){} }` into a **variable**
    is "an object literal's method member", which is unsupported (a general feature separate from defineProperty).
  - perf neutral (obj_kernel 205ms, typed_field 182ms). All CI green, conf 66/66.
  - Added conformance: defineproperty/dynamic_descriptor.ts.
- **With this, Object.defineProperty / defineProperties / getOwnPropertyDescriptor[s] are implemented completely without gaps,
  covering data attributes, accessor attributes, method-shorthand, enumerable accessor, and dynamic descriptors.**
  All of the original 8 rejects are resolved as either "implemented" or "a spec-legitimate rejection".

## 9. for..in over chains that add no key (Session 361)

`ts_object_for_in_keys` walks the object and each prototype: every own name of the link
(`ts_object_get_own_property_names`), a duplicate test against the names seen so far (a scan
with `ts_strict_eq`), and a descriptor object built per name to read its `enumerable`. vue's
`baseParse` runs `for (key in options)` once per compile, about twenty own keys plus
Object.prototype's names: 17 ms of a 980 ms run (Node: 1 ms), most of it in
`build_data_descriptor` and the field interning behind it.

When the object is a plain object or an array (not a Proxy) and each link of its chain is a
plain object that is not a class instance with struct fields, or an empty array, with no
enumerable string-keyed property (`for_in_link_silent`: Object.prototype, Array.prototype, a
class's prototype, an object made to be a prototype, null), no key comes from the chain and none
is shadowed, so the walk's keys are the object's own enumerable string keys in their order:
`Object.keys`'s list (`ts_prop_own_enum`, integer-like keys first). Any other chain, and an
enumerable key added to a shared prototype (`Object.prototype.x = 1`), keeps the walk.
`TSAOT_FOR_IN_OWN=0` keeps it everywhere. vue's `baseParse` 19.6 -> 5.3 ms. Fixture
`objects/for_in_own_keys` (key order, non-enumerable, accessor and symbol keys, null-prototype
objects, class instances, arrays with holes and named properties, deleted keys, enumerable
prototypes with shadowing, an array as a prototype, keys added to and deleted from
Object.prototype, Array.prototype and a class's prototype, a long loop, keys added during the
walk).
