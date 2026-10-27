# Real projects: compiling and measuring them

The real-project benchmarks compile a workload written against a real TypeScript project's
sources with garnet and run the same program under Node, with the project's own `tsconfig`
(`garnet -p`). Each project is a clone under `build/real/<name>` (not in the repository); the
driver and its tsconfig live in `benchmarks/real/<name>/` and are copied into the clone as
`garnet-driver.ts` and `garnet-tsconfig.json`:

    bash benchmarks/real/run.sh hono 3      # <name> [runs]; median wall time of each engine

`run.sh` builds the native binary, transpiles the import graph for Node with the repository's
TypeScript (`benchmarks/real/transpile_tree.js`: `.ts` to `.mjs`, specifiers rewritten, a bare
specifier through `garnet-paths.json` when the project maps workspace packages), runs both inside
the clone, compares their stdout (the driver prints a checksum of its results) and prints the
median of `runs` timings each driver reports on stderr.

## What the projects taught garnet (session 353)

The projects' own compiler options apply to garnet's library too, which turned up strictness
gaps the conformance corpus never exercised: `override` modifiers, `exactOptionalPropertyTypes`
(an explicit `undefined` passed to an optional member; the option interfaces of `lib/node` now
admit it), a project `lib` without `DOM` (added when the project's list lacks it: the runtime's
globals are typed by it), Node16/NodeNext module kinds (mapped to ESNext/Bundler: the program is
whole-program compiled, never emitted as CommonJS), and lint-only diagnostics (unused locals and
so on) in library files, which do not fail the type gate.

Constructs the projects used that garnet lacked, all implemented with conformance or bundler
fixtures: `export default <expression>` and an anonymous `export default function`, `export * as
ns from "m"`, `new Date(value)` with a Date, an ISO or `toString`-shaped string or any value,
`Date.parse`, `toUTCString`, `JSON.stringify` with a replacer (function or allowlist),
`Object.create(proto, descriptors)` and `x instanceof RegExp`.

## hono (routers)

`benchmarks/real/hono/driver.ts` loads the route table of hono's own router benchmark into a
router and matches its ten requests many times; the checksum adds the matched handlers and the
parameter counts. The TrieRouter is the measured router: the RegExpRouter, the PatternRouter and
the SmartRouter (which picks the RegExpRouter) match through regular expressions, and the regular
expression engine (QuickJS's backtracking interpreter behind the adapter, against V8's irregexp
JIT; the adapter also looked its compiled program up by pattern text on every `match`) is a
separate concern.

Two measurement lessons:

- **A split cache.** With one string object per request, Node matched in 124 ms where garnet took
  365 ms (2.9x). V8 caches `String.prototype.split`'s result by the string's identity
  (`StringSplitCache`), so the repeated identical objects skipped the split entirely. A server's
  paths arrive as fresh strings; the driver now matches 64 distinct string objects per request
  (equal content), and Node takes 251 ms.
- **Attribution by A/B.** Every runtime change was measured by alternating the previous binary and
  the new one seven times (`median`), on the same driver.

TrieRouter, 1,000,000 matches, distinct path objects, median wall ms:

| state | garnet | Node | ratio |
|---|---|---|---|
| before this session | 338 | 251 | 1.35 |
| pre-allocation GC check in line, small-array hole fill as four stores | 322 | | |
| a short substring flat, a flat string caching its key id | 313 | | |
| `obj["lit"]` as a named access (neutral; reverted, see below) | 313 | | |
| `split` by one character in one pass | 324 -> 310 (same run) | | |
| receiver class hints for generic classes | 295 | 251 | 1.18 |

(the middle rows were measured with the identical-string driver, 360 -> 332; the last two with the
distinct-string driver, 338 -> 324 -> 295.)

What each fixed:

- `gc_before_alloc` carried the full-collection pacing logic and was not inlined, so every
  allocation paid a call; the comparisons are in line now and the collections out of line.
- A `[]` literal's four inline slots were filled by a `memset_pattern16` call.
- `path.split('/')` produced view strings; a view's every later use (hashing, comparing,
  interning) went through the parent. Substrings under 13 units are flat copies (V8's
  sliced-string threshold).
- A heap string used as a dynamic key (`children[part]`, `params[name] = v`) was interned
  through the hash table on every access; a flat string now caches its key id in its `offset`
  word (`TS_STR_FLAG_KEY`; views and buffers keep their offset, a shared worker's heap is not
  written, `Buffer.byteLength`'s cache yields to it).
- `split` by a one-unit separator scanned the text twice (a count pass, then the cut pass);
  one memchr pass keeps the cut offsets on the stack.
- A generic class (`Node<T>`) took no receiver class hint, so every field read of a trie node
  went through the property cache out of line (`ts_get_pic_checked`, 13% of the profile); the
  hint names the class, whose layout is one per class, not per instantiation.

One change was reverted: lowering `obj["lit"]` as a named access measured neutral and failed
`gc/payload_props`: the named path reads a `number`-typed property as a number, so an absent key
of a `Record<string, number>` read NaN where the keyed path keeps `undefined` (the keyed path does
not trust the index signature's annotation; a plain `d.zz` on such a record is the same question,
noted as a known item).

The remaining profile is flat: array allocation (volume: a trie search allocates ten small
arrays), the interning of the fresh path segments, the segment strings themselves, and the
property cache for the null-prototype `children` records.

## What the next three projects taught garnet (session 354)

Constructs, again implemented with conformance fixtures:

- `class D extends Parent {}` with `Parent` a runtime value (zod's `$constructor` idiom): the
  exporter lowers a member-less class over a non-class base to a derived constructor the
  runtime builds (`ts_class_extend_dyn`: `new D(args)` constructs the base and gives the instance
  D's prototype, D's statics chain to the base, `D.name` is the class's). The Error constructors
  are first-class values (`const E = Error; new E(msg)`, `E(msg)`, `Reflect.construct`, one object
  per kind, `TypeError.__proto__ === Error`): a `native_ctor` function the runtime constructs
  through.
- `this` inside a static member is the class value, as in JS (`new this(schema)` in yaml's
  `Collection.from`, `this.name`, `this === C`, the singleton getter `this._inst ??= new this()`).
  It had been the proto-linked static container, which `new` could not construct. The static
  initializer takes the class value as a parameter and links it to the fresh container before any
  initializer runs; `C.m()`, `C.getter` and `C.setter = v` through the class name pass the class
  value; a class without a constructible value keeps the container. A static field read `Sub.x`
  now loads the subclass's own container (the chain finds an inherited one), so a static written
  through `this` in an inherited method (`++this.count` run as `Sub.bump()`) shadows the parent's.
- A class field redefined with non-default attributes on one instance (yaml's
  `Object.defineProperty(this, 'schema', { enumerable: false, configurable: true, writable: true })`
  in a constructor): the instance's sidecar map holds a record under the field's key
  (`TS_PROP_FIELD_ATTR`, its ordinary attribute bits clear so no enumeration or name walk reports
  it, the effective enumerable and configurable bits in the high bits); the value stays in the
  struct slot, so the typed accesses are unchanged; `delete` folds the record into the dictionary
  entry. A field cannot become read-only or an accessor this way (the inline stores would not see
  it): a TypeError, as before.
- `Object.assign` onto a function (a callable namespace: `Object.assign(function Buffer() {}, statics)`),
  a spread of a function's own properties, `Symbol.<unknown>` (`Symbol.observable`) reading as
  undefined so rxjs's feature test falls back to a string key, `Date.UTC`, `instanceof` with a
  callable builtin behind `typeof BigInt !== "undefined"` and with a union-typed right-hand side,
  `node:buffer`'s `Buffer` as a function (`typeof Buffer === "function"`), the named exports of
  `node:process`, `process.emitWarning` delivered on the next tick with Node's one-time hint.
- The Node side of a benchmark is now a program emit (`transpile_tree.js` with the project's own
  compiler options), so a re-export of a type-only name is elided as the project's own build would.

Two deviations noted rather than fixed: the conformance oracle transpiles at ES2020 (legacy
class-field semantics: a declared field without an initializer is created at its first
assignment), while garnet lays every declared field out at its declaration position, so the key
order of such a field differs under that oracle (the fixtures initialize their fields); and a
static written on a subclass that has no static container of its own lands on the ancestor's
container (V8: an own property of the subclass).

## zod

`benchmarks/real/zod/driver.ts` parses a user schema with `parse` and `safeParse`. The dynamic
base class and the Error constructor values compile; the run stops at module initialization:
`util.ts` builds `BIGINT_FORMAT_RANGES` with `BigInt("-9223372036854775808")` and friends, and
garnet has no bigint (CLAUDE.md known items: "the whole numeric-type story"). zod's bigint
schemas are not in the driver, but the constant is evaluated when the module loads, so zod needs
a bigint value type (a 128-bit integer with a loud overflow would cover zod and the usual feature
tests): a slice of its own.

## rxjs

`benchmarks/real/rxjs/driver.ts` runs synchronous pipelines over ranges (map, filter, scan,
mergeMap, take, zip, merge, pairwise, concatMap) and a Subject with three subscribers, 40 rounds;
the checksum adds the emitted values and the completion counts. Outputs identical. Wall, median
of 3:

| state | garnet | Node | ratio |
|---|---|---|---|
| first run | 709 | 152 | 4.7 |
| inherited reads of a sized instance through the (class word, key) cache | 534 | 152 | 3.5 |

The first profile put 22% in the chain walk of `destination.next` (an interface-typed subscriber
reading a prototype method as a value, 13.7 M out-of-line reads): the method cache's (class
word, key) entry now answers an inherited property read on a sized instance (the holder's shape
word and slot, re-read on every hit). The receivers with own dynamic properties (an
`OperatorSubscriber` assigns `this._next = ...`) still take the slow path (2.0 M reads left).

What the second profile shows (`sample`, 300 rounds): `project.call(thisArg, value, index)` in
map and filter reads `call` through the function's prototype chain on every value (5.9 M
out-of-line reads, 11.8 M probes, 11% with `invoke_with_this`); `Array.prototype.shift` on the
mergeMap and concatMap buffers moves the elements (5%); the try/catch of every delivered value
(`OperatorSubscriber._next`, `ConsumerObserver.next`) costs its setjmp (3%); `errorContext(() =>
...)` allocates a closure per `next`. Next: `fn.call`/`fn.apply` lowered to the runtime's
`Function.prototype` implementations without the property read, the inherited-read cache on
receivers whose dynamic properties lack the key, an O(1) `shift`.

## yaml

`benchmarks/real/yaml/driver.ts` parses a 500-line document of records to plain values,
stringifies it back and parses it through the Document API, 300 rounds over 16 distinct string
objects of the text; the checksum adds the parsed fields, the output lengths and a hash of the
output. Outputs identical. Wall: garnet 5911 ms, Node 1289 (4.6x).

The profile (`sample`): yaml's lexer and parser are generators delegating to generators
(`yield* this.pushSpaces(true)`), and garnet's generator machinery dominates: every generator
object's creation allocates a promise (`coro_alloc` -> `ts_promise_new_v`, 13% of the samples;
only an async generator needs one), every `next()` builds its `{value, done}` result through two
dynamic property additions (`ts_set_named_prop` -> `props_append_f`, `shape_transition_f`, about
15%), and the collector's share is 17% (the nursery refills and marks of those objects). Then
the regular expressions of the scalar lexer (4%), and `===` on one-character strings
(`isEmpty`'s `ch === ' '`, a content compare: 4%; V8 compares internalized one-character strings
by identity). Next: the promise only for async generators, the iteration result as a pre-shaped
object, canonical one-character strings.

## prisma

`benchmarks/real/prisma/driver.ts` parses and formats the largest schema with the PSL parser
(`@internal/psl-parser`, 345 workspace packages mapped by `paths.js`). The parser's value-import
graph reaches `@internal/framework-components/authoring` and from there `arktype` and
`@standard-schema/spec`, npm packages (no sources, no `node_modules` in the clone); garnet
compiles TypeScript sources, so this entry cannot be built as is. Type-only imports (`pathe`,
`tinyglobby` through `@internal/config`) are erased but still fail the type gate; a narrower
entry (the tokenizer) or stubs for the two packages are the options.

## effect

The main branch needs TypeScript 7 (two of its sources do not type-check under 5.9, the
checker garnet embeds). The benchmark targets the latest 3.x release (`effect@3.22.4`,
`build/real/effect`); its `index.ts` re-exports every module, and `Schema` imports
`FastCheck.ts`, a re-export of the npm package `fast-check`, so the driver must import the
modules it uses directly and avoid `Schema`, or stub `fast-check`.
