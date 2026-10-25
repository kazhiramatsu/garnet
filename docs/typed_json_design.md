# Typed JSON: `parse<T>` from `garnet:json`

Session 353. `JSON.parse` returns `any`; a typed program casts it (`as User`)
and the cast is where wrong data enters typed mode silently (a string in a
`number` field reads NaN). bun's `JSON.parse<User>` (`bun build --compile
--aot`) validates the text against the type at run time and throws a
TypeError naming the offending field. Garnet has the checker at compile time
and knows the layouts, so the same idea fits it naturally: the type becomes
a schema, the parse validates against it, and the objects it builds have the
type's literal layout, so the fields they feed read through the predicted
slots.

## The API

```ts
import { JSON } from "garnet:json";
type User = { id: number; name: string; tags?: string[] };
const u = JSON.parse<User>(text);          // validated; a TypeError names the path
const v: User = JSON.parse(text);          // T inferred from the contextual type
```

`lib/garnet/json.ts` exports `parse<T>(text: string, schema?: string): T`
and `parseWithSchema(text, schema)`. The exporter sees a call of `parse`
with one argument, takes the instantiated `T` from the resolved signature's
return type, compiles it to a schema string and appends it as the second
argument. The schema is JSON (compact; compiled once per distinct string by
the module and cached):

| type | schema |
|---|---|
| `number`, `string`, `boolean`, `null`, `any`/`unknown` | `"n"`, `"s"`, `"b"`, `"z"`, `"*"` |
| a literal (`"a"`, `7`, `true`), an enum member | `{"k":"l","v":<literal>}` |
| `T[]`, `readonly T[]` | `{"k":"a","e":S}` |
| `[A, B]` (fixed) | `{"k":"t","e":[S...]}` |
| `Record<string, T>` (a string index signature, no named properties) | `{"k":"r","e":S}` |
| an object type (`p?: T` optional) | `{"k":"o","p":[["p",S,0|1]...]}` |
| a union, an enum | `{"k":"u","m":[S...]}` (`undefined` on a property makes it optional) |
| a named object type | `{"k":"ref","n":"Name"}`, defined once in the root's `"d"` |

The root is `{"d":{...},"s":S}`. Classes, `Map`, `Set`, `Date`, functions,
symbols, bigint, methods on an object type, tuples with optional or rest
elements, index signatures beside named properties and intersections that
are not object types are rejected at compile time (`UNSUPPORTED: typed JSON
cannot represent ...`).

## The parser (`lib/garnet/json_core.ts`)

A recursive-descent parser in TypeScript over the text, driven by the
compiled schema (class instances: `ObjSchema`, `ArrSchema`, `TupleSchema`,
`RecordSchema`, `UnionSchema`, `LitSchema`, `PrimSchema`, a `RefSchema`
resolved after compilation). The structure, the validation and the error
paths are TypeScript; the C side only builds objects:

- An object: the keys are matched against the schema's key index; an
  unknown key's value is parsed generically and dropped (structural typing
  allows extra properties; the result holds the type's properties); a
  duplicate key's last value wins; a missing required key is a TypeError.
  The present properties are stored in the type's declaration order (not
  the text's) through `__garnet.jsonMakeObject(layoutId, values)`: the
  runtime keeps a `ts_lit_layout` per distinct key sequence
  (`__garnet.jsonLayout(keys)` interns the keys once), so the object takes
  the literal layout of `{p1, p2, ...}` in one allocation and the same shape
  a literal with those keys has. The result's `Object.keys` order is the
  type's: documented, and the same under Node (the polyfill stores in the
  same order).
- A union: the member for the token kind (`{`, `[`, `"`, a digit, `t`/`f`,
  `n`); several object or array members (a discriminated union) parse the
  value generically and validate it against the members in order.
- Errors: a TypeError `"$.user.tags[2] must be number, received string"` or
  `"$.id is missing"`; malformed text a SyntaxError with the position. The
  messages are the module's own, so Node prints the same.
- Numbers are scanned strictly (JSON's grammar) and converted with `Number`
  of the slice; strings scanned with escapes decoded. Both are plain
  TypeScript loops over `charCodeAt` (the hoisted view path); C scanning
  primitives are the next step if a profile wants them.

Under Node (`scripts/garnet_scheme_hooks.mjs` maps `garnet:json` to
`lib/garnet/json_node.ts`) the same core runs with a JavaScript
`makeObject`; a call without a schema (the oracle never runs the exporter)
is a plain `JSON.parse`, so a fixture tests the typed path with valid inputs
and the explicit `parseWithSchema` for the error cases, both against V8.

## Gates

- Fixture `modules/typed_json` (V8 output identical, plain and strict): every
  schema kind, optional and missing properties, extra keys, duplicate keys,
  nested and recursive types, unions and literal unions, tuples, records,
  escapes and unicode in strings and keys, numbers at the grammar's edges,
  the error paths (type mismatch at depth, missing key, bad syntax).
- Kernel `patterns/json_typed`: a document of records parsed typed and
  generic, timed inside the program; against Node's `JSON.parse`.
- tsc-ts: unaffected (no `garnet:json` import).

## As built (Session 353)

- `lib/garnet/json.ts` (the garnet binding), `lib/garnet/json_node.ts` (the
  Node polyfill: plain objects in the type's key order; a call without a
  schema is the plain parse) and `lib/garnet/json_core.ts` (the parser).
  Exports: `parse<T>(text, schema?)`, `parseWithSchema(text, schema)`,
  `stringify(value)` and the namespace object `JSON = { parse,
  parseWithSchema, stringify }`.
- The runtime's `__garnet_json` host object (ts_rt.c): `layout(keys)`
  interns a key sequence as a `ts_lit_layout` and returns its id,
  `makeObject(id, values)` allocates the object in that layout's shape and
  fills the slots in order, `flat(text)` copies a buffer-view string (the
  result of a concatenation reaches its units through its parent on every
  read) into a flat string once per parse.
- The exporter: `typedJsonParseCall` recognizes a one-argument call of the
  module's `parse` (directly or as `.parse` on its `JSON` export; the import
  alias unwrapped), `typedJsonSchema` compiles the resolved signature's
  return type (the explicit type argument or the contextual type) to the
  schema string, `lowerTypedJsonParse` emits the direct call with the schema
  as the second argument. `TSAOT_TYPED_JSON_LOG=1` prints each derived
  schema; the unit gate `tests/typed_json_schema_gate.sh` pins 24 derivations
  and rejections.
- Two exporter fixes the module needed, both general: a module's top-level
  binding is substituted for an ambient name only inside its own file (the
  module's `export const JSON` had captured every `JSON.parse` in the program,
  including the parser's own generic fallback), and a module-scope `const`
  initialized with a literal (`const CH_QUOTE = 34`) reads as the constant
  instead of the module cell's field (`TSAOT_MODULE_CONST_FOLD=0` restores
  the cell read; a TDZ read is rejected before the fold applies).
- `scripts/garnet_scheme_hooks.mjs` resolves a relative import between
  garnet's modules (`./json_core`) to the `.ts` file; `scripts/pattern_bench.sh`
  runs Node with the scheme's loader for a kernel importing a garnet module.

### Performance (kernel `patterns/json_typed`: 20,000 records × 25 parses, 47 MB)

| step | native ms | what changed |
|---|---|---|
| first version | 937 | strings sliced for every key, `Map` lookups, a mask string per object, `Number(slice)` |
| keys hashed in place, integer bitmask, exact digit conversion, token codes | 532 | no key allocation; `mant / 10^k` for ≤ 15 digits |
| probe table of char codes, one path level per container, scratch value arrays | 421 | no `Map` on the key path; no per-property pushes |
| the text flattened once, cached host functions, inline token dispatch and whitespace checks | 261 | `ts_str_view_typed_slow` and the per-call `skipWs` gone |

The untyped `JSON.parse` kernel (`patterns/json_generic`) runs in 160 ms
(Node 204 ms, including startup); building the document alone is 28 ms. So
the typed parse costs 1.75× the runtime's C parser and about 1.4× V8's
`JSON.parse`, while validating and building layout-shaped objects. Node's
time for the typed kernel (333 ms) includes transpiling the module with the
TypeScript compiler at startup, so it is not a parse comparison.

What the profile taught about the generated code: the emitter hoists a
string's view out of a loop only when the loop body has no calls or reads the
string twice per iteration (a per-token scanner loop with an error call in a
branch is not "tight"), so the scanners are written as tight loops with the
terminator handled after the loop; a single `charCodeAt` outside a loop takes
the general path, which costs a view read, and a buffer-view string makes
every such read go through the parent (hence `flat`). What remains:
`parseObject` 33% (the key scan, the probe, the control flow), `parseNumber`
10%, `parseValue` 8%, allocation and GC 8%. Next steps if typed JSON becomes
a priority: C scanning primitives for strings and numbers, or a parser
generated per type by the exporter (monomorphic field stores into the
layout, no schema interpretation).

### Semantics, as implemented

- A property is optional when declared `?` or when its type includes
  `undefined`; an absent property is absent in the result (not present with
  `undefined`). `undefined` elsewhere in a type is dropped (JSON cannot carry
  it). An undeclared property's value is scanned and dropped; a duplicate
  key's last value wins; `Object.keys` order is the type's declaration order.
- A union resolves by the value's first character; when several members
  admit it (a discriminated union of objects), the value is parsed generically
  and validated against the members in order. Literal members compare by
  value; `boolean` in a union recombines `true | false`.
- Numbers follow JSON's grammar strictly (`01`, `1.`, `.5` are errors);
  `-0` is -0; a number with more than 15 significant digits or an exponent
  outside ±22 converts through `Number`.
- Errors: `SyntaxError("garnet:json: <what> at position N")` for malformed
  text, `TypeError("<path> must be <expected>, received <kind>")` and
  `TypeError("<path>.<key> is missing")` for a mismatch, where the path is
  `$`, `.key`, `[index]` segments. Both engines produce the same messages
  (the fixture compares them through `parseWithSchema`).
