# Accessor properties (Object.defineProperty get/set) — design

## Goal
Object.defineProperty(o, k, { get() {...}, set(v) {...} }) creates an accessor
property: reading o.k invokes the getter (this=o); writing o.k=v invokes the
setter (this=o, arg=v). Must work through the existing dynamic ts_get/ts_set
path and the prototype chain, with no regression to the hot typed-field path.

## Key facts about the current model
- Property storage: ts_prop { uint32_t key; tsv val; } in ts_object.props.
  NO per-property flags. ts_get/ts_set/find_slot walk props + proto chain.
- Typed class instances store fields in a C struct (->fN), NOT in props, so they
  never touch this path — the kernel hot path is unaffected by changes here.
- Methods receive `this` as args[0]. A getter is ts_call(g,[o],1); a setter is
  ts_call(s,[o,v],2). (Confirmed: emitted fn body does `if(nargs>0) v0=args[0]`.)
- Values are NaN-boxed; objects use selector TS_SEL_OBJECT + a GC kind in the
  header (TS_KIND_OBJECT=1 .. CORO=8). GC marks object props by walking props[].

## Design: accessor as a tagged heap value (option 3, least invasive)
Introduce a new GC kind TS_KIND_ACCESSOR=9 and a struct:
    typedef struct { ts_gc_header h; tsv getter; tsv setter; } ts_accessor;
An accessor property stores, as its prop `val`, an OBJECT-tagged pointer to a
ts_accessor (ts_obj(acc)). A helper:
    static int is_accessor(tsv v){ return ts_is_obj(v) &&
        ((ts_gc_header*)ts_ptr(v))->kind == TS_KIND_ACCESSOR; }

Read/write interception (the ONLY hot-path change, and only for dynamic objects):
- ts_get(o,k): walk proto chain; when a slot is found, if is_accessor(*slot):
    if getter present -> return ts_call(getter,[receiver],1); else undefined.
  receiver is the ORIGINAL object (not the proto where the accessor was found),
  matching JS `this` semantics for inherited accessors.
- ts_set(o,k,v): search own props (and proto chain for an inherited accessor —
  JS invokes an inherited setter). If the found slot is_accessor:
    if setter present -> ts_call(setter,[receiver,v],2); else no-op (no setter).
  Else normal own-property store via find_slot(create).
  NOTE: per spec, if an inherited *accessor* with no setter exists, the write is
  ignored (strict: throws); we no-op. If an inherited *data* property exists, a
  write creates an own data property — current ts_set already creates own.

Subtlety: ts_set currently does `*find_slot(o,k,1)=v` (own only). To honor an
inherited accessor's setter, ts_set must first look up the chain for an accessor.
To avoid changing data-property semantics, ts_set logic becomes:
  1. find own slot. If own slot is_accessor -> call setter / no-op. done.
  2. else if own slot exists (data) -> overwrite. done.
  3. else search proto chain for a slot; if that slot is_accessor -> call its
     setter with receiver=o / no-op. done.
  4. else create own data slot = v.
This keeps data writes creating own props (step 4) and only diverts to accessors.

GC: gc_mark must handle TS_KIND_ACCESSOR by marking getter+setter. The accessor
value stored in props[] is OBJECT-tagged, so the existing props-marking loop will
gc_mark its pointer; we add a case in gc_mark for the new kind to recurse into
getter/setter. Sweep/free: calloc'd like other GC objects, freed by the sweeper.

inspect/keys/JSON: an accessor property's value is the ts_accessor object. For
Object.keys/entries/console.dir/JSON we currently enumerate props by key name.
An accessor defined via defineProperty defaults to enumerable:false, so it should
NOT appear. We already reject non-default enumerable in defineProperty, but an
accessor defaults to non-enumerable regardless. Simplest correct behavior: store
the accessor under the given key but ALSO record it as non-enumerable. Since we
have no per-prop flag, and the key is a normal name, enumeration WOULD include it.
=> To stay sound, console.dir/keys/entries/JSON must skip props whose value
is_accessor (they are accessor slots, not data). Add that skip in the 4 enumerators
(object_keys, object_values, object_entries, inspect, json_stringify, ObjectCopyProps).
Reading such a prop for display would also need to either call the getter or show
"[Getter]"; Node shows "[Getter]"/"[Getter/Setter]". For console.dir we render
"[Getter]"/"[Setter]"/"[Getter/Setter]" without invoking (avoids side effects).

## Exporter
Remove the "reject get/set accessor" branch in Object.defineProperty; instead emit
a runtime call ts_define_accessor(obj, key, getterFnOrUndef, setterFnOrUndef).
The get()/set() in the descriptor are method-shorthand; lower each to a function
value (closure) like any other function expression. enumerable/writable still
rejected if explicitly false for a *data* descriptor; for accessor descriptors,
enumerable:true is allowed (we just won't enumerate anyway — document this minor
divergence) — actually to stay honest, reject accessor + enumerable:true loudly
since we cannot enumerate it. Keep configurable ignored (no delete-protection).

## Risk controls
- Hot path: only dynamic ts_get/ts_set gain one is_accessor() check on a found
  slot. Typed-field kernel path untouched. Verify perf unchanged.
- Soundness: getters/setters invoked with correct `this`; missing getter -> undef;
  missing setter -> no-op; inherited accessors honored. Verify all vs V8.
- ASan: ts_accessor is GC-managed and marked. Verify no leak/UAF.
- Regression: ALL existing golden + benches must stay green (ts_get/ts_set are
  used everywhere). This is the main risk; rely on the full suite.

## IMPLEMENTED (final)
Status: DONE for the function-value descriptor form.
- Runtime: ts_accessor { getter, setter, g_this, s_this } (kind TS_KIND_ACCESSOR);
  is_accessor() check in ts_get/ts_set; ts_define_accessor[_dyn](.., g_this, s_this).
  GC marks getter/setter. Enumerators skip accessor slots (prop_enum_data + explicit
  is_accessor skips in copy_props/object_rest).
- Calling convention (the subtle part): arrow accessors use LEXICAL this (verified
  against V8: an arrow getter does NOT see the object as this), so they are lowered
  WITHOUT a reserved this param and called with no this arg (g_this/s_this=0); their
  captured cells are prepended by ts_call as usual. Function-expression accessors DO
  bind this=object, lowered WITH a reserved this param (g_this/s_this=1) and called
  with this as a leading arg. Crucially, lowerFunctionLike now emits captured cells
  BEFORE the this param ([cells.., this, real params]) so the layout matches ts_call's
  env-prepend; for non-capturing methods this reduces to the usual [this, params].
- Exporter: Object.defineProperty accessor form lowered to ts_define_accessor_dyn via
  builtin "object.defineAccessor:<gThis>:<sThis>". get/set must be function/arrow
  expressions (the method-shorthand { get(){} } is rejected loudly — the lifting pass
  doesn't id accessor decls). Accessor + any explicit enumerable/writable/configurable
  is rejected (accessors are always non-enumerable here). value+get/set both -> reject.
- Verified vs V8: get+set with backing store, getter-only (write ignored), this-based
  function getter/setter, inherited accessor via prototype chain, non-enumeration in
  Object.keys/JSON. ASan clean. Full CI green; perf unchanged (typed_field 188ms,
  obj_kernel 209ms) — hot path only gains one is_accessor() check on found dynamic slots.
- Deferred: method-shorthand accessors in defineProperty; accessor enumerability;
  Object.getOwnPropertyDescriptor. Class-syntax get/set already worked before D2.
