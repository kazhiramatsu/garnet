# Real projects: compiling and measuring them

The real-project benchmarks compile a workload written against a real TypeScript project's
sources with garnet and run the same program under Node, with the project's own `tsconfig`
(`garnet -p`). Each project is a clone under `build/real/<name>` (not in the repository); the
driver and its tsconfig live in `benchmarks/real/<name>/` and are copied into the clone as
`garnet-driver.ts` and `garnet-tsconfig.json`:

    bash benchmarks/real/run.sh hono 3      # <name> [runs]; median wall time of each engine

`benchmarks/real/ab.sh binA binB [runs]`, run inside the clone, alternates two builds of a driver and
prints each run's time and the medians: the form every tuning change here is measured in.

`run.sh` builds the native binary, transpiles the import graph for Node with the repository's
TypeScript (`benchmarks/real/transpile_tree.js`: `.ts` to `.mjs`, specifiers rewritten, a bare
specifier through `garnet-paths.json` when the project maps workspace packages), runs both inside
the clone, compares their stdout (the driver prints a checksum of its results) and prints the
median of `runs` timings each driver reports on stderr. A project may add `env.sh` (sourced first:
`TSAOT_DEFINE`, the build-time constants both engines see), `stubs/` (stand-ins for third-party
modules the benchmark configuration never calls, copied into the clone as `garnet-stubs/`) and
`types.txt` (npm typings the stubs re-export, installed once under the clone's `garnet-types/`).

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
- `fn.apply(thisArg, arrayLike)` with an array-like argument list (`{ length: 2, 0: a, 1: b }`,
  `arguments`, a view) passes the elements by index; the runtime had called with no arguments for
  any non-array (the call/apply fixture of the tuning round caught the silent miscompile).

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
| `fn.call` / `fn.apply` lowered to the runtime's implementations, the cache on receivers with dynamic properties, an O(1) `shift` | 399 | 149 | 2.7 |

(the last row is an alternating A/B of the two binaries, five runs each: 525.3 against 398.9.)

The first profile put 22% in the chain walk of `destination.next` (an interface-typed subscriber
reading a prototype method as a value, 13.7 M out-of-line reads): the method cache's (class
word, key) entry now answers an inherited property read on a sized instance (the holder's shape
word and slot, re-read on every hit). The receivers with own dynamic properties (an
`OperatorSubscriber` assigns `this._next = ...`) still take the slow path (2.0 M reads left).

What the second profile showed (`sample`, 300 rounds): `project.call(thisArg, value, index)` in
map and filter read `call` through the function's prototype chain on every value (5.9 M
out-of-line reads, 11.8 M probes, 11% with `invoke_with_this`); `Array.prototype.shift` on the
mergeMap and concatMap buffers moved the elements (5%); the try/catch of every delivered value
(`OperatorSubscriber._next`, `ConsumerObserver.next`) costs its setjmp (3%); `errorContext(() =>
...)` allocates a closure per `next`. The third row's three changes:

- `f.call(thisArg, ...args)` and `f.apply(thisArg, arr)` whose receiver type names
  Function.prototype's member (a function-typed value; the default library's `Function`,
  `CallableFunction` and `NewableFunction` interfaces) are lowered to the runtime's
  `ts_funcproto_call` / `ts_funcproto_apply` over the argument vector, without the `call` read;
  a spread argument keeps the generic path.
- The (class word, key) cache also answers an inherited read on a sized receiver with own dynamic
  properties (an `OperatorSubscriber` assigns `this._next = ...`) once its map shows it lacks the
  key (2.0 M reads had still walked the chain).
- `shift` on an array of more than 16 elements moves `data` up one slot over the same buffer (the
  buffer's base is `data - front`; `front` is a byte, folded back at 255 or when the buffer grows;
  `unshift` reuses the slack): amortized O(1), as V8's left-trim; a short array still moves its
  elements.

The second round's changes were within the noise for rxjs (391 -> 385 ms alternating): no full
collections to pace, few absent reads, and the null check and the borrowed-method lookup were a
small part of a call.

After the first round (3132 ms for 300 rounds, from 5089): the generated subscriber chain itself leads
(`OperatorSubscriber._next`, `Subscriber.next`, the operator closures), then `ts_call` (7%: the
closures called through the generic entry), `invoke_with_this` with the receiver check (6%: the
`this._next(value)` call of an own function-valued property), the try/catch (5.5%), the
out-of-line reads that remain (7%), and the closure `errorContext` allocates per `next`. Next:
the setjmp of a try region, the receiver check and the argument copy of a call through a
function-valued own property, and whether a closure passed to a callee that only calls it can
live on the stack.

## yaml

`benchmarks/real/yaml/driver.ts` parses a 500-line document of records to plain values,
stringifies it back and parses it through the Document API, 300 rounds over 16 distinct string
objects of the text; the checksum adds the parsed fields, the output lengths and a hash of the
output. Outputs identical. Wall: garnet 5911 ms, Node 1289 (4.6x).

The first profile (`sample`): yaml's lexer and parser are generators delegating to generators
(`yield* this.pushSpaces(true)`), and garnet's generator machinery dominated: every generator
object's creation allocated a promise (`coro_alloc` -> `ts_promise_new_v`, 13% of the samples;
only an async generator needs one), every `next()` built its `{value, done}` result through two
dynamic property additions (`ts_set_named_prop` -> `props_append_f`, `shape_transition_f`, about
15%), and the collector's share was 17% (the nursery refills and marks of those objects). Then
the regular expressions of the scalar lexer (4%), and `===` on one-character strings
(`isEmpty`'s `ch === ' '`, a content compare: 4%; V8 compares internalized one-character strings
by identity).

| state | garnet | Node | ratio |
|---|---|---|---|
| first run | 5911 | 1289 | 4.6 |
| the rxjs changes (unchanged, as expected) | 5945 | 1327 | 4.5 |
| a sync generator's frame without a promise; the generator object and the iteration result in their layouts | 4980 | 1327 | 3.75 |
| the second round (below): the full-collection pacing, the absent-read cache of class instances, the drivers' scratch result, a 176-byte smaller coroutine header | 4618 | 1439 | 3.2 |
| the third round: a generator's numeric locals in the frame only when live across a suspension | 4244 | 1300 | 3.3 |
| the boxed locals the same way (the conservative collector scans the native stack) | 3931 | 1304 | 3.0 |
| the fourth round: a read-only define on a non-prototype keeps the caches' epoch; short ASCII literals as immediates | 3590 | 1291 | 2.8 |

(the second row's A/B ran on a slower machine state, Node included: 5154 against 4618 alternating, a 10%
gain; the third's: 4430 against 4244, 4%; the fourth's: 4237 against 3931, 7%; the fifth's: 3913 against
3798 and then 3790 against 3590, 3% and 5%; each ratio uses its own run's Node time.)

(alternating A/B, five runs each: 5944.9 against 4980.2.) The sync generator entry allocates its
frame through `ts_coro_alloc_gen_v/_vn` (no `ret` promise: its results are plain objects and an
uncaught throw reaches the caller); `ts_gen_new_v` and the three result builders (`next`,
`throw`, `return`, and `ts_iter_result`) allocate their objects in a `ts_lit_layout` with slot
stores, as a literal does.

After them (5205 ms for 300 rounds): the collector is 20% of the samples (the minor collections
mark the document under construction; they are triggered by the allocation of a `{value, done}`
per `next()`, 924 inclusive samples under the resume functions, and of a generator object and
frame per delegated `yield*`), then property reads (`prop_find` 290: the regexp adapter's object
reads per `test`, the chain walks of `composeScalar` and `createNode`), the regular expressions
(4%), `===` on one-character strings (3%), and the generator protocol itself (`ts_gen_next`,
`coro_alloc`, `ts_coro_resume_v`, the setjmp of a resume, `ensure_gen_fields` on every step).
The second round went by the counters (`--rt-stats`), which named the collector's cause: 13.6 M
coroutine frames of 848 to 1,872 bytes (30 GB in a 6-second run; `ts_coro` alone was 752 bytes,
384 of them two `jmp_buf`s) and, after the first full collection left 2 MB live, a full-collection
threshold within one nursery of the live heap, so every nursery fill elected a full collection:
8,472 full collections and 125 minor ones. The changes:

- The full-collection headroom covers a full nursery (`live + 4 MiB + the nursery's byte cap`): the
  young cycle alone never elects a full collection; promotions do. yaml: 150 full and 6,075 minor
  collections, the pauses 1,369 -> 900 ms.
- A (class word, key) record of an absent read on a sized receiver, validated by the chain's shape
  words and the addition epoch as the plain-object records are (yaml's nodes read their `declare`d
  optional properties, which are no struct fields, on every visit): 11.2 M hits, 8.5 M -> 4.5 M
  out-of-line absent reads, `find_prop` 152 M -> 129 M calls.
- The iteration drivers (`for...of`, `yield*`, spread) step a known generator through
  `generator.step`, the coroutine's own `{value, done}` rewritten each step (the drivers read both
  slots at once and never keep the object; `gen.next()` in the program stays fresh); the same path
  serves a native generator object a dynamic step resolves.
- The two landing pads of a resume (`eh_buf`, the async `reject_buf`) are `jmp_buf`s on the resume
  function's stack (armed on every entry, popped before every suspension), and the in-frame handler
  slots are two instead of eight: `ts_coro` 752 -> 176 bytes, the frames 23 GB. The frozen
  emitter's output names the old fields, so the byte-parity oracle diverges on coroutine programs.
- Also in the round, within the noise: the method receiver's null check in line, the borrowed-method
  lookup skipped for a function that takes no `this`, two hashed heap strings compared by hash
  before any view.

After it (4,799 ms for 300 rounds, 5,205 before): the collector 12% (the frames still 23 GB: a
generator's every local has a frame slot, dozens of `long long` slots in the lexer's methods), the
regular expressions 4%, property reads 5%, `===` on strings 2%, the generator protocol itself 6%,
and property additions that miss their cache (`prop_pic set` 19.5% hits, 7.8 M slow additions).
The third round took the frames' numeric slots: the emitter had given every local of a generator or
async function a frame slot (the lexer's methods: 245, 168, 163 numeric slots in one frame each,
mostly `long long` temporaries of a few instructions' life). A liveness pass over the flattened body
(`coro_stack_numerics`, with the exception edges of the try and finally regions the `yield*`
lowering emits around every delegation step) keeps in the frame only the numerics live at a resume
point; the others are C locals of the resume function, zero at entry as the zeroed slot read. yaml's
numeric frame slots 2,292 -> 235, the frames 23.1 -> 15.6 GB, the minor collections 6,075 -> 4,295;
4,430 -> 4,244 ms alternating. The boxed locals followed by the same rule: the conservative
collector (the default; `TSAOT_CONSERVATIVE_ROOTS=0` keeps the frames as the roots and then only the
numerics leave) scans the native stack, so a `tsv` C local of the resume function is a root like any
ordinary function's. yaml's frame slots 5,314 -> 691 in all (`tsv` 3,022 -> 456), the frames 30.3 GB
at the start of the day -> 5.8 GB, the minor collections 2,000, the pauses 1,369 -> 614 ms; 4,237 ->
3,931 ms alternating. (The first version counted an instruction's operands with `inst_uses_any`,
which names only some of them: the array of a push, the index of an element store were not uses, so
a receiver evaluated before an `await` and used after it left the frame; `iteration/iterator_close`
caught it, the pass now takes every reference of the exhaustive operand remapper less one occurrence
of the definition.) The fourth round took the two causes the counters named next. yaml defines a read-only property
on every node (`Object.defineProperty(this, NODE_TYPE, { value })` in the node constructors), and a
read-only data or accessor definition moved the addition and absent caches' epoch, as it must when
the object is somebody's prototype (an inherited write changes meaning): 45k times per parse, every
cached addition and absent record thrown away each time (`prop_add` 4.5 M slow additions, the
absent cache's hits at 0). An object now records that it became a prototype (`TS_HDR_IS_PROTO`: at
birth for the objects made as prototypes, and where a link is made: `ts_set_proto`, a fresh
object's link, `Object.create`, an ES5 `new`), and the epoch moves only for such an object, a class
prototype or a function: slow additions 4.5 M -> 1.8 M, out-of-line absent reads 4.5 M -> 0.9 M,
the collector's pauses 614 -> 486 ms, 3,913 -> 3,798 ms alternating. Then the lexer's `ch === ' '`
(`isEmpty`, a string switch) reached the content compare on every call: a literal of at most five
ASCII units was a static heap cell while the one-character string read out of the source is the
runtime's short immediate, so the two never compared by bits. The emitter now packs such a literal
the way the runtime does (`TS_BOX(TS_SEL_SHORTSTR, ...)`, 1,517 of them in yaml's program) for the
constant, the literal compares and the switch labels: 3,790 -> 3,590 ms alternating.

Next: the additions that still miss (1.8 M: sites whose receivers come in several shapes, and the
3.6 M objects that outgrow their four inline slots), the regular expressions, and the frame per
delegated `yield*` itself (13.6 M frames of 426 bytes on average).

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

## What vue taught garnet (session 354)

vue core's reactivity is Proxies around arrays, Maps and Sets, with the typed program calling
`state.todos.push(x)`, `for (const t of state.todos)`, `m.forEach(f)` and `m.size` on values whose
static type is the array or the collection. garnet's typed entries for those operations had never met
a Proxy: `ts_array_push` ignored a receiver that was not an array, `length` read 0, the typed `for..of`
walked 0 elements, `filter` returned `[]`, `includes` false, a Map's `size` threw. Every one of them
was a silent miscompile of a correct program. The fix is one rule, implemented where each entry
already tests its receiver, so an array pays nothing:

- **A typed entry whose receiver is a Proxy takes the method through the traps**
  (`ts_method_dynamic`: the property of that name read through the receiver, called with it; gated
  by `g_has_proxies` in the entries' existing non-array branches). `length` reads through the get
  trap (`ts_array_len_foreign`); a typed `for..of` collects what the receiver's iteration protocol
  yields and walks that (`forof.arraySource`, a snapshot); a Map/Set typed entry dispatches the same
  way, `size` through the trap, and the cursor-driven `for..of` walks a Map or Set built from the
  receiver's protocol (`map.cursorSource`); `push(a, b)` and `unshift` hoist the array test and take
  one dynamic call with every argument, so vue's instrumented push sees them together as V8's does.
- **The function-value forms run the generic algorithms over an array-like `this`**
  (`Array.prototype.push.apply(proxy, args)` is how vue's instrumentation mutates): push, pop,
  shift, unshift, splice, sort, reverse, fill and copyWithin over properties read and written through
  the receiver (`arrlike_*`, the specification's order of stores and deletes), the array iterator over
  an array-like, `concat` and `toString` reading the elements through the traps; the Map and Set
  prototype function values reject a receiver that is not their collection, as the specification
  does, which also keeps a Proxy whose trap yields the builtin from re-entering the typed entry's
  dispatch. `Array.isArray` sees through a Proxy, `JSON.stringify` serializes a Proxy of an array as
  an array, `Array.from` of a Proxy takes the protocol without probing internal keys, and the
  change-by-copy methods (`toSorted`, `toReversed`, `with`, `toSpliced`) exist on `Array.prototype`.
- **A trap receives the canonical string key**, never a number: vue's `isIntegerKey` decides from it
  whether a store is an element's and which dependencies to trigger; with number keys the array
  iteration dependencies never fired and a computed stayed stale (the checksum differed by a few
  effect runs: the silent kind).
- **`Object.prototype.toString`'s builtin tags**: vue's `toRawType` sorts a value by
  `Object.prototype.toString.call(v).slice(8, -1)`; garnet said "Object" for a Map, so a reactive
  Map got the plain-object handlers and the builtin `forEach` ran on the Proxy. Map, Set, WeakMap,
  WeakSet, Promise, Error (and its subclasses), Date, a Proxy (its target's tag), Math and JSON now
  carry their tags, and `String(v)` / `v.toString()` of such an object fall back to the same tag.

The rest were constructs and typings vue's sources use: the `arguments` object as a value (an
array of the actual arguments; the function keeps its generic entry), `new Function(src)` as a
catchable EvalError at run time (vue's dev-only expression validator and the SSR stringifier are
never reached in the browser configuration, but the program must compile), an instance field
initializer reading a cyclic import's class (deferred like a function body, not a top-level TDZ
hazard), the module evaluation order computed over runtime edges only (a type-only import had
ordered `ast.ts` after `parser.ts`, whose top level reads an enum of `ast.ts`), `(obj.method as
any)(x)` and `obj.cb!(x)` keeping their receiver, a generator type test that no longer takes every
`IterableIterator` for one of garnet's coroutines (vue casts an array iterator to that type and
wraps its `next`), `String(symbol)` as the descriptive string (a template or `+` with a symbol is
the TypeError), and compile-time constants (`TSAOT_DEFINE="__DEV__=false,__BROWSER__=true,..."`:
an ambient identifier folds to the constant and an `if` / `?:` / `&&` / `||` it decides compiles only
the branch taken, as vue's own bundler does; `transpile_tree.js` substitutes them for Node).

Deviations kept (CLAUDE.md known items): the `arguments` object is an Array; a typed `for..of`
over a Proxy and a cursor loop over a Proxy of a Map or Set walk a snapshot (elements added during
the loop are not visited; an array's or a Map's are); the array species lookup (`constructor`) is
not modelled; the generic read methods read each element behind a `has` (V8's `join` and
`includes` do not), so a get trap's sequence differs in those details while the values agree.

## vue

`benchmarks/real/vue/` compiles vue core 3.5 (`build/real/vue`, `pnpm` is not needed: the
workspace packages map to their sources through `paths.js`, the compiler's third-party modules to
stand-ins in `stubs/` whose types come from the real `@babel/types` and `@babel/parser` typings
installed under `garnet-types/` from `types.txt`, and `env.sh` sets the production browser build's
flags). The driver runs two workloads in the production browser configuration:

- **reactivity**: a reactive store (an array of todo objects, a nested object, a Map and a Set,
  refs, a shallowRef, a readonly view), computed chains over it and effects, mutated in a loop:
  every read and write is a Proxy trap, tracking links subscriber and dependency nodes, a computed
  re-evaluates lazily from its dirty flag (4 rounds of 600 mutations);
- **compiler**: eight templates (a todo app, a data table with slots, a form, a static article,
  dynamic components with Teleport/KeepAlive/Transition/Suspense, nested v-for/v-if trees, a cart
  table, a chat view) compiled to render-function source by `@vue/compiler-dom` (the tokenizer and
  parser, the node and directive transforms, codegen; no babel: a browser does not prefix
  identifiers), 400 rounds.

The checksum adds the effect run counts, the computed values and a hash of the generated code, and
the driver prints each round's counts and each template's code length and hash, so a difference
names its phase.

| state | garnet | Node | ratio |
|---|---|---|---|
| first run (reactivity 4 x 600, compiler 400 rounds) | 2,240 | 762 | 2.9 |
| a field key's canonical string, the trap invariants' fast exit, the trap names' keys | 1,606 | | |
| a Proxy receiver's set landing on its target (no descriptor objects) | 1,614 (noise) | | |
| the canonical strings pre-hashed, the toString tags as static cells | 1,578 | 758 | 2.1 |
| direct calls of module-level const functions (`@vue/shared`'s helpers) | 1,569 | 766 | 2.0 |
| an ordinary enum's members folded to their constants (`ReactiveFlags`, `TrackOpTypes`, the compiler's `NodeTypes`) | 1,342 | 767 | 1.75 |

The first run is the correctness milestone. The first tuning round (alternating A/B against the
previous binary each time) took the reactivity phase from 1,749 to 1,030 ms:

- **A field key's canonical string** (`ts_key_to_value`): a key handed to a Proxy trap as a string
  was a fresh heap string per access, which vue's handler then read back through
  `Reflect.get(target, key, receiver)`, `hasOwn(instrumentations, key)` and `depsMap.get(key)`: an
  interning (hash, probe, byte compare) each, and a Map lookup comparing bytes. Each field key now
  has one static string cell made on first use, carrying its key id (`TS_STR_FLAG_KEY`) and its
  hash: string to key and key to string are O(1), and the Map lookups compare identities.
- **The trap invariants' fast exit** (`proxy_target_may_constrain`): after every get, set and has
  trap the runtime built the target's own property descriptor (an object with four fields) to check
  the specification's invariants, which only a non-configurable or read-only property can violate. A
  plain object or array that is not frozen, sealed or non-extensible and has no attribute records
  skips the check; a Proxy receiver without `getOwnPropertyDescriptor` and `defineProperty` traps
  completes a set on its target directly instead of through two descriptor objects.
- The trap names' keys interned once (`proxy_trap_key`), and `Object.prototype.toString`'s fixed
  tags as static cells (vue's `toRawType` calls it on every value `reactive()` wraps).

The profile after the round: vue's `get` trap itself (8%), the dynamic property reads inside it
(`ts_get_pic_checked`, `prop_find`, `lookup_prop_chain`), the Map lookups of `track`, and the calls
of `@vue/shared`'s helpers, which were module-level `const f = (...) => ...` bindings called through a
function value. Those are direct calls now (a const function that reads neither `this` nor
`arguments` is called like a function declaration, its TDZ kept by a binding check): vue 1,617 ->
1,569 ms, yaml 3,585 -> 3,546 ms, rxjs unchanged. The remaining gap is the trap dispatch itself: the
`get` trap's body, the dynamic property reads inside it and the Map lookups of `track` / `trigger`. The other projects did not
move: yaml 3,570 -> 3,575 ms and rxjs 383.9 -> 384.0 ms alternating against the previous binaries
(the new tests sit in the typed entries' non-array branches and at a loop's entry).

### The second round: the enum members

The profile after the direct calls (`sample` over the production build) put 35% of the run inside
vue's `get` trap, and the trap's own body (6.7% self) began with five comparisons of the key
against `ReactiveFlags.SKIP`, `IS_REACTIVE`, `IS_READONLY`, `IS_SHALLOW` and `RAW`. `ReactiveFlags`
is an ordinary (non-const) `enum`, and garnet folded only const enum members, exactly the set
TypeScript's own emit inlines: each comparison loaded the constants module's scope record, read the
enum object out of it, read the member through a property cache and compared two strings by
content. The whole compiler phase does the same with `NodeTypes.ELEMENT`, `ElementTypes`,
`ConstantTypes` and `PatchFlags` on every node it visits, and every `track()` passes
`TrackOpTypes.GET` the same way. An ordinary enum's literal members fold now
(`plainEnumMemberValue`, exporter.ts): the program is typed, so a member is read-only in it and
the enum object's property can only ever hold the declared value; the object itself stays for the
reflective uses (`Object.keys(E)`, `E[0]`, `E[k]` with a variable key), a computed member keeps its
field load, and a `declare`d enum, whose object comes from outside the program, is left alone.
vue 1,565 -> 1,342 ms alternating (Node 767: 2.0x -> 1.75x); the comparisons became literal
compares (a short immediate or a static cell against the trap's canonical key string), and the
numeric switches over `node.type` became C switches.
