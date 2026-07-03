# D2: dynamic properties (computed names, Object.defineProperty)

## Scope decided
D2 originally listed three things; probing showed two were already done:
- class getter/setter syntax: ALREADY supported (method-style dispatch)
- computed METHOD name in a class (`[M]() {}`): ALREADY supported
So D2 reduced to: (a) computed property NAMES in object literals, (b)
Object.defineProperty. Both implemented; accessor descriptors deferred (below).

## (a) Computed property names in object literals — DONE
`{ [expr]: v }`:
- string-literal computed key `{ ["lit"]: v }` -> interned at compile time (= normal field).
- numeric-literal key `{ [42]: v }` -> interned as its string form "42" (JS semantics).
- dynamic key `{ [k]: v }` / `{ [k+"2"]: v }` -> StoreFieldDynamic; ts_set_dyn
  interns the key string at runtime (and now coerces a non-string key to its
  string form for plain objects, e.g. a number key).
Verified against V8 incl. mixed literal/dynamic/normal keys, ASan clean.

## (b) Object.defineProperty — value descriptor DONE, accessors deferred
Special-cased in the exporter so the descriptor literal's shape is inspected:
- `{ value: v }` (optionally with enumerable/writable/configurable: true) ->
  obj[key] = v via StoreFieldDynamic; returns the object. Common case.
- `{ get()/set() }` accessor descriptors -> REJECTED loudly.
- `{ ..., enumerable:false | writable:false | configurable:false }` -> REJECTED
  loudly (the flat prop map has no per-property attribute bits, so we cannot
  honor non-default attributes; silently making an enumerable/writable property
  would be a silent miscompile).
- non-literal descriptor (an identifier/expression) -> REJECTED loudly (shape
  can't be inspected at compile time). Returns cleanly, no crash.

## Why accessors were deferred (careful scoping)
The runtime property model is `ts_prop { uint32_t key; tsv val; }` with NO
per-property flags; enumerability is derived from the key name (methods / "__"
prefix are non-enumerable). Supporting accessor properties or per-property
enumerable/writable bits via Object.defineProperty would require either growing
every ts_prop (touches find_slot / ts_get / ts_set) or a side table keyed by
(object,key) with GC-lifetime handling, plus get/set interception in the hot
property path. That is disproportionate for a rare dynamic-definition feature,
and class-syntax getters/setters (the common need) already work. Deferred until a
real workload needs runtime-defined accessors; rejected loudly until then.
