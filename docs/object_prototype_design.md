# Object.prototype integration — design

## Goal
Give plain objects (and the top of every class's proto chain) a shared
Object.prototype carrying toString / valueOf / hasOwnProperty, so:
- o.toString() -> "[object Object]" (was: runtime TypeError)
- o.valueOf()  -> the object itself (was: TypeError)
- o.hasOwnProperty(k) -> already works (exporter special-case); keep it
- "" + o / String(o) -> "[object Object]" (was: "[object]")
- "toString" in o -> true (secondary; see Risks)

## Current model (verified)
- ts_object { gc_header h; ts_object* proto; ts_prop* props; cap; len }.
- ts_new_object(): proto = NULL (calloc).
- Methods stored on a prototype object as FUNCTION VALUES (ts_make_fn) under key
  METHOD_KEY_BASE(1e6) + <method-name-id>. Dynamic dispatch: ts_get(recv,
  METHOD_KEY_BASE+id) walks the proto chain, then ts_call.
- Two SEPARATE id namespaces: internField (property/field ids) and internName
  (method-name ids). o.m() uses internName; "m" in o / o.m uses internField.
- class_reg_for(o) matches o->proto pointer against registered CLASS_PROTO[i].
- field_enumerable excludes METHOD_KEY_BASE+ keys and "__" names.

## Design
1. Runtime: a single global g_object_proto (ts_object*), created lazily/at setup,
   GC-rooted forever. Three C methods registered on it under METHOD_KEY_BASE+id:
   - ts_objproto_toString(args,n): args[0]=this -> "[object Object]" (plain) or,
     for arrays, the JS Array.prototype.toString (join with ","). Keep simple:
     "[object Object]" for plain objects; arrays already have their own path.
   - ts_objproto_valueOf(args,n): returns args[0] (this) unchanged.
   - ts_objproto_hasOwnProperty(args,n): args[0]=this, args[1]=key ->
     ts_bool(ts_has_own_dyn(this,key)). Lets the proto-based path work too.
   The method-name-ids are assigned by the EXPORTER (internName), so the exporter
   must emit the registration (it knows the ids). Provide a runtime setter
   ts_register_object_proto_method(name_id, fn) + ts_object_proto_get().
2. ts_new_object(): after alloc, set proto = g_object_proto (if set). Internal
   result objects (iterator {value,done}, Response, generators) also get it —
   harmless (they never collide; methods are non-enumerable).
3. Class proto chain: each ROOT class prototype (no parent) chains its proto to
   g_object_proto, so class instances inherit Object.prototype methods too.
4. ts_to_string_v: for a plain object, return "[object Object]" (matches V8) and
   for arrays keep existing behavior. (Coercion does not call the user toString
   in this minimal version — documented divergence if someone overrides toString.)

## Exporter responsibilities
- Pre-intern method-name-ids for "toString","valueOf","hasOwnProperty" so they
  exist even if the program never calls them (only if we always set up the proto;
  to avoid bloat, only emit Object.prototype setup when needed — but simplest and
  safe: always set it up; it's 3 fns).
- Emit ts_setup_object_proto(): create proto, register the 3 methods under their
  internName ids, store into g_object_proto. Call it BEFORE ts_setup_prototypes
  (so class protos can chain to it) and BEFORE any object is created.
- In ts_setup_prototypes, chain each root (parentless) class proto to
  g_object_proto.

## Risks & mitigations (this is the object-model root — be careful)
- R1 class_reg_for misfire: plain objects now have proto=g_object_proto (a
  distinct pointer, never a CLASS_PROTO[i]); class instances keep proto=
  CLASS_PROTO[i]. So class_reg_for still only matches real class instances. SAFE.
  BUT: g_object_proto itself is an object; if something calls class_reg_for on a
  child whose proto IS g_object_proto, returns NULL (not registered). SAFE.
- R2 enumeration leak: toString etc are under METHOD_KEY_BASE keys ->
  field_enumerable false -> not in keys/values/entries/JSON/console.dir. SAFE.
- R3 "toString" in o: `in` uses ts_has_prop with an internFIELD id, but methods
  live under METHOD_KEY_BASE+internNAME id. Mismatch => `in` won't see them
  unless we special-case. MITIGATION: ts_has_prop, when walking the chain and
  reaching g_object_proto, also reports true for the three well-known names. We
  implement via a small runtime check keyed on the field NAME (ts_field_name).
  This keeps `in` correct for the standard Object.prototype names. Bounded.
- R4 GC: g_object_proto rooted once at setup; its method fn values are reachable
  from it (props marked). SAFE.
- R5 perf: ts_new_object adds one store; proto-chain walks for plain-object
  misses go one level deeper. typed-field kernel path (->fN, no proto) untouched.
  Verify typed_field_kernel unchanged (~187ms).
- R6 infinite proto loops: g_object_proto.proto MUST be NULL (chain terminates).
- R7 existing class methods: unaffected (own methods still on CLASS_PROTO[i];
  chain now ends at g_object_proto instead of NULL). A class that defines its own
  toString still shadows Object.prototype's (found first on the chain). SAFE +
  matches JS.

## Verification plan
o.toString(), o.valueOf(), ""+o, String(o), class instance .toString(), a class
that overrides toString (shadowing), "toString" in o, hasOwnProperty still works,
console.dir/keys/JSON do NOT show toString, ASan, full CI, perf unchanged.

## IMPLEMENTED (final)
Status: DONE.
- Runtime: global g_object_proto; ts_new_object() sets new objects' proto to it
  (NULL before setup -> harmless for pre-setup internal allocs). ts_object_proto()/
  ts_install_object_proto(). Three C methods ts_objproto_toString (arrays -> join,
  else "[object Object]"), ts_objproto_valueOf (returns this), ts_objproto_hasOwnProperty
  (ts_bool(ts_has_own_dyn(this,key))). ts_to_string_v: plain obj -> "[object Object]",
  arrays -> join.
- Exporter: pre-interns toString/valueOf/hasOwnProperty method-name ids and emits
  them in programJson.objectProtoMethods. Analyzer emits ts_setup_object_proto()
  (creates proto, registers the 3 methods under METHOD_KEY_BASE+id via ts_make_fn,
  installs it), called FIRST in main (before ts_setup_prototypes/ts_register_classes).
  Root (parentless) class protos chain to OBJECT_PROTO so class instances inherit it.
- R3 ("toString" in o): the `in` operator uses internFIELD ids but methods live
  under METHOD_KEY_BASE+internNAME ids. Fixed by having ts_has_prop, when its proto
  walk reaches g_object_proto, report true for the well-known names (toString/
  valueOf/hasOwnProperty) via a field-NAME check (is_object_proto_name).
- Verified vs V8: o.toString() / ""+o -> "[object Object]"; o.valueOf()===o; class
  instance .toString() inherited; a class that defines toString shadows it; "toString"
  in o true; hasOwnProperty true/false correct; Object.keys/values/JSON/console.dir do
  NOT leak toString (R2). ASan clean. Full CI green; perf unchanged (typed_field 187ms,
  obj_kernel 207ms) — R1 (class_reg_for) safe (plain objs' proto is g_object_proto, a
  distinct pointer from any CLASS_PROTO[i]).
- DIVERGENCES / deferred: String(o) coercion FUNCTION is a separate pre-existing gap
  (String() not implemented; fails loudly, not silently) — NOT addressed here.
  Object.entries runtime impl is also a separate pre-existing gap (declared in header,
  not defined). ts_to_string_v uses the built-in "[object Object]" and does NOT invoke
  a user-overridden toString during string coercion (minor divergence; method calls
  o.toString() do dispatch correctly).
