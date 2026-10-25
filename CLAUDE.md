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
- `lib/garnet/` … garnet's own modules (`garnet:shared`, `garnet:json`): TypeScript compiled with the
  program (the exporter maps `garnet:*` here); a `<name>_node.ts` beside one is the V8 oracle's polyfill
  (`scripts/garnet_scheme_loader.mjs`). The runtime side is a `__garnet*` host object in ts_rt.c.
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
  construction sites in `analyzer/.../sroa.rs` and the 4 literal files under `tests/*.rs`.**
- **GC: a function that allocates must root its live tsv arguments** (root/unroot around clone/new).
  Confirm with the GC-stress probe.
- **When a closure captures a loop variable, writes to the variable must always go through the capture
  cell (StoreField VALUE).** A raw direct write to the local bypasses the cell and yields undefined.
- **Type-driven optimizations (unbox/SROA) tend to drop values.** Watch out for `never`/conditional
  types and per-body processing (array SROA does not see whole-function escape). Err on the safe side.
- **Methods boxed onto the proto must be created after g_function_proto is initialized** (so that
  `.call`/`.apply`/`.bind` resolve).
- **A namespace mismatch between the METHOD key and the FIELD key is a regular cause of silent DIFFs.**
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
- bigint (the whole numeric-type story; fundamentally unsupported), and Array.prototype monkey-patch
  (outside the model).
- A monomorphized numeric class field (`x: number`, unboxed double) reads as 0 before its first
  assignment (V8: undefined). Boxed fields and typed cells are initialized to undefined (Session 350).
- Likewise a `number`-typed parameter that receives no argument (a call or `new` through an `any`
  cast with fewer arguments) reads as 0 in typed mode (V8: undefined); the direct entry has no
  representation for a missing number (Session 350 x32 note).
- An `any` value that holds a non-number, assigned to a `number`-typed local, is unboxed in
  typed mode (V8 keeps the value; garnet reads NaN): typed mode trusts the annotation (Session 350
  x53 note).
- A `number` class field whose every static store is an integer is an integer slot (Session 353,
  `docs/int32_fields_design.md` "Store-proven fields"); a dynamic store of a fraction into it
  (`(n as any).pos = 2.5`) throws a TypeError naming the field (V8 stores the fraction).
  `TSAOT_INT_STORE_FIELDS=0` turns it off.
