# Toward V8 parity on the native TypeScript compiler — structural roadmap

Status (Session 350, 2026-10-18): the native TypeScript 6.0.3 compiler checks
and emits its own compiler project in about 16.6 s against Node 25's 3.3 s
(5x). The session's incremental work (lazy prototypes, property-addition
cache, const-enum folding, inline fast paths, the closure environment ABI)
took the ratio from 7.3x to 5x. The remaining gap is structural: even with
every runtime helper removed, the generated code alone would still be about
3x V8. This document lists the structural changes, each cut into slices that
can be implemented, gated and measured on their own. It is the plan the
following sessions execute; measurements go to `bench_results.md`, progress
to `TODO.md`.

## Where the time goes (profile of the Session 350 build)

| bucket | share | mechanism |
|---|---:|---|
| generated code | ~57% | per-access handle deref, shape check, external property vector; per-call frame init, argument arrays, `nargs` checks |
| GC | ~12% | minor tracing (random cell loads), allocation path, payload frees |
| calls | ~9% → ~4% after the env ABI | `ts_call` dispatch, this-injection copies |
| property runtime | ~7% | additions, polymorphic probes, dictionary paths |
| strings/regexp/memory ops | ~8% | scanner loops, regexp backtracking, buffer growth |

A property read `node.kind` today performs three dependent loads
(handle table → cell → property vector) plus a shape compare; V8 performs a
map check and one in-object load. A call performs frame zeroing, argument
array stores, a merged-argument prologue and a root-frame push; V8 passes
arguments in registers with a fixed frame. Those two differences dominate.

## Track A — object model v2: shape-owned keys and in-object slots

Goal: a monomorphic read becomes `shape check + load`, a cell holds its first
N property values inline, and property memory halves.

Today `ts_object` (72 bytes) points at a `ts_prop[]` vector of 16-byte
`{key, val, flags}` entries; the shape id already identifies the key sequence
(transition tree, `shape_transition`). Deletion moves an object to shape 0
(dictionary) and the vector keeps carrying keys and flags.

Invariants to keep: shape == key order for non-dictionary objects; property
descriptors (flags) per property; sized class instances (`ts_new_sized`)
with struct fields resolved through `class_field_lookup`; enumeration order;
the PIC contract (`property_pic_design.md`); byte parity of emitted C (all of
this lives in the runtime and the header's inline helpers, so emitted text
does not change).

Slices:

1. **Shape tables** — give every shape a shared descriptor: key vector and
   flag vector, built on transition. `find_prop` for non-dictionary objects
   walks the shape's keys; the object's vector keeps `{key,val,flags}` for now
   (no layout change). Gate: conformance, parity (unchanged), runtime units.
   Purpose: prove the shape tables are complete before depending on them.
2. **Value-only vectors** — non-dictionary objects store `tsv vals[]`
   (8 bytes per property); keys/flags come from the shape. Dictionary objects
   (shape 0) keep the old `ts_prop` vector behind a kind flag. All property
   paths (`find_prop`, `props_append`, PIC inline read/write, enumeration,
   descriptors, deletion to dictionary, GC scanning, JSON) switch on the kind.
   Expected: property memory −50%, better cache density. Gate: full set plus
   GC stress, benchmarks.
3. **In-object slots** — allocate objects with inline capacity: object
   literals use their literal property count, constructor functions use a
   per-constructor estimate learned at runtime (slack tracking: the first N
   instances record their final length), `ts_new_object()` defaults to a small
   capacity. The PIC entry records whether the slot is inline (offset in the
   cell) or external. Expected: one fewer dependent load on every property
   access of small objects (nodes, types, symbols). Gate: full set, GC stress
   (moving cells copy inline slots), benchmarks, compiler A/B.
4. **Transition ICs** — the store-site cache records the transition itself
   (already done out of line by the property-addition cache); with shape tables
   the inline store path can perform the append when inline capacity allows.

## Track B — pointer-stable old generation (handle elimination)

Goal: references to old cells become direct pointers, removing the handle
table load (and its cache miss) from the majority of accesses.

The old generation never moves; only nursery cells move (aging, promotion).
References to young cells keep using handles. When a minor collection
promotes a cell, every reference it traces is rewritten from handle form to
pointer form. References that the collector does not see (raw tsv in C locals)
keep working, because the handle stays valid for the cell's lifetime.

Invariants and hazards: identity comparisons (`===`, Map/Set keys, PIC
prototype guards, the addition cache) must treat a handle reference and a
pointer reference to the same cell as equal. Slice 1 therefore adds an
identity-normalizing compare (`ts_same_cell`) and switches all identity sites
to it, measured on its own; slice 2 adds the rewrite in the minor collector;
slice 3 makes `ts_ptr` branch-free for pointer form. Hash tables keyed by
object identity (Map/Set/WeakMap, interning) need an identity hash stored in
the cell (slice 1b) so rehashing is never required. Full-GC compaction stays
disabled for old cells (it is today).

Expected: most `ts_ptr` calls on long-lived data (nodes, types, symbols, the
checker's tables) lose one dependent load; `gc_mark_visit` for old targets
already avoids the cell via the handle generation bit introduced this session.
Gate: full set, GC stress with forced moving, compiler A/B.

Status (Session 350): B1 and B2 implemented
(`docs/pointer_stable_old_gen_design.md`); measured 11.03 → 10.87 s (1.5%),
well below the expectation above. B3 (branch-free `ts_ptr`) is not worth a
slice on its own; the value of the track is the stable-address invariant
that later slices (raw record pointers, cached receivers) can use.

## Track C — call convention v2

Goal: direct calls pass arguments in C parameters and skip frame work when
provably unnecessary.

Slices:

1. **Known-arity direct entry points** — for functions whose call sites are
   all direct (no closure value escapes, no `arguments`, no rest), emit a
   second entry `fn_X_d(tsv a0, tsv a1, ...)` that the direct call sites use;
   the generic `(args, nargs)` entry forwards to it. Removes the argument array
   stores and `nargs` tests at ~15k direct sites.
   Status: landed in Session 350 (`docs/direct_entry_design.md`): every
   function without `arguments`, rest parameters or a coroutine frame has
   the entry, whether or not a closure value of it escapes (the forwarder
   keeps function values working); 32,799 direct sites use it, 9.57 → 9.23
   s (3.6% less). Parameters arrive in the representation the body uses
   (`tsv`, `double`, `long long`).
2. **Frame elision** — functions without allocation and without calls that can
   allocate (pure field/arith helpers such as `getObjectFlags`) skip the root
   frame push and the undefined fill. Requires a per-function "may allocate"
   summary from the analyzer (interproc already computes call graphs).
3. **Lazy frame initialization** — initialize only the slots that are live
   before the first GC point; the remaining slots are set when first written.
4. **Closure devirtualization** — a local function declaration called through
   its own binding (never reassigned, never escaping before the call) becomes
   a direct call with its cells, instead of `ts_call_value` on the closure.
   Status: landed in Session 350 on top of the scope records (the direct
   call passes the records of the callee's free variables; a declaration
   never used as a value is not hoisted as a closure at all): 10.99 → 9.72 s
   (11.5% less), `ts_call_value` sites 22,545 → 4,621. An assignment to a
   function declaration binding is a loud reject. The interprocedural
   escape analysis gives no summaries to a recursion nest of more than 128
   members (the checker's 1,609 directly-calling nested functions), so the
   scope records passed to them still count as escaping; a cheaper summary
   domain for large nests would let those records be stack-allocated.
5. **Capture contexts** (V8-style scope records, suggested after comparing
   with Lua's upvalues) — instead of one heap cell per captured variable and
   an environment array per closure, each scope activation that has captured
   variables allocates one context record holding them as fixed-offset
   fields; a closure stores a single context reference (inline in `ts_func`,
   no environment buffer) and nested scopes chain contexts, with a fresh
   context per loop iteration for per-iteration `let` bindings. Reads become
   one field load after resolving the context handle once at function entry;
   the typed-struct/SROA machinery applies to the record. Lua's open upvalues
   mainly optimize the enclosing function's own accesses while the frame is
   live, which escape-guided stack cells already cover; the record removes the
   per-variable cells and the per-closure environment copies that dominate
   the compiler's factory-style code (31M closures per run). Slices: exporter
   scope records, emitter/runtime single-reference closures, field access.
   Status: slice C5a (typed cells: every cell is an instance of the synthetic
   class `__cell`, so reads and writes are struct accesses instead of cached
   property lookups) landed in Session 350: 15.29 → 12.89 s (15.7% less).
   Slice C5b-1 (scope records for function-scope bindings, closures capture
   the record; `docs/capture_contexts_design.md`) landed in the same session:
   13.54 → 11.94 s (11.8% less). Remaining: block records for per-iteration
   bindings (C5b-2), unboxed numeric record fields (C5b-3), raw record
   pointers once the old generation is pointer-stable (C5b-4).

## Track D — collector

1. Handle generation bit (done, Session 350): minors and barriers classify
   old targets from the table entry.
2. Payload-aware minor trigger: count malloc'd string/environment/property
   bytes toward the nursery trigger so dead payloads are released sooner
   (bounds the RSS growth seen after lazy prototypes).
3. Stack watermark for root scanning: frames below the deepest frame reached
   since the last minor only need rescanning if they were modified; measure
   first (41k root slots per minor on the compiler).
4. Nursery sizing experiment (`TSAOT_GC_NURSERY_BYTES`): fewer minors versus
   survivor copying; decide a default from paired runs.

## Order and gating

Tracks A and C are the largest wins and are independent; B depends on A's
identity work only through the compare helper. Suggested order: A1, A2, C1,
A3, C2, B1, B2, B3, then C3/C4 and D2–D4 as measured. Every slice: design
note in the relevant `*_design.md`, `TSAOT_*` knob only when emitted text
changes (byte parity oracle), full gate set, paired compiler A/B recorded in
`bench_results.md`, session entry in `TODO.md`.
