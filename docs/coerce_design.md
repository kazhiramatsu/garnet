# String() / Boolean() coercion + user toString in ts_to_string_v — design

## Goal
- String(x) -> string coercion (currently: undefined function call -> runtime fail)
- Boolean(x) -> boolean coercion (same gap)
- Number(x) -> ALREADY works (number.coerce / ts_number_coerce). No change.
- ts_to_string_v(obj): invoke the object's (possibly user-overridden) toString
  instead of always returning the built-in "[object Object]". So:
    class P { toString(){return "P!"} }
    `"" + new P()` -> "P!"  (was "[object Object]")
    String(o) for plain o -> "[object Object]" (Object.prototype.toString)

## Key dependency
String(x) for objects must call x.toString(). So implement the user-toString
path in ts_to_string_v FIRST, then String() = thin wrapper around ts_to_string_v.

## How the runtime learns the toString method-key
Methods live under METHOD_KEY_BASE + internName(name); the runtime doesn't know
internName ids. We already register Object.prototype.toString in the emitted
ts_setup_object_proto(). Add: a runtime global g_tostring_key, set by a new
runtime hook ts_set_tostring_key(uint32_t key) that the emitted setup calls with
METHOD_KEY_BASE + <toString name-id>. Then ts_to_string_v can do
ts_get(obj, g_tostring_key) to find toString on the proto chain.

g_tostring_key defaults to 0 (unset). When 0, ts_to_string_v falls back to the
built-in behavior (so pre-setup calls and programs without the proto still work).

## ts_to_string_v new object branch
For an object value v (not str/num/bool/undef/null/array):
  if g_tostring_key != 0:
     tsv m = ts_get(v, g_tostring_key);
     if (ts_is_callable(m)) {
        tsv r = ts_call(m, &v, 1);     // this = v (method convention: args[0])
        if (ts_is_str(r)) return r;    // normal case
        // toString returned non-string: coerce its result (guard recursion: if
        // it returns an object, fall through to built-in to avoid infinite loop)
        if (!ts_is_obj(r)) return ts_to_string_v(r);
     }
  return ts_new_string("[object Object]", 15);   // fallback
Arrays keep their existing join path (handled before this branch). Note: arrays
also have Object.prototype via their... actually arrays are TS_KIND_ARRAY, not
objects with proto; the ts_is_array branch stays as-is (join), matching JS
Array.prototype.toString.

Recursion safety: a user toString that returns `this` (an object) would loop; we
break by only recursing when the result is a non-object primitive, else fall to
"[object Object]". Bounded and safe.

## String() / Boolean() lowering (exporter)
Mirror the Number(x) block in lowerExpr's global-builtin section:
- String(x), 1 arg, not a user fn  -> CallBuiltinStatic "string.coerce" [x]
- Boolean(x), 1 arg, not a user fn -> CallBuiltinStatic "boolean.coerce" [x]
Codegen (emit_c.rs expr builtins):
- "string.coerce"  -> ts_to_string_v(v0)            (boxed string, not numeric)
- "boolean.coerce" -> ts_bool(ts_truthy(v0))        (boxed bool, not numeric)
Also add to the "is a known static builtin name" allowlist (exporter ~line 781)
if needed so they aren't treated as unknown.

## Risks
- R1 perf: ts_to_string_v object branch now does ts_get+ts_call. Only for object
  string-coercion (not numbers/strings); kernels unaffected. Verify perf.
- R2 recursion/UB: guarded (only recurse on non-object toString result).
- R3 GC: ts_call may collect; v is the only input and is held by caller; root v
  across the call to be safe.
- R4 String() on a class with a NUMERIC field that overrides toString returning a
  number: we coerce the number to string (matches JS: String(x) calls toString,
  if it returns a primitive uses it). Verify with a class returning non-string.
- R5 ordering: g_tostring_key set in ts_setup_object_proto (called first in main),
  so it's ready before any user code. Pre-setup internal ts_to_string_v calls see
  key==0 -> built-in fallback. SAFE.

## Verify vs V8
String(o) plain -> "[object Object]"; String(123)->"123"; String(true)->"true";
String(null)->"null"; String([1,2])->"1,2"; class P{toString(){return "P!"}}
String(new P()) & ""+new P() -> "P!"; Boolean(0/""/null/undefined)->false;
Boolean(1/"x"/{})->true; class with toString returning a number. ASan, full CI, perf.

## IMPLEMENTED (final)
Status: DONE.
- Runtime: g_tostring_key (set by emitted ts_set_tostring_key in ts_setup_object_proto).
  ts_to_string_v object branch now does ts_get(v, g_tostring_key); if callable, calls
  it (this=v) and uses a string result; non-object primitive result is recursively
  coerced; object result / unset key falls back to "[object Object]". v rooted across
  the call. Arrays keep their join path.
- Exporter: String(x)/Boolean(x) (1 arg, not a user fn) -> CallBuiltinStatic
  "string.coerce"/"boolean.coerce". Number(x) was already number.coerce (unchanged).
- Codegen: "string.coerce" -> ts_to_string_v(v0); "boolean.coerce" -> ts_bool(ts_truthy(v0)).
- SOUNDNESS FIX (escape): BinOp "+" now escapes both operands. `"" + new P()` and
  template literals route through ts_add -> ts_to_string_v -> the object's toString;
  without escaping, the object (only used by +) was SROA'd to undefined. Numeric +
  operands escaping is a harmless no-op (not heap-tracked); perf unchanged (verified:
  int_kernel 386ms, float_kernel 257ms, typed_field 183ms, all within budget).
- Verified vs V8: String of num/bool/null/undefined/array/plain-obj/user-toString-class;
  ""+obj and `${obj}` call user toString; Boolean truthiness; Number unchanged. ASan
  clean, full CI green, golden `coerce` added.
- Note: ts_to_string_v recursion guarded (only recurse on non-object toString result),
  so a toString returning `this` can't loop.
