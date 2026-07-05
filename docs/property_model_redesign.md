# Property Model Redesign — Design Document (Draft for Agreement)

Status: PROPOSAL (pre-implementation, awaiting agreement)
Author: tsaot
Related: object_prototype_design.md, accessor_props_design.md, coerce_design.md

---

## 0. Purpose of This Document

Implementing `in` / `hasOwnProperty` / `Object.hasOwn` / `Object.entries` / `Object.prototype` /
accessors has repeatedly produced bugs. The cause is not the difficulty of the features but the
**structure** of property handling. This document pinpoints that structural cause and designs a
migration to a unified model — minimally invasive, and able to carry PIC in the future. Implementation begins after this design is agreed.

---

## 1. Current Structure (Facts)

### 1.1 Properties Are Stored in 3 Places, With No Unified Interface

| # | Storage location | Access method | enum | accessor | proto |
|---|---------|------------|------|----------|-------|
| 1 | typed struct field (`ClassN->fN`) | direct access via `LoadField`/`StoreField` | ✗ | ✗ | ✗ |
| 2 | prop map (`ts_object.props`) | `ts_get`/`ts_set`/`find_slot` | ○ | ○ | ○ |
| 3 | accessor (`ts_accessor`) | as a value in the prop map, branched inside `ts_get`/`ts_set` | (skip) | ○ | ○ |

- Paths 2+3 (the dynamic path) are cleanly unified in `ts_get`/`ts_set`. **This is good.**
- Path 1 (the optimized path) is a completely separate beast that ignores accessors, proto, and enumeration.
- `class_has_field` / `class_reg_*` (the class descriptor) is a **bolted-on bridge** that makes path-1 objects
  visible to path-2-style operations (`in`/`hasOwn`/enumerate).

### 1.2 The "enumerated class" Optimization-Off Bucket

`compute_enumerated_classes` (emit_c.rs) gathers "classes that flow into JSON.stringify / Object.keys/values/entries /
spread / rest" and, via `local_class.retain(|_,c| !enumerated.contains(c))`,
**disables struct optimization for just those classes** and drops them into the prop map.
- This is a workaround for "optimization (struct) and generality (prop map) cannot coexist."
- It silently breaks on detection gaps (unobservable dataflow, new enumeration APIs).
- e.g., a breeding ground for the same "path holes" as the field-initializer bug (described later).

### 1.3 SROA escape Bolted On Per Symptom

In `interproc.rs`, "operations that demand the object's materialization at runtime" —
`Print` / `HasField` / `HasFieldDynamic` / `BinOp "+"` … — are **added individually each time one is discovered**.
Because the rule for "which operations demand materialization" is not centralized, a new operation is always forgotten.

### 1.4 Actual Bugs These Produced (History)

- `console.log(obj)` returned undefined (Print was not setting escape)
- `"x" in d` returned undefined (HasField was not setting escape)
- `"" + new P()` returned undefined (BinOp + was not setting escape)
- inherited class fields not visible via `in`/`hasOwn` (path 1 was not consulting the descriptor)
- `"toString" in o` returned false (namespace mismatch between method-key and field-key)
- `c.a` is NaN in a class with only field initializers (no ctor) (path hole; a separate bug)

All follow the same pattern: "hand-write the same semantic operation across each of the 3 paths, and forget one of them."

---

## 2. Design Goals

1. Route everything through a **single canonical property operation**. get/set/has/own/enumerate/delete.
2. Perform struct optimization transparently **underneath** the canonical operation (callers are unaware of the optimization).
3. When adding a new feature or new API, there is **exactly one place to touch**.
4. **Abolish** the "enumerated class" escape hatch.
5. Unify SROA escape into a **single rule**.
6. **Zero perf regression** (hold the line at typed_field ~185ms / obj ~205ms).
7. Build a foundation onto which PIC can be **naturally added** in the future (§6).

Non-goals (not this time): implementing PIC itself (but its data structures are finalized here and the foundation prepared, §6),
and full hidden-class-ification of shape.
**The field-initializer bug is folded into this design** (§3.5, because it is closely tied to property handling).

---

## 3. Proposed Model

### 3.1 Make "A Field Always Exists in the prop map" an Invariant

The biggest structural decision: **position the typed struct field as "a cache of the prop map."**
- The canonical truth is the prop map (path 2). The struct field (path 1) is an unbox-accelerated **projection** of part of it.
- With this, enumeration, has, accessors, and proto are all served by a **single prop-map-based implementation**.
- struct access is an optimization that reads the offset directly, on the premise that "a corresponding slot always exists in the prop map."

Done naively, though, "hold a prop map separately from the struct" = double memory and double writes,
killing perf. So proceed incrementally: first **unify the semantics (the canonical path)**, and shape the optimization as
"read the struct directly, bypassing the prop map, only when it can be proven" (§3.3).

### 3.2 Canonical Property Operation API (runtime)

Every path calls one of these 6 functions. The implementation lives in **one place**:

```
tsv  ts_prop_get(tsv obj, uint32_t key);              // get (fires accessors, includes proto walk)
void ts_prop_set(tsv obj, uint32_t key, tsv val);     // set (accessor, proto, own creation)
int  ts_prop_has(tsv obj, uint32_t key);              // `in` (includes proto walk)
int  ts_prop_has_own(tsv obj, uint32_t key);          // hasOwn (own only)
int  ts_prop_delete(tsv obj, uint32_t key);           // delete
// enumerate: hand each own enumerable data key in order via callback (shared by keys/values/entries/JSON/dir/assign/spread)
void ts_prop_own_enum(tsv obj, void (*cb)(uint32_t key, tsv val, void* ud), void* ud);
```

- These process "struct field (via descriptor) → prop map → accessor → proto chain"
  **in the correct order, exactly once**.
- The existing `ts_get`/`ts_set` become thin aliases of `ts_prop_get`/`ts_prop_set` (backward compatibility).
- The enumeration family (`ts_object_keys/values/entries`, `json_stringify`, `inspect`, `assign`,
  `copy_props`, `object_rest`) all just call `ts_prop_own_enum`
  → the enumeration logic currently scattered across 35 sites is consolidated into one place.
- `is_object_proto_name` (the `in` special case for well-known names) is also closed inside `ts_prop_has` in one place.

### 3.3 struct Optimization: Direct Reads "Only When Provable"

Direct struct access via `LoadField`/`StoreField` (`->fN`) happens only when the following can be **statically proven**:
- `obj`'s class is determined (`local_class`), and
- that class is **stable** (no runtime proto mutation / dynamic this-write), and
- the field is determined to be an own/inherited data field of that class (not an accessor).

If these conditions are not met, fall back to `ts_prop_get`/`ts_prop_set` (the canonical path).
- Tighten the current `field_path` + `local_class` decision to these 3 conditions.
- **Abolish `enumerated_classes`**: because enumeration sees struct fields via the canonical path,
  "stop using struct because it gets enumerated" becomes unnecessary. The enumeration family calls
  `ts_prop_own_enum`, which enumerates struct fields via the class descriptor.
- This makes "`Object.keys` works correctly even on a struct-optimized class."

### 3.4 A Single Rule for SROA escape

Make "**an operation that passes an object to the canonical path (`ts_prop_*`) causes that object to escape**"
a **single classification function** in interproc.rs:

```
fn op_forces_materialization(inst) -> &[LocalId]  // returns the operands that demand materialization
```

- Enumerate Print / HasField / HasFieldDynamic / BinOp("+") / LoadFieldDynamic / StoreFieldDynamic /
  CallBuiltin(enumeration family) … in this one function. A new operation just adds one line here.
- "LoadField/StoreField that can read the struct directly (meeting the §3.3 conditions)" do not demand materialization
  (they remain SROA-able). Everything else demands it. The rule is **consistent** between escape analysis and the optimization condition.

### 3.5 Correct Construction of Field Initializers (`class C { a = 1 }`)

**Current bug (fact-verified)**: the exporter's `new C()` lowering (exporter.ts ~434)
calls the explicit constructor `${classId}:ctor` if present, but **does not lower the field initializers
(the `a = 1` initializer expressions) into any code path**. They are recorded in `ownFields`
(for layout) but the initializer expressions are discarded. As a result, in a class with no explicit ctor,
`c.a` ends up uninitialized (NaN/undefined). This is a gap in property handling itself, and is
folded into this redesign.

**JS semantics**: field initializers run at construction time.
- With an explicit ctor: each initializer `this.f = <init>` runs in declaration order **immediately after** the
  `super(...)` call (or at the **top** of the ctor body if there is no super).
- Without an explicit ctor: the implicit ctor runs `super(...args)` (when inheriting) plus the initializers.
- Initializers are ordinary property writes on `this` = they should go through **the same path as the canonical `ts_prop_set`**
  (for numeric fields, the direct struct-write optimization applies).

**Design**: in class-extract, collect each class's "field initializer list"
`[(field_id, initializer_expr_node)]` (in declaration order, only those with initializers).
Unify the exporter's construction lowering as follows:

- At the IR level, prepare a "synthetic prologue that runs the initializers" and always run it at
  construction time regardless of whether a ctor exists. Concretely there are 2 options, and we want agreement (§7-6):
  - **Option A**: insert the initializers' `StoreField` sequence at the top of the explicit ctor body (immediately after the
    super call). If there is no explicit ctor, synthesize an implicit ctor function containing only the initializers. `new` always calls a ctor.
  - **Option B**: on the `new` lowering side, emit the initializers' `StoreField` sequence immediately after AllocObject
    (after the parent ctor runs, when inheriting), and then call the explicit ctor (if any) afterward.
  - The recommendation is **Option A** (it most faithfully reproduces JS's evaluation order — super→initializers→ctor body —
    and naturally handles inheritance, super, and this-referencing initializers).
- In either case, the initializer writes use `StoreField` (canonical path, or direct struct-write when provable).
  This routes "initializers, ctor assignments, external assignments" all through the same property path,
  riding on the §3.1/§3.3 invariants (path holes disappear in principle).
- The case of referencing `this.other` inside a field initializer works naturally under declaration-order evaluation.

**Verification**: compare against V8 for `new C().a` of `class C { a = 1; b = 2 }`, inheritance with initializers,
initializers coexisting with an explicit ctor, and initializers referencing other fields/methods. Add goldens.

### 3.6 Unified Key Space (V8-style tagged key) and Accommodating Symbol/Index (implement later, design now)

**V8 facts (researched)**: V8 splits properties into 3 categories (per reference material):
1. **elements** (integer-indexed: `arr[0]`, `obj[5]`) — contiguous backing store, direct index access, ascending enumeration.
2. **named string key** (`obj.x`) — a descriptor of the hidden class.
3. **named symbol key** (`obj[sym]`) — likewise a descriptor. A Symbol is not a String but a unique heap object in the `Name`
   family. `Symbol("x")` and `"x"` are different keys. There are well-known/`Symbol.for`/private symbols.
Keys are not a "range partition of a single id space" but a **tagged key** (`enum { String(id) | Symbol(id) }` +
elements managed separately). → **The old §3.6 range-partition proposal is withdrawn** in favor of this.

**tsaot's key design (finalized)**: make property keys a **tagged key with 3 orthogonal kinds**.
Each id space is independent and does not compete with the others (a structural answer to Kaz's "is 32 bits enough?": because they are separated, it is enough).

```
PropertyKey (tsaot):
  ├─ Index(uint32_t)    // integer-indexed. array elements / numeric keys of plain objects.
  │                     //   not id-ified = the integer value itself. JS array index goes up to 2^32-1. no exhaustion concept.
  ├─ String(StringId)   // named string key (method names are also String). compile-time interned, independent 32bit.
  └─ Symbol(SymbolId)   // named symbol key. runtime-assigned, independent 32bit. well-known are also reserved ids in the Symbol space.
```

The physical representation is finalized as a **64-bit tagged key** (`ts_key = uint64_t`):
```
// single definition in ts_rt.h (the analyzer references this constant at emit time, resolving the METHOD_KEY_BASE double-definition)
//   high 8 bits = tag, low 32 bits = id (the middle is reserved)
enum ts_key_tag { TS_K_STRING=0, TS_K_SYMBOL=1, TS_K_INDEX=2, TS_K_WKSYM=3 /* well-known symbol */ };
//   ts_key_make(tag,id) / ts_key_tag(k) / ts_key_id(k)
//   ts_key_is_string(k) / ts_key_is_symbol(k) / ts_key_is_index(k)
//   ts_key_is_enumerable_data(k): enumeration targets (string data + index). method/symbol/accessor follow separate rules.
```
- Extend `ts_prop.key` to `ts_key` (64bit). **Cost = the prop map key of dynamic objects goes 4→8 bytes**.
  A typed struct (hot path) accesses struct fields directly without the prop map, so it is **unaffected**.
  Method names are in the String range (the old METHOD_KEY_BASE equivalent is reorganized as a sub-rule of tag=STRING or a separate tag).
- Consolidate the scattered `key >= METHOD_KEY_BASE` comparisons and `field_enumerable` into `ts_key_*` predicates.
  When changing the treatment of Symbol/Index in the future, only the inside of the predicates is touched.

**Relationship to struct optimization (answer to Kaz's question "is lowering into a struct a problem?": no problem)**:
- What lowers into a struct is **only static fields with a String key**. This is already separated at the IR level
  (demonstrated: `c.x`→`LoadField{field=StringId}`, `o[i]`→`LoadIndex`, `o[sym]`/dynamic→
  `LoadFieldDynamic`). `field_path`/`own_fields`/`ts_class_field.name_id` were String ids to begin with.
- Therefore, even after tagging, struct optimization's key resolution **just uses the String range and needs no change**.
- To Stage B's "direct struct read when provable" trigger condition, just add one more: "**and the key is in the String range**".
  Symbol/Index keys automatically fall back to the canonical path (prop map / elements).
  → Isomorphic to V8's "in-object slot is named string, symbol is descriptor, index is elements."
- shape's (§6) `ts_shape_field.key` is also `ts_key`. struct field=`{String(id),data-in-struct,offset}`,
  symbol prop=`{Symbol(id),data-in-propmap}`, index=on the elements side. It can hold the 3 kinds distinctly.

**Critical bugs (holes present already; independent of tagging but closed by this redesign)**:
- `c["x"]=v` (a dynamic string key with the same name as a struct field) **writes to the prop map without updating the struct field,
  disagreeing with `c.x` (direct struct read)** (demonstrated: AOT `undefined`, V8 `99`).
- A plain object's numeric key `o[0]=v` is misrouted to `StoreIndex`→`ts_array_set` (the array path) and
  **breaks completely** (demonstrated: AOT `undefined`, `Object.keys` empty; V8 `a`, `0,5`).
- Both are closed by §3.1's "the canonical path `ts_prop_set` dispatches in one place by struct descriptor and key kind."
  For a String key, write the offset if it is a struct field, otherwise the prop map. For a plain object, Index goes to the
  prop map (an Index key equivalent to the string "N"; the array's fast elements path is kept separate = **Option I-B, agreed**).

**well-known symbol id assignment table (finalized, reserved. tag=WKSYM)**:
| symbol | wksym id | current disguise string |
|--------|----------|------------------|
| Symbol.iterator | 0 | `@@iterator` |
| Symbol.asyncIterator | 1 | `@@asyncIterator` |
| Symbol.toPrimitive | 2 | (none yet) |
| Symbol.hasInstance | 3 | (none yet) |
| Symbol.toStringTag | 4 | (none yet) |

**User Symbol runtime representation (design only; implementation is a separate task. Conforms to the §8 design in the reference material)**:
```
typedef struct { ts_gc_header h; uint32_t sym_id; uint32_t flags; tsv description; } ts_symbol;
//   flags: well_known / in_public_registry / private_kind(Public/Internal/FieldName/Brand)
//   typeof -> "symbol"; a===b is sym_id (=heap identity) equality; obj[sym] uses
//   ts_key_make(TS_K_SYMBOL, sym->sym_id) as the key for ts_prop_set.
//   Symbol.for(desc) is a global desc->sym_id registry (separate task).
//   a private symbol (a class private field #x) will ride the same mechanism via private_kind in the future.
```

**Relationship to the stages**: Stage A-2 finalizes `ts_key` (tagged), consolidates predicates, finalizes the WKSYM table, and makes `ts_prop.key` 64-bit
(no Symbol/Index implementation, but the contract and physical representation are fixed). The I-B-ification of plain-object numeric keys and
resolving the `c["x"]` duplication happen in Stages A–B (canonical-path unification). The well-known `@@iterator`→`WKSYM` migration is Stage D.
User Symbol implementation, `typeof`, `Symbol.for`, and private symbols are a **separate task** (this section guarantees that, at that time, `ts_prop_*`/
shape/struct optimization need not be rebuilt).

**(C0) Immediate soundness fix (done ahead)**: turn silently-wrong paths into loud rejects.
`o[Symbol.iterator]=fn` (empty-output misbehavior) / generator `*[Symbol.iterator]` (runtime failure) /
`Symbol(...)`/`Symbol.for(...)`/using a Symbol as a value (undefined call) / a plain object's
numeric key (misbehavior from array misrouting) → all are explicitly rejected, or rejected until staged implementation. The "never silently wrong" principle.

## 4. Migration Strategy (staged, behavior-invariant at each stage + full CI + perf)

Each stage must be independently committable and must make all tests green on its own.

- **Stage A (unify semantics, behavior-invariant)**
  - **Finalize the key space `ts_key` (§3.6, V8-style tagged key)**: resolve the `TS_METHOD_KEY_BASE` double-definition and
    add tagged keys (tag=String/Symbol/Index/WKSYM + 32bit id, physically 64-bit `ts_key`) +
    the `ts_key_make`/`ts_key_tag`/`ts_key_is_string`/`is_symbol`/`is_index`/`is_enumerable_data`
    predicates to `ts_rt.h`. Extend `ts_prop.key` from `uint32_t`→`ts_key` (64bit). Consolidate the scattered
    `key >= METHOD_KEY_BASE` comparisons and `field_enumerable` through these predicates. Reserve the Symbol/Index/WKSYM
    ranges (do not implement Symbol). Finalize the WKSYM assignment table. **Behavior-invariant at this point**
    (verify across all goldens that String/method key resolution results are unchanged. prop map memory grows
    4→8 bytes for dynamic objects only, the typed struct hot path is unaffected → confirm perf).
  - Add `ts_prop_get/set/has/has_own/delete/own_enum` to the runtime.
  - Their bodies port + integrate the current `ts_get`/`ts_set`/`ts_has_prop`/`ts_has_own` logic
    (unified so that get/set/has also consult the struct descriptor).
  - Rewrite the 6 enumeration sites to go through `ts_prop_own_enum`.
  - Alias `ts_get`/`ts_set`. **Confirm that existing goldens/CI/perf are all green at this stage.**
  - **PIC foundation**: reserve one word for a shape slot in `ts_object` (A-1 done).
  - Expectation: behavior is completely invariant except for the field-initializer bug. Because struct fields become visible
    to get/has, the `class_has_field` individual patch can be removed.

- **Stage B (tighten the optimization condition)**
  - Tighten the typed-path trigger of `LoadField`/`StoreField` to the 3 conditions of §3.3.
  - Remove the `enumerated_classes` mechanism (delete `compute_enumerated_classes` and the `retain`).
  - Because the enumeration family sees struct fields via the canonical path, enumerated classes can stay as structs too.
  - **Hold perf strictly**: the typed_field/obj kernel must not worsen. If anything, since enumerated suppression
    decreases, some improvement is possible. If it worsens, adjust the conditions.

- **Stage C (centralize the escape rule)**
  - Introduce `op_forces_materialization` and replace the individual escape additions in interproc.rs.
  - Verify with goldens that it **matches the existing escape behavior exactly** (especially Print/in/+/console.dir).

- **Stage D (cleanup)**
  - Delete/tidy the parts of `class_has_field` / `class_reg_field_*` that were absorbed into the canonical path.
  - Migrate well-known symbols from the string disguise `@@iterator` to the `TS_KEY_WKSYM` reserved ids (§3.6).
    Verify behavior invariance (the same iterator is found) with goldens.
  - Update docs, reflect in TODO.

- **Stage C0 (immediate soundness fix — loud-reject Symbol's silent misbehavior)**: can be done **ahead**,
  independent of the stage ordering. Turn the 3 points of §3.6 (C) (`o[Symbol.iterator]=fn`'s empty-output misbehavior / generator
  `*[Symbol.iterator]`'s runtime failure / the undefined call of `Symbol(...)` etc.) into
  loud rejects. Immediate application of the "never silently wrong" principle. Add negative tests.

- **Stage E (field initializers, §3.5)**
  - Add initializer-list collection to class-extract. Unify `new`/ctor lowering with Option A.
  - Because the canonical path is settled by Stages A–D, initializer writes ride that path naturally.
  - Add goldens (initializers only / inheritance / coexisting ctor / this references). V8 comparison required.

After each stage: ci_fast + 3 bench shards (individually) + ASan + representative V8 comparison. zip + fresh-extraction verification.

---

## 5. Risks and Mitigations

- **R1 perf regression**: the biggest risk. If the typed path narrows wrongly in Stage B, the kernel slows down.
  Mitigation: perf bench required at each stage. Adjust the trigger condition with a floor of "at minimum preserve the cases
  that are currently struct-ified." typed_field **reliably** meets the 3 conditions of §3.3, so its direct read continues.
- **R2 behavior regression**: unifying get/set/enumeration breaks edge cases (accessor + inheritance + numeric field).
  Mitigation: position Stage A as a "behavior-invariant refactor" with all existing goldens green as the gate.
- **R3 the double-storage trap**: we described "the struct field as a cache of the prop map," but actually holding memory in both
  is slow. Mitigation: in Stage A, do **not** add a prop map; the canonical path reads the struct
  via the descriptor (reusing the current class_reg_field_value in get/has/enum). Do **not** double-hold prop map and
  struct. Reconsider when introducing shape with PIC in the future (§6).
- **R4 GC**: GC during the enumeration callback moves the base pointer. Mitigation: as in the existing implementation,
  consolidate the pattern of re-fetching `ts_ptr(obj)` after each push into the canonical path.
- **R5 scope creep**: the temptation to touch 8000 lines. Mitigation: adhere strictly to the stages, and do not include the field-initializer bug or
  PIC in this task.

---

## 6. Connecting to PIC and Pre-finalizing Data Structures (where design mistakes reverberate)

The essence of PIC (polymorphic inline cache): cache the **shape → offset** observed at runtime for `obj.x`
near the call site, and on the next same-shape access, direct-access with 1 to a few branches. This redesign's
`ts_prop_get/set` are the insertion points. It does not ride on top of today's "decide struct or prop map at compile time" structure.
Below, we define the **data structures that should be finalized now** (implementation is a separate task, but
we guarantee that this redesign's runtime/IR does not conflict with them).

### 6.1 Shape (hidden class) — the shape of an object

Give every object a "shape id." A shape is an immutable descriptor representing "the key set + each key's
kind (data/accessor) + where the data is stored (struct offset or prop slot)."

```
typedef uint32_t ts_shape_id;          // reserve 0 = "no shape" (legacy/dynamic)

typedef struct {
  ts_key   key;                        // unified key (§3.6: opaque 32bit including field/method/wksym/user-symbol)
  uint16_t kind;                       // 0=data-in-struct, 1=data-in-propmap, 2=accessor
  uint16_t slot;                       // kind=0: struct field index / kind=1: prop slot reserved
  uint32_t offset;                     // kind=0: byte offset within the struct (includes unbox decision)
} ts_shape_field;

typedef struct ts_shape {
  ts_shape_id   id;
  uint32_t      nfields;
  ts_shape_field* fields;              // declaration order (enumeration order = JS insertion order)
  struct ts_shape* parent;             // the shape before adding 1 field (the transition parent)
  /* transition: cache of child shapes generated by adding a key (small linear or hash) */
  uint32_t      ntrans; ts_shape_trans* trans;
  uint8_t       numeric_mask_or_flags; // future extension (e.g. frozen, has-accessor)
} ts_shape;

typedef struct { uint32_t key; ts_shape* to; } ts_shape_trans;
```

- A **stable class** has one fixed shape at construction time (= the current class descriptor promoted to
  a shape. `ts_class_field` becomes `ts_shape_field` almost as-is).
- A **dynamic object** (whose shape grows via `{}`/`obj.x=...`) starts from the empty shape and, on each key addition,
  follows `trans` (generating it if absent) to transition to a child shape. Objects that add the same keys in the
  same order **share the same shape** (the crux of hidden-class).
- Add one `ts_shape* shape` (or `ts_shape_id`) field to `ts_object`.
  → **In Stage A of this redesign, reserve this one word in `ts_object` now**
  (place it in the struct even if unused). Because changing the struct layout later ripples into the
  offset calculation of all struct classes, **this is the most critical "where design mistakes reverberate" point**.

### 6.2 Inline cache (call-site side)

Give each property access site (`LoadField`/`StoreField` codegen) a small IC:

```
typedef struct {
  ts_shape_id shape;     // the observed shape (0 = empty/unobserved)
  uint32_t    offset;    // the struct offset valid then (data-in-struct only)
  uint8_t     kind;      // the fast-path kind on hit
} ts_ic_entry;

/* monomorphic: one ts_ic_entry. polymorphic: a small array (N~4) + megamorphic on overflow. */
```

The form codegen emits (conceptual):
```
if (LIKELY(obj->shape->id == IC.shape)) {  v = ((Class*)obj)->@(IC.offset);  }   // monomorphic hit
else { v = ts_prop_get_ic(obj, key, &IC); }                                       // miss -> canonical + IC update
```
- `ts_prop_get_ic` is §3.2's canonical `ts_prop_get` plus "IC filling on miss."
- Stage B's "direct read when statically provable" is the **special case where this monomorphic hit could be
  statically determined**. PIC generalizes it to "observe and determine at runtime." **The design is completely continuous.**

### 6.3 Constraints so This Redesign Does Not Conflict With That Foundation (to observe now)

1. **Reserve** one word for a shape slot in `ts_object` **in Stage A** (may be unused). Secure layout backward compatibility.
2. Keep the class descriptor (`ts_class_field`) structure **in a form that extends straightforwardly** to §6.1's `ts_shape_field`
   (holding key/kind/offset). Make the `ts_class_reg` that we now turn into a named struct able to evolve into
   `ts_shape` in the future.
3. Keep the canonical-path `ts_prop_*` signatures with key unified as `uint32_t` (the internField space), so a PIC version
   (`*_ic`) can be added later (already unified).
4. Guarantee enumeration order = insertion order (the shape's fields order) on the canonical path → enumeration stays stable even after PIC.

Order: this redesign (up to reserving the shape slot) → (separate task) shape transitions + IC implementation.

---

## 7. Agreements (Kaz's answers already reflected)

1. ✅ "The canonical form of a field is the unified operation; struct is a direct-read optimization when provable" (§3.1, §3.3).
2. ✅ The Stage A–E order, with each stage's "behavior-invariant + all CI green" as the gate.
3. ✅ Remove `enumerated_classes` (§3.3, Stage B).
4. ✅ **Fold the field-initializer bug into this task** (§3.5, Stage E; closely tied to property handling).
   PIC itself is a separate task, but **the data structures (shape / IC) are finalized in this design, and in Stage A
   one word for a shape slot is reserved in `ts_object`** to prepare the foundation (§6).
5. ✅ The perf floor is **the same level as before**: cap at typed_field ~185-190ms / obj ~205-210ms /
   int ~390-400ms / float ~250ms / and the current values for the rest. Hold zero regression at each stage.

### Remaining Confirmations (decided during implementation, or up front if agreed)
- §7-6: field-initializer lowering proceeds with **Option A** (top of explicit ctor / synthesize implicit ctor).
  Change if there are objections.

### Handling of Symbol / Key Space (agreed: V8-style tagged key + I-B)
- Current state: no Symbol representation in the runtime. `[Symbol.iterator]` is only syntactically matched on class methods
  and disguised as the string `@@iterator`. `Symbol()`/`o[sym]`/generator `*[Symbol.iterator]` are
  unimplemented / silently misbehave. **In addition, a plain object's numeric key `o[0]=v` is misrouted to the array path and
  breaks**, and the hole where `c["x"]=v` duplicates with a struct field is also demonstrated (§3.6).
- Decision (reflecting Kaz's V8 research): withdraw "range partition of a single space" for keys and finalize on a **V8-style tagged key**.
  3 orthogonal kinds (Index / String / Symbol) + WKSYM reserved, physically 64-bit `ts_key`, each id space
  independent and non-competing. This is the structural answer to "is 32 bits enough?" (because the spaces are separated, it is enough).
- **Coexistence with struct optimization is confirmed** (§3.6): what lowers into a struct is only String-key static sites and
  is already separated at the IR level. Just add one "key is String" to the trigger condition. Symbol/Index go to the canonical path.
  shape also holds the 3 kinds distinctly via `ts_key` → consistent with PIC (isomorphic to V8's elements/named separation).
- A plain object's numeric key is **Option I-B** (handled in the prop map; the array's fast elements path is kept separate.
  Agreed that "there is no demand to treat plain objects as arrays = it can be slow").
- Implementation is a separate task (user Symbol assignment, `typeof`, `Symbol.for`, private symbols). This design guarantees
  "that, at that time, `ts_prop_*`/shape/struct optimization are not rebuilt." Immediate loud reject (C0) goes ahead.

---

## 8. Appendix: Speeding Up Bench Runs (separate matter, done)

`scripts/run_benchmarks.sh` was recompiling `ts_rt.c` (~2100 lines) with `-O2` for every bench
(60+ times). Because the sandbox is **single-core (nproc=1)**, parallelization is ineffective
(it can worsen due to context switching). Instead, changed it to **compile `ts_rt.c` into
`ts_rt.o` just once before the loop, and each bench links that**. The correct1 shard was
shortened ~130-200s → ~65s (measured; correctness/perf invariant). Each stage's verification in this redesign gets faster.


---

## 9. Implementation Progress

- **Stage A-1 (reserve shape slot) — DONE**: added `uint32_t shape` (§6) to `ts_object`.
  gc_alloc zero-initializes via calloc, heap structs via ts_new_sized are also 0, and added explicit `shape=0` initialization to the stack-alloc path
  (emit_c.rs sobj). Because it is offsetof-based, struct classes'
  field offsets are automatically recomputed with no impact. All CI green, perf neutral (typed_field 181ms, obj 203ms,
  int 380ms — no regression). Benches are already shortened to ~65s for correct1 via ts_rt.o sharing (§8).
- Next: Stage A-2 (add the canonical path ts_prop_*, unify the enumeration family).

- **Stage A-2a (consolidate key-kind predicates) — DONE**: added `ts_key_is_method` /
  `ts_key_is_enumerable_field` to the runtime and consolidated the scattered `key >= TS_METHOD_KEY_BASE` comparisons
  (the 3 sites field_enumerable / copy_props / object_rest) through them. The key space's
  range knowledge is closed in one place, limiting the places to touch for future tagged-key-ification (Index/String/Symbol, 64bit).
  The type stays uint32_t; **behavior is completely invariant** (verified enumeration goldens match by direct comparison with the JS ref,
  ci_fast green, perf neutral typed_field 182ms / obj 203ms).
  Also made run_golden_iter.sh share ts_rt.o (all 40 goldens complete in ~83s; previously timed out).
- Next: A-2b (add the `ts_prop_get/set/has/has_own/own_enum` canonical path, unify the enumeration family),
  A-2c (make `ts_prop.key` a 64-bit `ts_key`, introduce the tagged tag, reserve Index/Symbol/WKSYM).

- **Stage A-2b-1 (the canonical get/set consult struct fields) — DONE**: added
  class_field_lookup/struct_field_get/struct_field_set to ts_get/ts_set, unified so that if the key is a struct field of a typed class
  instance, it direct-reads/direct-writes the offset (bridging the optimized struct store and
  the dynamic prop map store). Also fixed interproc.rs's LoadFieldDynamic/StoreFieldDynamic to
  escape obj (dynamic key access demands materialization).
  → Resolved the 2 current bugs: `c["x"]=v` (a dynamic string duplicating with a struct field), and objects vanishing via SROA
  into undefined when dynamic access is the only use — both now match V8 (dbl/dr tests).
  All CI green (runtime/golden40/ci_fast/correct1/correct2). perf: typed_field 186ms,
  obj_kernel ~218ms (the hot loop keeps full SROA, machine code unchanged = single-core measurement variance; within the 290 budget).
- Next: A-2b-2 (unify the 6 enumeration sites into ts_prop_own_enum, remove the class_has_field individual patch),
  A-2c (make ts_prop.key a 64-bit ts_key, introduce the tag).

- **Stage A-2b-2 (unify the enumeration family) — DONE**: added a single canonical enumeration function
  `ts_prop_own_enum(obj, cb, ud)` (visits struct fields in declaration order → prop map data props
  in insertion order, GC-safely re-resolves obj, the caller is responsible for rooting). Rewrote all 8 enumeration sites
  (Object.keys/values/entries, JSON.stringify, console inspect, Object.assign, object spread,
  object rest) into callbacks going through it. The scattered "walk struct descriptor +
  prop map by hand twice" code is consolidated into one place, removing the `class_has_field` individual patch and
  inspect's class-instance/plain-object double branch.
  → All CI green (runtime/golden40/ci_fast/correct1/correct2), perf neutral (typed_field 181ms,
  obj_kernel 202ms). Confirmed V8 match for keys/values/entries/JSON/assign/spread/
  rest/inspect on both plain objects and class instances.
  Known minor non-support (unrelated to A-2b-2, pre-existing): console.log(classInstance) prints `{ ... }` against V8's
  `ClassName { ... }` (class-name prefix not shown). Handled separately.
- Next: A-2c (make ts_prop.key a 64-bit ts_key, introduce the tag, reserve Index/Symbol/WKSYM).

- **Stage A-2c-1 (introduce the ts_key abstraction and tag, centralize METHOD_KEY_BASE) — DONE**: defined the
  `ts_key` (uint32_t) type, `enum ts_key_tag{STRING/SYMBOL/INDEX/WKSYM}`, `TS_METHOD_KEY_BASE`, and the
  `TS_KEY_METHOD(id)` macro in ts_rt.h (single source). Resolved the METHOD_KEY_BASE double-definition in runtime/emit_c.rs,
  and emit stops hardcoding `1000000u + id` and outputs `TS_KEY_METHOD(id)`. Unified the runtime's key-related
  signatures (ts_get/ts_set/has/has_own/delete/define_accessor/find_slot/class_field_lookup etc.) from
  uint32_t→ts_key. Because the STRING tag keeps the current values as-is, **behavior is completely invariant**
  (TS_KEY_METHOD(id)=1000000+id, identical values). All CI green, perf neutral (typed_field 182ms, obj 209ms).
  The Symbol/Index/WKSYM tags are reserved (unused). Physical 64-bit-ification is split into a separate step (A-2c-2) that widens prop.key
  when implementing Symbol/Index (since making it 64-bit now would only increase memory with zero gain).

### Existing Bug Discovered (unrelated to A-2c, needs fixing)
- `const c = new C(); c.x` (reading a field immediately after construction within the same function) is **NaN/undefined**.
  Cause: LoadField has an unknown local_class (the class did not propagate via Copy) → falls back to ts_get.
  Meanwhile, when that is the only use, the object is erased via SROA, becoming ts_get(undefined).
  It occurs even with an explicit ctor. Goldens go through this.field (inside methods) or for-of, so they do not hit this
  path and slipped through.
  → Closed by Stage B (tightening the direct-struct-read trigger = propagate local_class via Copy + canonical path only when unprovable)
  and Stage C (escape obj on LoadField fallback). Or extend collect_local_class so that local_class
  follows Copy/Phi. Close to the field-initializer bug (Stage E).

- **Stage B (tighten struct optimization, remove enumerated_classes) — DONE**
  - **Remove enumerated_classes**: in fact, once A-2b unified enumeration into ts_prop_own_enum (descriptor-aware),
    enumerated_classes was invalidated to the empty set and compute_* had become dead code.
    This stage removes it completely: deleted the compute_enumerated_classes function, removed passing the enumerated parameter through
    emit_class_layout/descriptors/field_chain/emit_function, and removed the local_class.retain
    no-op. Enumerated classes now get struct-optimized too (JSON/keys/spread see struct fields via the canonical
    path), eliminating the escape hatch of giving up optimization.
  - **Tighten the direct-struct-read condition**: introduced a new helper `struct_direct_offset(c, field, classes)`, so that
    `->fN` direct access via LoadField/StoreField fires only when "class known + **stable** + field resolves to a struct
    slot." Unstable classes fall back to the canonical path (ts_get/ts_set, which in A-2b read struct fields
    via the descriptor). The trigger condition is consolidated into one place, as designed in §3.3.
  - Verification: all CI green (runtime/golden40/ci_fast/correct1/correct2). perf neutral (typed_field 187ms,
    obj_kernel 204-221ms = measurement variance, inherit 82ms — hot classes are all stable, so direct struct reads are
    kept, no regression). enmig (classes flowing into JSON/keys get struct-optimized) also matches V8.

### [Correction] The local_class bug "discovered" in A-2c does not actually exist
  The A-2c record's "const c = new C(); c.x is NaN" was **an artifact of a stale analyzer binary**.
  On re-verification with a clean build, SROA works correctly including copy-alias resolution, and `new C().x` with an explicit ctor
  / combined with methods all match V8 (m2=hi 1, m3=1). The remaining `0`/NaN is **only the known bug of
  field-initializers-only (no ctor) (Stage E)**. The local_class fix in Stage B was unnecessary
  (collect_local_class propagated Copy to begin with, and SROA also resolved aliases). Recorded as an honest correction.

- **Stage C (make SROA escape a single rule) — DONE**: centralized the "materialization escape" scattered across interproc.rs
  (appending `C::Copy(Ref::Global, ..)` per symptom) into a single classification function
  `op_forces_materialization(inst) -> Vec<LocalId>`. It returns the operands of "operations that pass an object to a path where the
  runtime reads the materialization (a heap object)": Print (inspect) / BinOp"+"
  (forces toString) / HasField/HasFieldDynamic (the structural walk of in/hasOwn) / LoadFieldDynamic/
  StoreFieldDynamic (dynamic key access) / ObjectCopyProps (spread enumeration) / StoreProtoMethod/
  SetProto (proto operations) / Yield/Await (coroutine boundaries) / Throw/StoreGlobal (external outflow).
  Called once at the top of build_constraints's loop, and from each arm removed the redundant Copy(Global,..), leaving only
  the structural constraints (dst External / Store alias). To add a new "op that demands materialization,"
  just add one arm to this function (no more scattered additions). §3.4 done.
  Verification: all escape-dependent cases (Print/+/in/dynamic access/spread) match V8, all CI green, perf neutral
  (typed_field 187ms, obj 206ms, inherit 82ms — confirmed SROA decisions invariant). A completely behavior-invariant
  refactor.

### Remaining Stages
- Stage D: cleanup (tidy dead code such as class_has_field), @@iterator → WKSYM migration.
- Stage E: the field-initializer bug (initializers not run for ctor-less classes). Per the Stage B correction,
  this is confirmed as the only remaining legitimate unfixed bug.
- Stage C0: loud-reject Symbol's silent misbehavior (independent, can be done at any time).

- **Stage E (fix the field-initializer bug) — DONE**: fixed the existing bug where initializers of `class C { a = <expr> }` were not
  run at new time, making c.a NaN/undefined (§3.5 Option A).
  Implementation: added `emitFieldInitializers` to the exporter (emits the class's own field initializers as StoreField in declaration order,
  binding this to the target object and also resolving this references like `y = this.x + 5`) and
  `emitImplicitConstruction` (for ctor-less classes: passes args to the parent ctor to chain, then runs the own initializers
  = equivalent to an implicit default ctor). Classes with an explicit ctor inject the initializers at the top of the ctor body in lowerFunctionLike's 3c
  (immediately after 3b's param-property). This chains super() → parent ctor →
  parent initializers correctly.
  Verification (all match V8): flat (a=1,b=2) / this-referencing initializer (y=this.x+5) / initializer+explicit ctor /
  initializer→ctor mutation (no duplication) / combined with param-property / inheritance (Base initializers run via super,
  Derived / ctor-less derived D2). Added golden `field_init`. All CI green, perf neutral (typed_field 191ms,
  obj 222ms, inherit 85ms — within budget).
  → This resolves the item flagged as "the only remaining legitimate unfixed bug" in the Stage B correction.

### Remaining
- Stage D: cleanup (tidy dead code such as class_has_field), @@iterator → WKSYM migration.
- Stage C0: loud-reject Symbol's silent misbehavior (independent).

- **Stage D (cleanup + @@iterator→WKSYM migration) — DONE**
  - **Tidy dead code**: delegate class_has_field to class_field_lookup (integrating the duplicated field-walk
    logic). Because enumeration/enumerated removal was already done in A-2b/B, the remaining tidying centers on this deduplication.
    The 4 analyzer-side warnings (flatten_cf's mut fresh / SObj::Global / vtable_names / Ctx::cty) are
    existing dead code unrelated to this refactor, so left untouched (out of scope, prioritizing low risk).
  - **@@iterator→WKSYM migration**: actually use the TS_K_WKSYM tag reserved in A-2c-1. Defined
    TS_WKSYM_KEY_BASE(2e9) + TS_KEY_WKSYM(id) + enum ts_wksym_id (iterator=0, asyncIterator=1,
    toPrimitive=2, hasInstance=3, toStringTag=4) in ts_rt.h. Added well_known_symbols (name_id→
    wksym_id) to Program, and the exporter records the intern ids of @@iterator/@@asyncIterator into it. codegen
    converts the relevant name_id to TS_KEY_WKSYM(id) in method_key_str() (consolidating the 3 sites of class-method registration, StoreProtoMethod,
    and dynamic method dispatch). This makes well-known symbol keys position-independent
    stable values, building the foundation for obj[Symbol.iterator] to resolve to the same key in the future (escaping the
    position-dependent intern id of the string disguise).
  - Verification: all CI green (runtime/golden41/unit7/ci_fast/correct1/correct2), perf neutral (typed_field 188ms,
    obj 206ms). for-of over a non-generator [Symbol.iterator] matches V8 via the WKSYM key. Added
    well_known_symbols: vec![] to 6 test fixture files.
  - Known unfixed (out of Stage D's scope): generator `*[Symbol.iterator]()` still does not work due to a separate iterator-protocol
    issue (the returned generator's .next() dispatch fails). Independent of the WKSYM migration. Needs separate handling.

### Remaining
- Stage C0: loud-reject Symbol's silent misbehavior (independent). Explicitly reject unsupported paths such as
  generator [Symbol.iterator] and obj[Symbol.x]=.

- **Bug fix: for-of over a generator `*[Symbol.iterator]()` — DONE**
  Cause: when a class's [Symbol.iterator] is a *generator method*, calling it returns OUR generator
  object, but the for-of lowering treated it as a "custom iterator" and called .next() via
  prototype method dispatch (ts_get(gen, methodkey "next")). Because a generator object advances
  next via the generator.next builtin, it aborted with "method id 1 not found."
  Fix: added an isGenerator flag to class_extract's MethodInfo (determined from the method declaration's asteriskToken).
  Added classMethodIsGenerator(classId, name) to the exporter, and in for-of lowering, if the iterable's
  [Symbol.iterator]/[Symbol.asyncIterator] is a generator method, branch with useBuiltin=true to advance
  via the generator.next / asyncgen.next builtin (throw/return also ride the builtin path).
  Verification (all match V8, ASan clean): basic (yield 1..3 → 6) / break interruption (iterator close) /
  this-referencing generator method (Pair) / re-iteration (a new generator each time) / async generator
  *[Symbol.asyncIterator]() + for await / yield* delegation. Added golden `gen_symbol_iterator` (42 total).
  All CI green, perf neutral (typed_field 191ms, obj 227ms).
  → This resolves the generator iterator bug flagged as "out of scope, needs separate handling" in Stage D.

### Remaining
- Stage C0: loud-reject Symbol's silent misbehavior (independent). Explicitly reject unsupported paths such as
  obj[Symbol.x]=fn (outside a class), Symbol("k")/Symbol.for().

- **Stage C0 (loud-reject Symbol's silent misbehavior + integer-key case I-B) — DONE**
  - **loud reject** (explicitly reject silently-wrong paths): in the exporter,
    reject Symbol(...) / Symbol.for(...) / Symbol.keyFor(...) calls and obj[Symbol.*] reads/writes
    (class-method declarations [Symbol.iterator]() are handled separately via the wellKnownMethodName path, unaffected)
    at compile time with unsupported() (previously they trapped at runtime / silently vanished). Added
    isSymbolKeyExpr() to the decision. Created tests/rejects_symbol.sh and wired it into ci_fast.
  - **Integer-key case I-B (correctly implemented, not loud-rejected)**: a plain object's numeric key o[0]=v was
    previously a silent no-op via StoreIndex→ts_array_set on a non-array, and o[0] was undefined too. Because the any type
    cannot be statically distinguished from an array and would over-reject, this is fixed rather than rejected: ts_array_get/set, for a non-array object,
    interns the numeric i to the string key "i" and falls back to ts_get/ts_set (arrays keep the previous fast
    element path). Additionally implemented JS property order (integer index keys
    first in ascending order, string keys in insertion order) in the canonical enumeration ts_prop_own_enum. Determined by
    prop_key_is_array_index(); if there are no integer keys (the normal case), it goes straight to the previous insertion-order path = no perf impact. A one-place fix reflects into all of keys/values/entries/JSON/
    inspect/assign/spread/rest (the benefit of the A-2b-2 consolidation).
  - Verification (matches V8, ASan clean): rejection of the 4 Symbol paths, integer-key values (o[0..2], o["name"]),
    JSON.stringify order {"0","1","2","name"}, Object.keys/values order, array fast path preserved.
    Added golden int_keys (43 total), added negative rejects_symbol. All CI green, perf neutral
    (typed_field 193ms, obj 227ms).
  - Known separate bug (out of C0's scope, needs separate handling): method dispatch such as arr.join() for arr: any = [...]
    reads ts_array as ts_object via ts_get→find_slot, causing a heap-buffer-overflow (ASan-detected). An "any-typed array method dispatch"
    problem unrelated to Symbol/integer keys. Needs separate fixing.

### Implementation Status of Design §3
§3.1 canonical path / §3.2 enumeration unification / §3.3 tightened struct optimization / §3.4 escape centralization / §3.5 field
initializers / §3.6 key space (tag, WKSYM, integer-key I-B) — **all implemented**. The harmful bugs (field
initializers, generator [Symbol.iterator], integer-key silently-wrong) are also resolved. What remains is the real implementation of Symbol values
(a separate task) and the above any-array method dispatch bug.

- **Fix to the integer-key design (Kaz's point: distinguishing a["0"] vs a[0], a[1.5]) — DONE**
  The point revealed a fundamental error in C0's integer-key implementation:
  (1) The old indexAccessKind treated "if the key is a numeric type, unconditionally the number path (array-premised StoreIndex/LoadIndex
      → ts_array_set/get)" and lowered even plain objects to array instructions.
  (2) The non-array fallback of ts_array_set/get added in C0 integerized via snprintf("%u"), so
      a[1.5] was truncated to "1" and collided with a[1.0] (a[1.5]'s value lost, keys wrong).
  **Design decision (conclusion to Kaz's question "should integer keys be held in a separate region?")**: they should not. In the JS spec,
  property keys are always strings, and a[0] and a["0"] are the same key (0 is "0" via ToString). V8 semantically also has no
  separate region; a[0]≡a["0"]. Therefore "normalize integer keys to string keys via ToString and unify them" is correct.
  Fix:
  - indexAccessKind: the number path (the array element fast path) is only when the base *can be confirmed as an array* (and
    for string char access). plain object / any numeric keys go to the string path (StoreFieldDynamic/
    LoadFieldDynamic → ts_set_dyn/ts_get_dyn). ts_set_dyn already ToString-normalizes
    (1.5→"1.5", 1.0→"1", 0→"0").
  - Symmetrize ts_get_dyn with ts_set_dyn: ToString a non-array object's numeric key and delegate to ts_get
    (previously it returned undefined).
  - Removed the snprintf integerization fallback of ts_array_set/get added in C0 (it was wrong). The integer-key-first ordering is
    already correctly implemented in ts_prop_own_enum's prop_key_is_array_index (it decides on the string key, so it correctly picks up the normalized
    "0"/"1").
  - Fixed an existing bug along the way: str[i] char access (LoadIndex→ts_array_get was string-unsupported and returned undefined)
    is now made to match V8 by adding a string case to ts_array_get (no negative wraparound, distinct from .at()).
  Verification (matches V8, ASan clean): a["0"]&a[0]→{"0":2}/keys length 1, a[1.0]/a[1.5]/a["01"] distinguished→1,1.5,01,
  integer-key ascending-first {"0","1","2","name"}, array fast path preserved, str[i] char access. Expanded golden int_keys
  to include edge cases. All CI green, perf neutral (typed_field 192ms, obj 227ms, int 437ms, float 149ms).

### Known Separate Bugs (out of this scope, need separate handling; all in the pure-array/int-unbox path, unrelated to this matter)
- With a number[] sparse array + unboxed-int accumulator, a[i]||0 becomes INT64_MIN (the int-cast problem of undefined elements).
- method dispatch such as arr.join() on arr: any = [...] reads ts_array as ts_object via ts_get→find_slot,
  causing a heap-buffer-overflow (ASan-detected).

- **Bug fix: heap-buffer-overflow in method dispatch on any-typed array/Map/Set — DONE**
  Cause: array/function/Map/Set have the OBJECT NaN-box selector (ts_is_obj is true) but are structs different from ts_object's
  prop-map layout (->props/->len). arr.join() etc. on arr:any loses its static type and
  falls to dynamic dispatch ts_get(arr, methodkey); ts_get reads ts_array as ts_object and walks o->props/
  o->len (actually a->data/a->cap) → find_slot reads out of the allocated region (the ASan-detected heap-buffer-overflow).
  Fix: added an `early return if o->h.kind != TS_KIND_OBJECT` guard at the top of ts_get/ts_set. Only TS_KIND_OBJECT
  (plain object/class instance/proto/Date) uses the prop-map layout; array/func/
  map/set/promise/coro are separate structs and must not walk the prop map. These return undefined from dynamic ts_get,
  and the caller's ts_is_callable check turns "method not found" into a loud TypeError (a safe explicit failure
  rather than memory corruption). Also improved ts_dynamic_method_missing's diagnostic to be actionable: "if it's the any type, add a concrete type."
  Verification (ASan clean): arr:any.join() / map:any.keys() loud-fail without overflow. Methods on typed arrays
  (number[]) work correctly via static builtins as before (join/map/filter, matches V8). All CI green,
  perf neutral (typed_field 186ms, obj 206ms). Created tests/runtime_anymethod_safe.sh (verifies no overflow under ASan)
  and wired it into ci_fast.
  Known limitation (out of scope, separate): *dynamic* method calls on any-typed array/Map/Set are not fully supported and loud-fail.
  Full support requires a runtime prototype that resolves each builtin by name (including closure coordination for callback-taking map/filter),
  a medium-sized feature. Adding a concrete type makes it work via static dispatch (recommended, guided by the diagnostic).

### Known Design Inaccuracy (Kaz's point: arrays should also inherit Object.prototype and have a prop-map)
In JS semantics, arrays/Map/Set also inherit Object.prototype (via the proto chain) and have
inherited methods such as hasOwnProperty/toString/constructor, custom named
properties on instances (arr.custom=99), and their reflection into Object.keys. Therefore, properly, every "object" should
have ts_object's prop-map layout + proto.

The current tsaot has a minimal structure ts_array = {h, data, len, cap} with neither a prop-map nor a proto, and dispatches array methods
via a static builtin allowlist. The recently added `early return if kind != TS_KIND_OBJECT` guard in ts_get/ts_set
is a stopgap to prevent the heap-overflow of reading ts_array as ts_object, and it
cements the spec-inaccurate premise of "arrays have no prop-map" (technical debt).

Assessment:
- Memory safety is secured (overflow→loud-fail, no regression).
- The major inherited methods of typed arrays (join/indexOf/includes/slice/map/filter/length/concat etc.) match V8 via static
  dispatch. Covers the bulk of practical use.
- Unsupported (loud-fail): dynamic method calls on any-typed arrays, custom named properties on array instances,
  and proto-chain resolution of arrays' inherited methods.

Full correction (separate task, needs a design document, high blast radius):
- Make ts_array compatible with the ts_object layout (share proto/props/pcap/plen/shape at the head,
  data/alen/acap at the tail). Impact: ~91 field-access sites + all arrays +~40B.
- Adopting V8's "arrays are lightweight normally, allocate a prop-map only when a named property is added (lazy, props=NULL initially)"
  keeps hot-array perf. ts_get resolves in the order: array data/length special-casing + lazy prop-map + array
  proto (Array.prototype builtins registered) chain.
- This makes arr.custom=99 / any-typed arr.method() / Object.keys(arr) conform to the JS spec.
