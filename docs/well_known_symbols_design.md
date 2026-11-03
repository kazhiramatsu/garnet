# Well-known symbols

Session 363. Runtime (`runtime/ts_rt.c`, `runtime/regexp/ts_regexp_adapter.c`), library
(`lib/node/web/regexp_protocol.ts`), exporter, emitter.

## Why

`Symbol.match`, `matchAll`, `replace`, `search`, `split`, `species`, `isConcatSpreadable`, `unscopables`, `dispose` and
`asyncDispose` read `undefined`, so `{ [Symbol.replace]() {} }` made a property named "undefined": silent. test262 names
them in some 680 cases (`Symbol.species` 295, the five matcher symbols 338, `isConcatSpreadable` 35).

## The symbols

`TS_WKSYM_*` 5 to 14, keyed `TS_KEY_WKSYM(id)` as the first five are, so a computed key folds to the same property in a
class, an object literal and a read. `ts_symbol_ctor_link` defines all of them on `Symbol`, not writable, not
enumerable, not configurable.

## The RegExp protocol

The specification writes `String.prototype.replace` as a call of `searchValue[@@replace]`, and that method over `exec`,
`flags` and `lastIndex` read from the object, one `exec` per match. A program is not going to pay for this: `s.replace(/x/g, y)`
is the engine's direct path, the literal's program compiled ahead of time and no result arrays.

The direct paths cannot be told from the protocol unless a program can reach the difference, and it can only by naming
something. So the protocol is a library a program compiles only when it names it:

- The trigger is the program's own text: `Symbol.match` and the other four, a write of `.exec`, the string `"exec"`,
  `extends RegExp`. A method named `exec` on a class of its own, and `Reflect.ownKeys`, are not: real programs have those.
  `Object.getOwnPropertySymbols(RegExp.prototype)` in a program with no trigger does not list the methods.
- `lib/node/web/regexp_protocol.ts`, a prelude part on demand, is the specification in TypeScript: `@@match`, `@@matchAll`,
  `@@replace`, `@@search`, `@@split`, `test`, `%RegExpStringIteratorPrototype%`. In C it would be 500 lines of rooting.
- In such a program the exporter lowers none of the direct forms (`lowerRegExpCall`), and a string or RegExp receiver of those
  methods reads as `any`, so a call is the dynamic one. `g_regexp_protocol` (set at startup, the field
  `__garnet_regexp_protocol`) makes the string methods call the argument's method, with the receiver as it is, before any
  ToString, and makes `new RegExp` and the `includes` family ask IsRegExp through `@@match`.

`RegExp.prototype.flags` reads the eight flag properties from any object in every program: it is not on a hot path.

## Species

Next slice: `Array[Symbol.species]` and the others, `ArraySpeciesCreate` for `map`, `filter`, `slice`, `splice`, `concat`,
`flat`, `flatMap`, `TypedArraySpeciesCreate`, `ArrayBuffer.prototype.slice`, `Promise.prototype.then`.
