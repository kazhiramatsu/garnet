# Array.prototype over any receiver

Session 363. Library (`lib/node/web/species.ts`, `lib/node/web/array_generic.ts`), runtime, exporter. Species is in
`docs/well_known_symbols_design.md`, the storage of unusual elements in `docs/dictionary_arrays_design.md`.

## Why

The runtime's array methods are written for an array. For anything else (`Array.prototype.map.call(obj, f)`, a Proxy, a
dictionary array) `arrproto_elements` read the elements into a plain array once and ran the method on the copy, and
`arrlike_*` did the same for the mutators. Every value came out right on an ordinary object, but the order of `[[Get]]`,
`[[HasProperty]]`, `[[Set]]` and `[[Delete]]` is the specification's business: a callback that deletes an element it has not
reached, a getter that changes `length`, a Proxy's trap log. test262's ES5 families (`15.4.4.x`, some 1500 cases) test
exactly this.

## The library

`array_generic.ts` is the specification's text in TypeScript, all 35 methods, over `toObject(this)`. It costs a program
nothing unless it can pass a receiver that matters, and the test is on the program's text, as for the RegExp protocol:
`Array.prototype` or `[].x.call`. A real program with `Array.prototype.slice.call(arguments)` compiles the library, and an
array there still takes the runtime's method:

- Each method on `Array.prototype` becomes a wrapper: `host.isPlainArray(this) ? builtin.apply(this, args) : spec.apply(this, args)`.
  Its `name` and `length` are set from the table; it is a method, so `new` refuses it.
- A typed site (`arr.map(f)`) does not read the prototype: it calls `ts_array_map`, which sees a plain array, or falls to
  `ts_method_dynamic` for a Proxy and a dictionary array, which reads the wrapper.
- `host.replaceMethod`: a built-in prototype holds a method under its METHOD key and its FIELD key, and a first-class read
  (`LoadMethodValue`) takes the METHOD key, so a replacement must take both. A user's `Array.prototype.map = f` still
  takes only the FIELD key: such a patch is outside the model.

`Object.defineProperties` reads every descriptor first (`normalized_descriptor`), in own-key order, symbols among them,
then defines: a bad second descriptor leaves the target untouched.

## Holes and the prototypes

A hole reads through the prototype chain in the specification: `Array.prototype[1] = "x"` makes `[0, , 2][1]` read "x". An
inline read had `array_is_hole(v) ? TS_UNDEFINED : v`. It now calls `ts_array_hole_value` on the hole, which tests one
global (`g_proto_elements`), so the path of a value is what it was and a hole costs a load.

`g_proto_elements` is set when an index key lands on `Array.prototype` or `Object.prototype` (`proto_element_note`, on the
store and define paths), only under `g_proto_tracking`, which the library sets: Array.prototype becomes a dictionary array so
that its stores reach the runtime, and arrays with holes then go to the library. With the flag up, the read-only methods of
a typed site (`ARRAY_HOLES`, `array_species_custom`) dispatch to the same table.

An array as a prototype (`F.prototype = [1, 2, 3]`) answers its length and elements on the chain (`array_link_get`).

## Gaps

- `keys`, `values`, `entries` and the array iterator stay the runtime's.
- A store to a hole does not consult the prototypes (a setter on `Array.prototype[1]`), and neither do a typed site's
  mutating methods; a program through `any` takes the library.
- `Object.setPrototypeOf(arr, { 0: "x" })`: the elements of any other prototype of an array are not seen by a hole.
