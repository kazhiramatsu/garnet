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

## zod

`benchmarks/real/zod/driver.ts` parses a user schema with `parse` and `safeParse`. After the
constructs above, one reject remains: `class Definition extends Parent {}` in `core.ts`, where
`Parent` is a runtime value (`Error`, or `Object`); a probe also showed `Error` as a first-class
constructor value (`const P: any = Error; new P("x")`) throwing "Error is not a constructor".
Both are needed for zod; they are the next slice.

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
