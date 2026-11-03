# garnet — Claude Code working guide

**garnet** is an AOT compiler from TypeScript to C (formerly named tsaot). The frontend
(exporter) is TypeScript; the analyzer/emitter is **implemented mainly in Rust** (self-hosting
was demonstrated in §313, but for build-performance reasons the main development was moved back to
Rust in §315; selfhost is kept as a performance metric).
**Write commit messages, code comments, and documentation in English.**

> Note: the internal identifiers and the cargo binary name are still `tsaot` (renaming is on hold
> because the blast radius is large). Do not bulk-replace `tsaot` in the source without an explicit
> instruction.

## Read these first, in order
1. **The end of `docs/TODO.md`** (by session number) — this is the **single source of truth for
   progress**. Read the tail first to grasp the current state.
2. On first use, or before setup is complete, `CLAUDE_CODE_HANDOFF.md` (setup steps and workflow details).
3. **For how to actually do the work (build / V8 diff / debugging / search map / post-fix gates /
   pitfalls), see `docs/agent_workflow.md`** — the practical handbook covering "fixing one bug through
   to committing it safely."

## Progress-logging rules
- **Accumulate the progress log by appending to the end of `docs/TODO.md`. Do NOT store progress in
  memory (MEMORY.md)** (putting it in memory bloats and stales the context; what the repo should record
  belongs in the repo).
- Append a numbered summary of each completed session to TODO.md.
- Write new log entries in English. (The existing history is Japanese; new entries go in English.)

## Discipline
- **Fix bugs one at a time via V8 diff.** Source `scripts/difftest.sh` and run
  `dt "name" 'function main(){...}main();'`, or use `diff` from `build/diff.sh`. Compare garnet's native
  output against node (= V8).
- **Prioritize eliminating silent miscompiles (silently wrong values).** A reject must be loud (a
  compile-time error or a catchable throw). Silently ignoring is not allowed.
- **Keep perf regressions at zero.** Do not add branches/cost to the hot path (if you must, gate it
  behind a single predictable branch).
- Completion criteria: **all conformance green + ci_fast/unit + bench (perf budget) + bundler all
  green.** Add a minimal conformance test for each new feature.

## Layout
- `exporter/` … TS→IR. The sole frontend implementation. A primary development target.
- `analyzer/` … Rust. **The main implementation and the locus of development (unfrozen in §315**; the
  cargo binary name is `tsaot`). emit_c (`analyzer/src/emit_c.rs`) does IR→C. Behavior-invariant
  refactors are verified by byte-parity against the frozen analyzer_ts (`scripts/emitc_diff.sh`
  327/327). Changes that alter the output come after parity graduation (plan P4).
- `analyzer_ts/` … The TS-based analyzer (the self-hosted version). **Frozen in §315 (source changes
  forbidden; no porting of new features).** Its roles are ① the flagship benchmark (a real-program load
  of 66k instructions) ② the byte-parity oracle during the mechanical-Rust-refactor phase.
- `runtime/ts_rt.c` … The shared runtime. A primary development target.
- `runtime/regexp/` … garnet's regular expression engine (`docs/regexp_vm_design.md`): parser, bytecode
  compiler, backtracking VM, generated Unicode tables, and the adapter that owns the RegExp objects.
- `lib/garnet/` … garnet's own modules (`garnet:shared`, `garnet:json`, `garnet:ndarray`, `garnet:metal`,
  `garnet:llama`, `garnet:llama_metal`): TypeScript compiled with the program (the exporter maps `garnet:*`
  here); a `<name>_node.ts` beside one is the V8 oracle's polyfill (`scripts/garnet_scheme_loader.mjs`).
  The runtime side is a `__garnet*` host object in ts_rt.c (`runtime/node_host.c`, `runtime/metal_host.c`
  are included at its end).
- `lib/node/` … the Node.js modules (`node:path`, `node:fs`, ...; `docs/node_compat_design.md`): TypeScript
  compiled with the program over `runtime/node_host.c` (`__garnet_node`). Under the V8 oracle a `node:`
  import is Node itself, so every fixture in `tests/conformance/exhaustive/node/` is a differential test.

## Development policy (since session 315: Rust-centric)
- **Do new development in Rust (analyzer/), the exporter, and the runtime.** Do not port features into
  analyzer_ts (it is frozen; the only exception is the minimal fixes needed to keep the selfhost bench
  compilable, with output-invariance proven by parity).
- **selfhost is a performance metric**: as the flagship benchmark, measure the speed at which garnet
  compiles the frozen analyzer_ts and the emit speed of the generated native. Typed-native builds go
  through `scripts/typed_selfhost.sh` (selfhost_typed.ts).
- Verification is two-tier: behavior-invariant Rust changes = byte-parity (`emitc_diff.sh`) / changes
  that alter output = V8 diff (conformance + bundler + diffall/fixpoint) + bench budget. See
  `docs/refactor_master_plan.md` (v2) for details.

## Cross-cutting lessons (not obvious from the code, and they bite every time)
- **TS/ESM is always strict.** Sloppy behavior (e.g. silently ignoring a write to a frozen object) is a
  silent miscompile. Running the oracle in the same module format as the execution engine (ESM) surfaces
  hidden semantic drift.
- **Whole-program AOT is inherently bundling-oriented.** `ts.Symbol` keying + the checker's alias
  resolution make module linking almost free.
- **When you add a new field to an IR struct (Local/ClassDef etc.), you must also update the
  construction sites in `analyzer/.../sroa.rs` and the literal files under `tests/*.rs` (six build a `Function` literal as of Session 356).**
- **GC: a function that allocates must root its live tsv arguments** (root/unroot around clone/new).
  Confirm with the GC-stress probe.
- **A runtime array the collector marks as roots must shrink as it is consumed.** The microtask
  queue was drained by a local index and marked from 0: a promise-only program (one drain from start
  to end) kept every coroutine it had resumed alive (Session 358: hono_app 2.2x, 234 -> 19 MB). Mark
  the pending range only.
- **When a closure captures a loop variable, writes to the variable must always go through the capture
  cell (StoreField VALUE).** A raw direct write to the local bypasses the cell and yields undefined.
- **Type-driven optimizations (unbox/SROA) tend to drop values.** Watch out for `never`/conditional
  types and per-body processing (array SROA does not see whole-function escape). Err on the safe side.
- **Methods boxed onto the proto must be created after g_function_proto is initialized** (so that
  `.call`/`.apply`/`.bind` resolve).
- **A namespace mismatch between the METHOD key and the FIELD key is a regular cause of silent DIFFs.**
- **A field has one struct view** (`field_struct`, Session 362). The class structs are flat, a subclass's
  does not contain its parent's, so clang's TBAA takes `((Sub*)p)->f3` and `((Base*)p)->f3` for two
  objects and a load passes a store (silent, default and strict). Every access to a class field, new
  emission included, goes through the declaring class's struct.
- **A cache keyed by a class word assumes one prototype chain per word.** A class in a function has a
  prototype per evaluation: an instance of a later evaluation carries `TS_CLS_RELINKED`
  (`ts_instance_of_evaluation`) and takes the full lookup, or a site's cache answers the first evaluation's
  method (silent, Session 363).
- **A fact about a parameter needs every call that reaches the entry, the function's own calls among them.** An argument
  the first pass could not prove was skipped, so the integer entry of a recursive function took the one outside call's
  constant for the parameter (`gcd(1071, 462)` was 147, Session 363). What is assumed of a recursive call holds only as
  far as something validates it: an integer, here, and no constant, range or sign.
- **Every value with the object selector is read before its kind is known.** Generated guards take `cls` and `shape` at
  their offsets from anything `ts_is_obj` admits, so a cell that does not begin with `ts_obj_common` keeps both words zero and
  says so in a `_Static_assert` (`TS_CELL_ZERO_WORDS`). A BigInt's first limb stood there: `1n instanceof A` was true (Session 363).
  What must leave such a cell out of an object test is `ts_is_prim_cell`; `ts_is_obj` alone says "selector", not "object".
- **`ts_to_num` is a raw bit reinterpretation (not ToNumber).** `undefined`→NaN matches JS, but
  `null`→NaN does not.
- **Gate a new feature behind a single predictable branch** (e.g. `if (g_has_proxies && ...)`) = zero
  hot-path regression when the feature is unused.
- **Under machine load, absolute bench numbers are untrustworthy. Judge by direct A/B measurement.**
- **AOT design**: there is no runtime Environment Record. ResolveBinding is delegated to the TS
  checker's compile-time scope resolution = builtin detection is symbol-based (shadow-aware).

## Known remaining items (low priority, intentionally deferred)
- Precision of int-specialized `+`/`-` loop variables in the rare case they straddle [2^53, 2^63]
  (V8 uses double rounding).
- Array.prototype monkey-patch: a replaced method (`Array.prototype.push = f`) is not seen by a typed call
  (outside the model; replacing or deleting `Array.prototype[Symbol.iterator]` is honored: a program that
  names it walks every array through the protocol, Session 363).
- An array with accessor elements (`Object.defineProperty(a, 1, { get })`) in a program that does not name
  `Array.prototype`: the generic methods read every element first (a getter runs more often than under V8,
  `indexOf` does not stop at its find, `copyWithin` writes through an accessor it would not reach). A
  function's `length` redefined moves to the end of its keys; `delete arguments.length` is a ReferenceError
  (V8: true). V8 itself answers `Object.isFrozen` true for a non-extensible empty array and a sealed function,
  whose `length` and `prototype` stay writable; garnet answers false, as the specification does (Session 364).
- A method borrowed with a `this` of another class (`D.prototype.d.call(x)`) takes a clone whose `this.m()` calls
  dispatch by name (Session 364, `docs/foreign_receivers_design.md`), except an async or generator method and an
  arrow function inside the method (its `this` is a capture). An own method assigned through an `any` value
  (`const d: any = new D(); d.y = f`) is not seen by `this.y()` in D's methods: writes through `any` are trusted,
  where a write through a value typed as D makes the class dynamic.
- A monomorphized numeric class field (`x: number`, unboxed double) reads as 0 before its first
  assignment (V8: undefined). Boxed fields and typed cells are initialized to undefined (Session 350).
- Likewise a `number`-typed parameter that receives no argument (a call or `new` through an `any`
  cast with fewer arguments) reads as 0 in typed mode (V8: undefined); the direct entry has no
  representation for a missing number (Session 350 x32 note).
- An `any` value that holds a non-number, assigned to a `number`-typed local, is unboxed in
  typed mode (V8 keeps the value; garnet reads NaN): typed mode trusts the annotation (Session 350
  x53 note). An explicit `x as number` with nothing behind it, and a number field out of JSON, are `any`
  used in place and a TypeError flowing into a number slot (`docs/cast_to_number_design.md`).
- A property read through an index signature (`d.zz` with `d: Record<string, number>`, the key absent)
  is typed `number` by the annotation and read unboxed in typed mode: garnet reads NaN and `typeof`
  says "number" where V8 gives undefined. The keyed form (`d[k]`, `d["zz"]`) keeps the value
  (Session 353 real-projects note; lowering `obj["lit"]` as a named access was reverted for this).
- A declared class field without an initializer is laid out (and enumerated) at its declaration
  position, the ES2022 `useDefineForClassFields` semantics; under the legacy semantics (the
  conformance oracle transpiles at ES2020, a project with a lower target) V8 creates it at its first
  assignment, so its key order differs there (Session 354). A static written through `this` on a
  subclass that has no static container of its own lands on the ancestor's container.
- A `number` class field whose every static store is an integer is an integer slot (Session 353,
  `docs/int32_fields_design.md` "Store-proven fields"); a dynamic store of a fraction into it
  (`(n as any).pos = 2.5`) throws a TypeError naming the field (V8 stores the fraction).
  `TSAOT_INT_STORE_FIELDS=0` turns it off.
- An ordinary (non-const) enum's member with a constant value is read as that constant at every
  `E.A` / `E["A"]` site (Session 355), as TypeScript inlines const enum members: a write to the enum
  object through `any` (`(E as any).A = 5`) is not seen by those reads, and a read before the enum's
  module has evaluated (an import cycle) gives the constant where V8 throws. The enum object itself
  is intact for `Object.keys(E)`, `E[0]` and a variable key. `TSAOT_ENUM_FOLD=0` keeps the loads.
- A private name (`docs/private_names_design.md`) is one per class declaration, not per evaluation: an
  instance of one evaluation of a class in a function passes the checks of another. An element read
  before its initializer ran answers undefined (V8: a TypeError), and a frozen object's private field
  cannot be written.
- `Request.signal` is the init's signal itself (Node: a fresh signal following it), and
  `ArrayBuffer.isView` does not recognize the library's `DataView` (docs/web_fetch_api_design.md).
- Web Crypto (`docs/web_crypto_design.md`) provides digests and HMAC keys only: an RSA, ECDSA or AES key
  stops at `importKey` / `generateKey` with a `NotSupportedError` (Node imports them).
- WHATWG streams (`docs/web_streams_design.md`) are default streams only: `new ReadableStream({ type:
  "bytes" })` and BYOB readers are a TypeError (Node has them). `new CompressionStream("brotli")` is a
  TypeError (no brotli codec; gzip, deflate and deflate-raw run over the system's zlib loaded on first
  use, docs/web_compression_design.md).
- JSX (Session 358, `docs/jsx_react_ssr_design.md` section 8): under the automatic runtime a `key`
  attribute after a spread attribute (`<A {...p} key="k">`) is a compile-time reject (TypeScript
  calls the import source's `createElement` there); `react-jsxdev` builds the production runtime
  (`jsx` / `jsxs` of `jsx-runtime`, no source positions); `jsxImportSource` is resolved from each
  JSX file as TypeScript resolves the synthetic import. A typed `.toString()` / `.valueOf()` on a
  receiver that is not a string (a cast lied, a String wrapper) takes the receiver's own method.
- A dynamic `import()` of a module the program does not have rejects at run time with an Error (hono's
  `cloudflare:workers` probe, any specifier known at run time only); of a bundled module it is evaluated
  when asked (`docs/dynamic_import_design.md`). `new X()` of a constructor the environment declares but the runtime lacks
  (CustomEvent, WebSocket) is a ReferenceError where it is reached (Node without the
  global throws there too); `console.trace` as a value is the error writer (no stack).
- `Promise.prototype.finally` called on a thenable that is not a promise is a garnet TypeError (V8
  builds its thenFinally / catchFinally for any receiver); then and catch on other receivers follow V8
  (Session 358).
- `node:async_hooks` provides `AsyncLocalStorage` and `AsyncResource` (docs/async_context_design.md):
  `createHook`, `executionAsyncId` and the other tracing ids are not provided (an import of them is a
  compile-time error), and an EventEmitter's listeners run in the emitting caller's context.
- A program with no visible freezer (no `Object.freeze`, no `Object`/`Reflect`/`globalThis` as a value,
  no `freeze` read or spelled out) emits no frozen test on typed stores; `O[k](instance)` with `k`
  computed at run time and `O` obtained through `.constructor` is a TypeError at the freeze (V8 freezes,
  Session 362).
- A class extending an expression, a built-in other than the Error kinds or a value, and a class whose
  methods or static initializers capture a function's locals, is a value made at run time
  (`docs/dynamic_classes_design.md`): nothing types its instances, they are read by key. `super()` inside an
  arrow function is a compile-time reject there.
- `Function.prototype.toString` answers `function name() { [native code] }` for every function (a compiled
  program keeps no source text): a library that reads a function's source sees no body. `err.stack` is the
  header and one `at <anonymous>` line, made when read. A WeakRef holds its target strongly and a
  FinalizationRegistry never calls back, as the specification allows.
- A recursion the C compiler makes a loop spins where V8 throws a RangeError, when it has an exit that is never taken
  (`if (n < 0) return 0; return f(n + 1) + 1;`); one with no exit keeps its calls and overflows (`docs/exceptions_design.md`).
  A sparse array past 2^29 elements stays sparse and a generic method over it (`indexOf`, `join`) is a RangeError
  where V8 walks its dictionary; its own keys, values and `console.log` come from the table. `new Float64Array(2 ** 33)` is a RangeError where V8 maps it lazily. V8's cycle error
  has the path in its message, garnet's is the first line; a cycle past 1024 levels is found up to 1024 levels late.
- A property name is interned for the life of the run: a program that makes unbounded distinct dynamic keys grows, and stops loudly at 1.9 G of them.
  A dense integer-keyed plain object is a dictionary of those names (V8: elements), x35 of Node on a million keys.
- A dead-zone read of a class binding other than `new` and `instanceof` is undefined, and the static analysis does not see through an import cycle
  (`docs/tdz_design.md`). `Number.prototype.valueOf` installed on a typed `Date` instance is not seen by `d.valueOf()` (a builtin receiver's method is static).
- A class whose constructor returns a value is a dynamic class, its subclasses too (`return new Proxy(this, h)`); a private element on a Proxy `this` is a TypeError at its read.
- A `for..in` over a Proxy does not skip a key deleted during the walk (its keys and descriptors are read at the start, V8 reads each
  descriptor at the visit). `Array.prototype.join.call(arrayLike)` through the array library has no cycle stack (a plain array has, Session 363).
- A typed receiver that is a Proxy (vue's reactive arrays and collections) takes its methods through
  the traps, but a typed `for..of` over one, and a cursor `for..of` over a Proxy of a Map or Set,
  walk a snapshot taken through the iteration protocol at loop entry (elements added during the
  loop are not visited; an array's or a Map's are). The array species lookup (`constructor`) is not
  modelled, and the generic read methods over a Proxy read each element behind a `has` (V8's `join`
  and `includes` do not): a get trap's sequence differs in those details, the values agree
  (Session 354 vue note).
