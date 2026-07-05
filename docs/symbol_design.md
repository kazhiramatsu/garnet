# Symbol Support — Design Document

## 0. Purpose

Implement Symbol-related features as a batch. Current state (empirically verified):

| Feature | Current state |
|---|---|
| `Symbol(desc)` | reject |
| `obj[sym]` used as a key | reject |
| object-literal `{ [Symbol.iterator]() {} }` | reject (computed-name method) |
| class `[Symbol.iterator]() {}` | **works** (already implemented via WKSYM) |
| `Symbol.for(k)` / `Symbol.keyFor` | reject |
| `Symbol.iterator` used as a value | breaks (method-id misresolution) |
| `typeof sym` / `sym === sym` | not implemented |
| `sym.description` / `sym.toString()` | not implemented |

Implement this on top of the existing tagged-key foundation (property_model_redesign.md §3.6).

## 1. Current foundation (verified in code)

### 1.1 Key space (ts_rt.h) — already implemented via range partitioning
`ts_key` is uint32_t. 3 partitions:
- STRING: 0 onward (field id / method name id are assigned by internField/internName)
- METHOD: `TS_METHOD_KEY_BASE = 1_000_000` onward (`TS_KEY_METHOD(id)`)
- WKSYM:  `TS_WKSYM_KEY_BASE = 2_000_000_000` onward (`TS_KEY_WKSYM(id)`)
  well-known id fixed: iterator=0, asyncIterator=1, toPrimitive=2, hasInstance=3, toStringTag=4.
- The SYMBOL tag is reserved in the enum but **the physical key space is unallocated** (because user Symbol is not yet implemented).

Thanks to WKSYM, **class `[Symbol.iterator]()` already works** (registered under `TS_KEY_WKSYM(ITERATOR)`,
and for-of looks it up by the same key). This is the reference pattern for the user Symbol implementation.

### 1.2 NaN-box selector — no free slots (an important constraint)
All 6 selectors 0xFFF8–0xFFFD (OBJECT/STRING/FUNC/BOOL/UNDEF/NULL) are in use.
**We cannot allocate a new primitive selector for symbol.** → Symbol is represented as an **OBJECT-tagged heap value**
(a dedicated GC kind), and `typeof`/`===` distinguish it by that kind (same shape as accessor=kind 9).

### 1.3 GC kind
`TS_KIND_ACCESSOR=9` is the current maximum. Add a new `TS_KIND_SYMBOL=10`.

## 2. Design

### 2.1 Runtime representation of user Symbol
Conforms to the design in property_model_redesign.md:
```c
typedef struct { ts_gc_header h; uint32_t sym_id; uint32_t flags; tsv description; } ts_symbol;
// kind = TS_KIND_SYMBOL. Box with the OBJECT selector (ts_obj(sym)).
// sym_id: uniquely assigned within the process (global counter). === is sym_id equality (heap identity).
// flags: bit0=registered (created by Symbol.for = registry-managed). Reserved for future well-known/private use.
// description: the desc string of Symbol(desc) (undefined if none).
```
> **Shipped layout (see §6):** the planned `flags` bitfield above was realized as two separate fields — `uint32_t wksym` + `uint8_t registered`; there is no `flags` field in the shipped `ts_symbol` (`runtime/ts_rt.h`).

- The assignment counter `g_next_sym_id` is a **dedicated space that does not collide with WKSYM/method/index**.
  Since `ts_key` is uint32_t and packs all partitions into a single space when used as a property key,
  user symbols must be placed in a **high range that does not collide with STRING/METHOD/WKSYM**.
  → Add a new **`TS_USERSYM_KEY_BASE`** (e.g. 2_100_000_000, above WKSYM(2e9), below the uint32 max of 4.29e9).
  The key for `obj[sym]` is `TS_USERSYM_KEY_BASE + sym->sym_id`. sym_id is assigned as 0,1,2...
  (Note: it could be exhausted at a few hundred thousand symbols, but this is sufficient for the AOT target scale. Extensible in the future by going 64-bit.)

### 2.2 `typeof` / `===`
- `ts_typeof`: if OBJECT selector and kind==SYMBOL, then `"symbol"`.
- `===` (`ts_strict_eq`): **verified — the tail is `return a==b` (two OBJECTs compare by pointer identity)**.
  Therefore **if the ts_symbol pointer is identical, `===` is automatically true**. `Symbol(desc)` is a different pointer
  each time, so they are distinct (correct); `Symbol.for(k)`, if made a singleton via the registry, has the same pointer = true;
  and well-known, if also made a singleton, has the same pointer = true. **No sym_id comparison is needed** (pointer identity suffices).
  → Design simplification: we do not even need to add a symbol special case to ts_strict_eq.

### 2.3 `Symbol(desc)` / `Symbol.for(key)` / `Symbol.keyFor(sym)`
- `Symbol(desc)`: assigns and creates a new ts_symbol (unique each time). `Symbol()` has desc=undefined.
  Runtime `ts_symbol_new(tsv desc)`.
- `Symbol.for(key)`: a global `desc->ts_symbol` registry (string key). The same key yields the same symbol.
  Runtime `ts_symbol_for(tsv key)`. Sets the `registered` flag.
- `Symbol.keyFor(sym)`: returns the registration key string of a registered symbol (undefined if not registered).
- exporter: lower the `Symbol(...)` call / `Symbol.for(...)` / `Symbol.keyFor(...)` to builtins
  (`symbol.new` / `symbol.for` / `symbol.keyFor`).

### 2.4 Using a well-known symbol as a value: `Symbol.iterator` etc.
- Currently, referencing `Symbol.iterator` as a **value** breaks due to method-id misresolution.
- well-known symbols also need to be retrievable as a "symbol value" (for computing the key of `obj[Symbol.iterator]`,
  `const k = Symbol.iterator`, etc.).
- Design: prepare a **singleton ts_symbol** corresponding to each well-known symbol (with sym_id
  mapped to the WKSYM range), and return that singleton when `Symbol.iterator` is referenced.
  For keying `obj[Symbol.iterator]`, if the symbol is well-known it maps to `TS_KEY_WKSYM(wksym_id)`
  (which becomes the same key as class method registration, so they are consistent); if a user symbol, the USERSYM range.
- exporter: treat the PropertyAccess of `Symbol.iterator`/`asyncIterator`/`toPrimitive`/`hasInstance`/`toStringTag`
  as a "well-known symbol value" node; when a value is needed, fetch the singleton,
  and when used as a computed key `[Symbol.iterator]`, resolve to the WKSYM key.

### 2.5 Symbol as a property key: `obj[sym] = v` / `obj[sym]`
- In the lowering of a computed key, if the key expression's type is symbol (or a well-known symbol reference),
  route StoreField/LoadField through the **symbol-key path**.
  - well-known: `TS_KEY_WKSYM(id)` (statically determined).
  - user symbol: a **dynamic key path** that computes `TS_USERSYM_KEY_BASE + sym->sym_id` at runtime
    (equivalent to StoreFieldDynamic/LoadFieldDynamic, but keying by symbol without stringifying it —
    either a new runtime helper `ts_get_sym`/`ts_set_sym`, or an extension of ts_set_dyn).
- Caution: the existing `ts_set_dyn`/`ts_get_dyn` (runtime 2310/2292) have been **verified to stringify the key
  via `ts_to_string_v`**. Passing a symbol through here would produce a `"Symbol(...)"` string key and
  break. → Add a **dedicated runtime helper `ts_set_symkey`/`ts_get_symkey`** (which, from the argument symbol,
  builds `TS_KEY_WKSYM(id)` if well-known, or `TS_USERSYM_KEY_BASE + sym_id` if a user symbol, then calls ts_set/ts_get).
  The exporter emits this path when the computed key's type is symbol.

### 2.6 object-literal `{ [Symbol.iterator]() {} }`
- Once §2.4/§2.5 are in place, the key of a computed-name method can be resolved to WKSYM/USERSYM.
- Add a computed-name method branch to the object literal lowering (method/accessor already handled in a prior task):
  if the key is a well-known symbol, `ts_set(obj, TS_KEY_WKSYM(id), closure)`; if a user symbol,
  a dynamic symbol-key. This makes `{ [Symbol.iterator]() {} }` consistent with for-of (the same mechanism as class).

### 2.7 `sym.description` / `sym.toString()`
- `description`: returns ts_symbol.description (a LoadField special case or builtin).
- `toString()`: constructs the `"Symbol(desc)"` string.
- Low priority (stage 3).

## 3. Stages

- **Stage 1 (user Symbol core)**: the ts_symbol struct + kind, `ts_symbol_new`, typeof, ===,
  exporter lowering of `Symbol()`/`Symbol(desc)`. The symbol-key path for `obj[sym]=v`/`obj[sym]`
  (USERSYM range + a symbol-specific dynamic-key runtime). description.
- **Stage 2 (well-known symbol value + computed key)**: value references of `Symbol.iterator` etc. (singletons),
  WKSYM key resolution of `obj[Symbol.iterator]`, object-literal `{ [Symbol.iterator]() {} }`.
  → This makes the for-of/iterator protocol fully work even for object literals.
- **Stage 3 (registry + auxiliaries)**: `Symbol.for`/`Symbol.keyFor`, `sym.toString()`,
  and the value references and effects of `Symbol.asyncIterator`/`toPrimitive`/`hasInstance`/`toStringTag`.

Each stage: full CI green + perf neutral (the hot path reads struct fields directly and does not go through symbol, so no impact is expected.
However, since the added branches for computed key / ts_set_dyn land on the dynamic property path, measure obj_kernel).

## 4. Risks

- **selector exhaustion**: as noted. Since symbol is represented as OBJECT+kind, no primitive selector is needed.
- **key space collision**: place the USERSYM range above WKSYM(2e9), keeping it within the uint32 max. sym_id assignment
  must not exceed the USERSYM range width (no problem in practice, but needs an assert).
- **stringification error**: never stringify a symbol key (dedicated path). `Object.keys` does not
  enumerate symbol keys (JS spec) = add a predicate so prop_enum_data skips the symbol-key partition.
- **=== and the registry**: the identity of `Symbol.for` is guaranteed by making it a singleton in the registry.
- **GC**: mark ts_symbol.description in gc_mark. The well-known singletons are permanent roots.

## 5. Non-goals (out of scope this time)

- private symbol (`#x` class private field) — has an existing implementation and a separate mechanism.
- The actual type-conversion effect of `Symbol.toPrimitive` (hinted ToPrimitive) — even in stage 3 only value references are done;
  the conversion logic is separate.
- Advanced uses of Symbol such as WeakMap keys, etc.

## 6. Implementation results

### Stage 1 (user Symbol core) — DONE
- runtime: `ts_symbol { sym_id; wksym; registered; description }` (kind TS_KIND_SYMBOL=10,
  OBJECT-tagged). `ts_symbol_new` (assigns g_next_sym_id), `ts_is_symbol`, `ts_symbol_description`,
  `ts_symbol_key` (well-known→TS_KEY_WKSYM, normal→TS_KEY_USERSYM(sym_id)), `ts_set_symkey`/
  `ts_get_symkey` (ts_set/ts_get by symbol-key without stringifying). Added symbol to `ts_typeof`.
  `===` is automatically correct via the existing `ts_strict_eq` tail `a==b` (pointer identity) (no sym_id comparison needed).
  Added symbol.description to gc_mark. USERSYM key space `TS_USERSYM_KEY_BASE=2.1e9`.
- emit_c: builtins `symbol.new`→ts_symbol_new, `symbol.get`→ts_get_symkey, `symbol.set`→
  ts_set_symkey (a void-specific block), `symbol.description`→ts_symbol_description.
- exporter: `Symbol(desc)`→symbol.new. The read/write of computed key `obj[userSym]` goes to symbol.get/
  symbol.set (isSymbolKeyExpr determines the symbol type, wellKnownSymbolId distinguishes well-known).
  `sym.description`→symbol.description. well-known computed key (obj[Symbol.iterator]) and
  Symbol.for continue to be explicitly rejected as stage 2/3.
- enumeration: symbol keys are in the WKSYM/USERSYM range (≥2e9), so the existing ts_key_is_method(≥1e6) check
  automatically filters them out, so they do not appear in Object.keys (no additional change needed).
- verification vs V8: typeof(symbol)/identity(false true)/description(desc, undefined)/obj[sym]=42 read-write/
  distinct symbols distinct keys(1 2)/symbol keys not enumerated(keys.length 0). All CI green, conf 71/71, perf neutral
  (obj_kernel 206ms, typed_field 187ms). Updated the stale negative test (removed the reject of Symbol(),
  kept the reject of Symbol.for and obj[Symbol.iterator]). Added conformance: symbol/user_symbol.ts.

### Stage 2 (well-known symbol value + computed key) — DONE
- runtime: well-known singletons `ts_wksym(id)` (the 5 from iterator..toStringTag, permanent GC roots,
  with the id in each ts_symbol's wksym field. Since ts_symbol_key returns TS_KEY_WKSYM(id), it is the same key as class
  `[Symbol.iterator]()`).
- exporter:
  - referencing `Symbol.iterator` etc. as a **value** → `symbol.wksym:<id>` builtin (fetch the singleton).
    typeof→symbol, === is true by pointer identity.
  - unified `obj[Symbol.iterator]` read/write to symbol.get/symbol.set (both well-known and user
    go through the symbol value. Determined by isSymbolKeyExpr; distinguishing via wellKnownSymbolId is no longer needed, consolidated onto the value path).
  - object-literal computed-name Symbol method `{ [Symbol.iterator]() {} }` → stored under a symbol-key via symbol.set
    (lifted with this=object). Extended assignIds / free-var seeding to computed-name Symbol
    methods as well.
  - extended `resolveIterator` to handle non-class `[Symbol.iterator]` objects (object literals etc.):
    determined by `typeHasSymbolIterator` (detecting the `__@iterator@N` member of the TS type), obtaining `obj[Symbol.iterator]()`
    via a symbol.get→Value-callee call, and `.next()` via emitIterNext.
  - added methodField to `emitIterNext` (so the iterator's `next()` resolves even for an object-literal's field-key
    method, via the own→prototype fallback).
- emit_c: `symbol.wksym:<id>` → a dedicated ts_wksym(id) block.
- verification vs V8: Symbol.iterator value (typeof symbol, identity true), obj[Symbol.iterator] read-write (42),
  **for-of over an object literal's custom iterator (0 1 2, both the outer-mutable-capture version and the method-local version)**.
  All CI green, conf 73/73, perf neutral (obj_kernel 203ms). Updated the stale negative test
  (reject-async/reject-symbol). Added conformance: symbol/wellknown_iterator.ts.

### A separate bug found and fixed during stage 2 (closure cell, Symbol-independent)
When an object-literal method **captures an outer mutable variable nested two or more levels deep**, the cell was not shared
and became a value copy instead (e.g. in `{make(){return{step(){return i++;}}}}`, i++ was not shared and
resulted in NaN/no-update). Cause: `collectNested` skipped object-literal methods/accessors from free-var analysis with `/* method/ctor
boundary: skip body */`, so the inner method's captures
did not propagate outward and were not promoted to cells. Arrow functions were handled correctly by isLiftable.
Fix: added a new `isObjLitFn` predicate and, in collectNested, collect object-literal methods/accessors as nested
function boundaries (so freeVars propagate, same as arrows). Verification: method->method / arrow->method /
single-level all match V8. conformance: object_methods/nested_capture.ts.

### Stage 3 (registry + auxiliaries) — DONE
- runtime: a global Symbol registry (key string→singleton ts_symbol, a small linear-search table,
  registered=1, permanent root). `ts_symbol_for(key)` (same key yields same symbol, === by pointer identity),
  `ts_symbol_key_for(sym)` (the registration key of a registered symbol, or undefined), `ts_symbol_tostring(sym)`
  ("Symbol(desc)", or "Symbol()" when there is no desc).
- exporter: `Symbol.for(k)`→symbol.for, `Symbol.keyFor(s)`→symbol.keyFor, the `.toString()` of a symbol-typed receiver
  →symbol.toString.
- emit_c: symbol.for/keyFor/toString.
- verification vs V8: Symbol.for identity (same key true, different key false), keyFor (registered hi / unregistered undefined),
  toString (Symbol(desc) / Symbol()), using a registry symbol as a key (o[Symbol.for("k")]=99 gives the same key).
  All CI green, conf 74/74, perf neutral (obj_kernel 206ms). Added conformance: symbol/registry.ts.
- Converted rejects_symbol.sh from a **negative test to a positive smoke test** (since Symbol is fully implemented,
  verifying that Symbol.for/keyFor/toString/obj[Symbol.*] work).

## 7. Completion status

All of Symbol's initial rejects (Symbol()/obj[sym]/{[Symbol.iterator]()}/Symbol.for/Symbol.iterator value) have been
resolved, and user Symbol, well-known symbol, computed key, the iterator protocol, the registry, and
description/toString are all implemented. **for-of over an object literal's custom iterator** works.
The non-goals (§5) remain deferred: private symbol (#x, a separate mechanism), the coercion effect of Symbol.toPrimitive
(value references and keying are possible, but conversion hooks such as Number(o) are not implemented), WeakMap keys, etc.

## 8. Loose ends (follow-up work)

### 8.1 The coercion effect of Symbol.toPrimitive (resolves the §5 non-goal)
Implemented ToPrimitive so that `Number(o)` / `String(o)` / `+` call valueOf / toString /
Symbol.toPrimitive in spec order.
- runtime: `ts_to_primitive(v, hint)` (hint 0=number,1=string,2=default).
  Symbol.toPrimitive (TS_KEY_WKSYM(TO_PRIMITIVE)) takes top priority; if absent, depending on the hint,
  valueOf→toString (number/default) / toString→valueOf (string). Added a new `g_valueof_key`
  (in emit_c, registering object_proto's valueOf method-key via ts_set_valueof_key).
- `ts_number_coerce` (Number()): objects go through ts_to_primitive(.,0).
- `ts_add` (`+`): the number-number fast path is unchanged (perf unchanged). object operands are
  passed through ts_to_primitive(.,2=default) and then recursed.
- `ts_to_string_v` (String()/template): objects try Symbol.toPrimitive("string") first.
- verification vs V8: valueOf (Number 42, + 47), toString (String hi, + hi!), Symbol.toPrimitive
  by hint (number 7 / string str / default def). conf 75/75, perf neutral (numeric + uses the fast path).
  Added conformance: coercion/to_primitive.ts.
- Note: private symbol (#x class private field/method) was already **fully working**
  (a separate mechanism. field read-write/mutate, private method, `#x in o` brand check, same-named #x independent across different classes,
  down to private static, all match V8). The only case, **private accessor (get/set #p), was segfaulting**, so
  it was changed to a loud-reject (never silently wrong. Full support is a separate task requiring private-name accessor plumbing).

### 8.2 Full support for private accessors (resolves the §8.1 loud-reject)
Fully implemented `get #p()` / `set #p()` (private accessors). The earlier investigation had turned the segfault into
a loud-reject, but investigating the mechanism revealed that a mere registration omission was the only cause, and this work completes it.
- What was found: class_extract already records private accessors in ownMethods with name="#p" (including the #).
  Since findMember/hasGetter/hasSetter look up by name match, they work as-is even for private names.
  getter detection in PropertyAccess (reading `this.#p`) is node.name.text="#p", and setter detection
  (`this.#p = v`) is lhs.name.text="#p", both of which internally call internName("get #p")/
  internName("set #p"). methodDecls' callName is also `get ${m.name}`="get #p", which matches.
  → The accessor mechanism was already designed to work with private names as-is.
- Fix: in the exporter's class member processing (main pass + spec pass), extend the getter/setter registration condition
  from `isIdentifier(m.name)` to `isIdentifier(m.name) || isPrivateIdentifier(m.name)`
  (removing the previously added loud-reject). This alone makes read/write / getter-only / setter-only / coexistence with private method
  all work.
- verification vs V8: get+set(5), getter-only(20), setter-only side effect(1 2), coexistence of private accessor + private
  method(2), private getter in an expression(10). No regression for public accessor / private field.
  perf neutral (obj_kernel 205ms, typed_field 182ms. Only classes with a private accessor go through accessor
  dispatch, hot path unchanged). All CI green, conf 76/76. Added conformance:
  object_methods/private_accessor.ts.
