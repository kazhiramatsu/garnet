# Analyzer impact analysis for `scope_resolution.md`

Before implementing, this document walks every analyzer module and asks:
**which proposed changes affect it, and how?**

Earlier drafts of `scope_resolution.md` asserted "the analyzer doesn't
change". That's optimistic. This document corrects the record by going
module-by-module against each proposed change.

## Modules in the analyzer crate

```
analyzer/src/
├── escape_ir.rs     631  — IR data structures (the contract)
├── call_graph.rs    147  — P2: build call graph from IR
├── interproc.rs     669  — P3: summary-based escape analysis + closures
├── sroa.rs          637  — Scalar replacement of aggregates
├── devirt.rs        203  — Devirtualization
├── codegen.rs       153  — Codegen helpers (no Inst dispatch)
├── emit_c.rs       2333  — Emits the final C
├── main.rs           47  — Driver
```

## Proposed changes (recap, from `scope_resolution.md` § 10)

A. **Module bindings stop using `LoadGlobal`/`StoreGlobal`.** Those Inst
   variants stay in the IR as infrastructure for the GlobalEnvironment
   record. The exporter stops emitting them (no producers in v1); the
   `globals: Vec<GlobalInfo>` field, the `GlobalId` newtype, and the
   `internGlobal` helper all stay; the codegen for the two opcodes
   stays correct so future producers (`globalThis` writes, browser-
   classic-script mode, host-provided globals) work without re-adding
   anything.
B. Remove `moduleVars` in the exporter — module bindings become cells.
C. Add `__module_init` synthesis; module-scoped capturing `function f` →
   closure-value-in-cell, direct-call fast path retained for non-capturing.
D. Hoisting pass.
E. Class scope correctness (bare identifier in method body resolves to
   outer scope, not silently to `this.field`).
F. Static members: `__static_init_<classId>` synthesis, static blocks,
   per-class static container.
G. Private names: `privateFieldIdOf`, `privateMembersOf`, `HasField` IR
   op, runtime `ts_has_field`.
H. `main` auto-call removed; `function main` is just a regular module
   function from emit_c's perspective.

## Module-by-module impact

### 1. `escape_ir.rs` — IR contract (the source of truth)

This is the most-impacted module structurally, though now smaller since
we keep the GlobalEnvironment infrastructure.

**Keep (unchanged):**
- `Inst::LoadGlobal { dst, gref }` and `Inst::StoreGlobal { gref, src }`
  Inst variants (lines 478-479) — infrastructure for future producers.
- `pub globals: Vec<GlobalInfo>` on `Program` (line 65) — currently
  empty vec in v1, real entries when `globalThis` writes or browser-
  classic-script mode is supported.
- `pub struct GlobalInfo` (line 275) and `id_newtype!(GlobalId)`
  (line 45).

**Add:**
- `Inst::HasField { dst: LocalId, obj: LocalId, field: FieldId }` for
  private-name brand checks (`#x in obj`).
- `MethodKind::Static` variant — to distinguish static methods from
  instance methods in the class table (currently only `Method`,
  `Getter`, `Setter`).
- A static-fields list on `ClassDef`: e.g.
  `pub static_fields: Vec<FieldEntry>` parallel to the existing
  `own_fields` for instance fields.
- A static-init function id on `ClassDef`: e.g.
  `pub static_init: Option<FunctionId>` pointing at the synthesized
  `__static_init_<classId>` function for that class.
- A "private" flag (or alternative MethodKind) for private methods,
  AND a `private_fields: Vec<FieldEntry>` for private instance fields,
  plus `private_static_fields: Vec<FieldEntry>` for static private
  fields. (Alternative: a single `members` list with a kind+access
  enum — less churn for the consumers.)

**Add (module-linkage, v2-reserved — see `export_value_sharing.md`):**
- `BindingKind` enum on `Binding`: `Local` | `LocalExport` |
  `ImportRef { from_module, from_binding }`. v1 sets all bindings to
  `Local`. ESM only; no CommonJS variants.
- `Inst::LoadImport { dst, src }` — read through an ESM import ref.
- `Inst::AllocNamespace { dst, module, site }` — `import * as ns`.
- `ModuleInfo` / `ExportEntry` / `ImportEntry` records on `Program`.
  v1: one ModuleInfo, empty imports, exports derived from `is_exported`.
- These are PURE additions reserved for v2; v1 emits none of them, and
  the analyzer/codegen arms can be `unreachable!()` until v2.

**Verifier invariants to update:**
- "GlobalId references are valid into Program.globals" stays unchanged
  (still true; just no producers in v1).
- Add: "FieldId in HasField must be a valid FieldId in the FieldTable".
- Add: "Each ClassDef's static_init, if present, is a valid FunctionId."
- Add (v2): "No store opcode (StoreField/StoreElem/...) has a src or
  dst whose binding is `ImportRef`" — importer-side writes are rejected
  by the exporter, so they must never appear in IR.

### 2. `call_graph.rs` — P2 build call graph

**Touched ops:** `Call`, `CallSpread`, `AllocClosure`, plus control-flow
recursion through `Loop`, `If`, `TryCatch`.

**Impact:**
- (A): Doesn't touch LoadGlobal/StoreGlobal at all. No change.
- (B): Module bindings as cells. Cells are created by `AllocObject` and
  consumed by `LoadField/StoreField`. `AllocClosure` already wires up
  captures. **No code change**, but the call graph will see more
  `AllocClosure` edges due to module-scoped capturing functions —
  expected and correct.
- (C): Module-scoped capturing `function f` becomes a closure value. Its
  call sites become `Call { callee: Value(local) }` instead of
  `Call { callee: Direct { func } }`. The call graph code already
  handles both, and the value-call edge widens to "any reachable
  closure target". **Minor impact**: the conservative widening of
  edges may reduce devirt opportunities (mitigated by Direct-call
  escape hatch for non-capturing functions). **No code change here**,
  but a downstream effect on devirt — see §4.
- (F): Static-init functions are new `Function`s in `Program.functions`.
  They get fnIds like any other function. Call graph builds them as
  nodes. **No code change**.
- (G): `HasField` is a non-call leaf op; call graph doesn't care.

**Verdict: no source changes to call_graph.rs**. Behavior changes are
indirect (more closure edges, more functions to walk).

### 3. `interproc.rs` — P3 summary-based escape analysis

The summary system tracks which allocations escape (via parameters,
return, globals, capture).

**Touched ops (existing):**
- `AllocObject`, `AllocArray`, `AllocClosure`
- `Copy`, `LoadField`, `StoreField`, `LoadElem`, `StoreElem`,
  `LoadIndex`, `StoreIndex`
- `Call`, `CallSpread`, `CallBuiltin`, `CallBuiltinStatic`
- `StoreGlobal` (line 263, 419): currently treated as "forces
  materialization on src" — kept. (Conservative and correct: any
  v1 program has no producers, but the handling stays sound if a
  future producer appears.)
- `LoadGlobal` (line 420): currently produces an `External` edge —
  kept. (Same reasoning.)
- `Return`, `Throw`, `Yield`, `Await`
- `HasFieldDynamic`, `LoadFieldDynamic`, `StoreFieldDynamic`
- `ObjectRest`, `ObjectCopyProps`, `ConstructResult`,
  `StoreProtoMethod`, `SetProto`, `GetProto`, `LoadClassProto`,
  `NewMap`, `NewSet`

**Impact per change:**

- **(A) Keep StoreGlobal/LoadGlobal handling**: no change to
  interproc. The existing arms stay as-is and remain sound for any
  future producer.

- **(B) Module bindings as cells**: cells go through the existing
  closure mechanism. Each module variable becomes an `AllocObject`
  in `__module_init`'s prologue, captured via `AllocClosure` by any
  nested function that uses it, and read/written via `LoadField`/
  `StoreField` on the captured local. The summary system already
  handles all of these. **Indirect impact, no code change.**

  Note: today, the exporter's broken `LoadGlobal` path produces
  `External` edges for module-variable reads. With Step C in place,
  those reads instead become `LoadField` on a known cell allocated
  in `__module_init`, which the summary system tracks **precisely**.
  This is **strictly better** — we lose the over-conservative
  `External` edges for module-binding reads. Expected effect: more
  SROA opportunities, more devirt, potentially better perf for code
  that uses module-level state. (Confirm with bench-perf during
  Step C.)

- **(C) Module-scoped capturing function as closure-value**: the
  function's call sites become value-calls. The summary application
  for `Call { callee: Value }` is already implemented — interproc
  applies summaries to *every reachable callee* (via the call graph's
  closure-target set). **No code change**, but per (2) above, less
  precise call edges.

  **Crucial subtlety**: today, `function main()` at module scope is
  defined OUTSIDE any function — its `params` list does NOT include
  the cells for module bindings. In the new design, the cells are
  captures, and the captures appear as the leading parameters of
  the lifted function (the same convention every other closure uses).
  The free-var pre-pass produces `freeVars` containing the module
  cells; `lowerFunctionLike` prepends them to `ctx.params`; the
  `AllocClosure` site in `__module_init` lists them. **This already
  works** for nested arrows/functions (the existing benchmark
  `compose(f, g)` uses exactly this path). Module-scoped functions
  just become an additional case of the same pattern. **The
  invariant `len(params) >= len(freeVars)` already holds.**

- **(D) Hoisting**: hoisting is purely an exporter concern. It produces
  IR ordering that puts function decls and var slots at the prologue,
  but the IR shape is unchanged. **No analyzer impact.**

- **(E) Class scope correctness**: bare-`a`-inside-method resolves to
  outer scope. This changes which **locals** the IR uses (now possibly
  capturing an outer var instead of `LoadField this.a`), but the
  set of IR opcodes used is unchanged. **No analyzer impact.**

- **(F) Static members**: `__static_init_<classId>` is just a regular
  function from the analyzer's perspective. It has a `this`
  parameter (the class), reads/writes fields via `LoadField`/
  `StoreField` on it, and may have captures. **No code change to
  interproc.rs** — it analyses static-init like any other function.

- **(G) Private names + HasField**: `HasField { dst, obj, field }` is
  a NEW Inst variant. interproc must handle it. It's a pure read:
  takes an object, returns a bool. **Constraint behavior**:
  - `obj` must be materialized (the analysis needs to know there's
    a real heap object to query). Add `Inst::HasField { obj, .. } =>
    vec![*obj]` to `op_forces_materialization` (it already handles
    `HasFieldDynamic` the same way — line 245).
  - `dst` is a primitive bool, no escape edge needed.
  Real code change: **add one match arm**, ~2 lines.

- **(H) main auto-call removed**: emit_c entry policy change only. The
  analyzer doesn't care. **No impact.**

**Summary for interproc.rs:** remove 2 arms, add 1 arm, indirect semantic
gains from more precise modeling. **~10 lines of real change.**
Behavior must be validated against the existing unit tests
(`escape_analysis_p1_tests`, `interproc_p3_tests`, `interproc_closure_tests`).

### 4. `devirt.rs` — devirtualization

**Touched ops:** `Call` (line 168), control flow recursion.

**Impact:**

- (A), (B), (D), (E), (F), (G), (H): no direct touch.
- **(C) Module-scoped capturing function as closure-value**: this is
  the one that bites. Today, `function main()` is lowered with a
  `Direct` callee (no captures); devirt freely sees the target and
  inlines. After (C), if `main` captures any module binding, calls
  become `Value` callees (load from cell, then call). Devirt has to
  prove the value flows from exactly one `AllocClosure` to recover
  the Direct-call equivalent.

  Today devirt's `Call` handling looks for already-Direct callees
  and propagates types. It does NOT do "value → AllocClosure
  inversion" (that would be a closure-call devirtualization, which
  we don't currently do).

  **Implication**: capturing module-functions lose Direct-call
  inlining UNTIL we add closure-call devirtualization. For non-
  capturing module-functions (the "escape hatch" in §7.1 of the
  scope design), Direct calls survive. **Recommendation**: confirm
  via bench-perf that current benchmarks (all non-capturing kernels)
  are unaffected, and document the limitation for capturing module-
  functions. **No source change** to devirt.rs unless we want to add
  closure-call devirtualization (deferred work).

### 5. `sroa.rs` — scalar replacement of aggregates

**Touched ops:** `AllocObject`, `Copy`, `Call`, `StoreField`,
`StoreGlobal`, `StoreElem`, `Return`, `Throw`, `LoadField`,
control flow, `AllocClosure`.

**Impact:**

- **(A) Keep StoreGlobal disqualification**: the existing arm at
  line 187 stays. Currently has no v1 producers, but remains sound
  for any future producer (a value stored to a global must be
  materialized, so disqualifying it from SROA is correct).
- (B), (C), (D), (E), (H): no direct touch (the IR shapes SROA cares
  about — Allocs, Loads, Stores — don't change).
- **(F) Static fields**: instance fields use `StoreField` /
  `LoadField` and are SROA-eligible when the class is stable. Static
  fields go through the same opcodes but on the class object (not an
  instance). Today the SROA pass disqualifies any `dst` that's stored
  to a field (line 186) — this works for instance fields when the
  class is unstable. For static fields, the class object itself is
  the receiver; the class object isn't allocated at a particular
  site that SROA can track, so static fields are NOT SROA-eligible
  by the existing rules. **No code change needed; static-field
  storage is naturally non-SROA.**
- **(G) HasField**: it's a read-only test. The `obj` of a HasField
  must NOT be SROA'd away (we need a real object to query). Add a
  disqualification arm: `Inst::HasField { obj, .. } =>
  { disq.insert(obj.0); }` — **one-line change.**

  Wait — disqualifying the obj might be too aggressive. If the
  HasField is being used to test for a specific class brand
  (`#x in candidate`), and `candidate` is a known SROA-eligible
  instance, we'd lose the SROA opportunity for the candidate.

  But: SROA replaces a field-typed local with its scalar parts. If
  HasField needs to query the *existence* of a field, and the local
  is SROA'd to (say) two doubles, there's no object to query — the
  HasField is meaningless after SROA. So yes, disqualify the obj.
  This matches today's behavior for `obj` in `LoadFieldDynamic` /
  `HasFieldDynamic` (a similar dynamic-shape op). **One-line
  change.**

**Summary for sroa.rs:** ~2 lines of real change. Unit tests should
still pass.

### 6. `codegen.rs` — codegen helpers

**Touched ops:** none directly (no Inst:: dispatch).

**Impact:** none. This module is just helpers used by emit_c.

### 7. `emit_c.rs` — the C emitter (the big one)

This is where the most code lives, but most of it just rolls with the
IR change. Specific edits:

- **(A) Keep StoreGlobal/LoadGlobal codegen** (lines 2149/2152, added
  earlier as ad-hoc work for the broken `__module_init` attempt):
  retain. The codegen is correct as written — it implements the
  GlobalEnvironment record over a `GLOBALS[]` static array. In v1
  the array is empty (no producers), but the wiring stays correct
  for future producers.
- **(A) Keep GLOBALS[] static and ts_setup_globals()**: retain. When
  `program.globals.is_empty()` the static array is zero-length and
  the setup function is a no-op — same as today after the rollback.
- **(H) Entry policy revert + cleanup**: emit_c reverts to the
  pre-session-5 behavior (find a function named "main", else first
  function, call it). **~10 lines, simplification.**
- **(F) Static-init dispatch**: after `ts_register_classes()`, emit a
  sequence of calls to each class's static_init function:
  ```c
  __static_init_0(CLASS_PROTO[0]);
  __static_init_2(CLASS_PROTO[2]);
  ...
  ```
  Reads `program.classes[i].static_init: Option<FunctionId>` to find
  each. **~10 lines.**
- **(F) Static field declarations**: classes with static fields need
  the runtime to know about them so the prop map / accessor path
  works. The existing `ts_register_class(CLASS_PROTO[i], fields, n)`
  registers instance fields' typed layout. Static fields use the
  class object's own prop map (already a `ts_object`), so they need
  no separate registration — they're just `ts_set(CLASS_PROTO[i],
  fieldKey, value)` calls inside `__static_init_<i>`. **No
  code change** for the registration path; just the static_init
  body uses StoreField/LoadField on the class proto local.
- **(G) HasField codegen**: emit `v{dst} = ts_make_bool(ts_has_field(
  {obj}, FieldId));`. **~5 lines.**
- **(G) ts_has_field runtime primitive**: add to `runtime/ts_rt.c` +
  `runtime/ts_rt.h`. The prop map already supports lookup by FieldId;
  this is just a wrapper that returns 0/1 instead of the value.
  **~10 lines runtime.**
- **(G) Private-method registration on class proto**: same path as
  public methods, but the method key uses the private FieldId rather
  than `METHOD_KEY_BASE + name_id`. **No structural code change**;
  the existing `ts_set(CLASS_PROTO[c], method_key, ts_make_fn(...))`
  works.

**Summary for emit_c.rs:** ~35 lines of new code, ~30 lines of deletion
(my earlier ad-hoc additions go away). Net change minor.

### 8. Runtime `runtime/ts_rt.{c,h}`

**Impact:**
- `ts_has_field(tsv obj, uint32_t field) -> int`: new primitive.
  Looks up the field in obj's prop map (or typed field bitmap when
  obj is a typed instance). ~15 lines.
- No other changes. The "per-class static container" we discussed for
  statics is just the class object's own prop map (`CLASS_PROTO[c]`'s
  inherited ts_object props field). No new container needed.

**Conclusion**: runtime change is small and additive.

## Aggregate impact

| Module          | Lines changed | Net direction              |
| --------------- | ------------- | -------------------------- |
| `escape_ir.rs`  | ~30           | Pure additions: HasField, Static MethodKind, static fields/init on ClassDef. Global infrastructure kept. |
| `call_graph.rs` | 0             | No change.                 |
| `interproc.rs`  | ~2            | Add 1 arm for HasField. Global handling unchanged. |
| `devirt.rs`     | 0             | No change. Potential perf regression for module-scoped capturing functions; mitigated by escape hatch. |
| `sroa.rs`       | ~1            | Add 1 (HasField needs obj materialized). Global handling unchanged. |
| `codegen.rs`    | 0             | No change.                 |
| `emit_c.rs`     | ~50           | Pure additions for static_init dispatch + HasField codegen. Global codegen kept (already correct). |
| `ts_rt.c/h`     | ~15           | Add ts_has_field.          |
| **Total analyzer/runtime** | **~100** | (vs. exporter changes which are larger) |

## What this changes about the implementation plan

The `scope_resolution.md` § 12 plan said "the runtime does not change at
all" and "the analyzer's optimizations do not change at all". **Both are
slightly wrong, but the actual delta is small:**

- Runtime: **one new primitive** (`ts_has_field`), needed by Step G
  (private names + brand check). Tiny addition.
- Analyzer: **~3 lines** total across `interproc.rs` and `sroa.rs`,
  for adding `HasField` handling. The existing `StoreGlobal`/
  `LoadGlobal` arms STAY (they're sound infrastructure; v1 just has no
  producers). **The optimizations themselves are unchanged.**
- IR: additions only — no removals. `Inst::HasField`, `MethodKind::Static`,
  static fields/init on `ClassDef`. The Global infrastructure stays
  for future producers.

### Devirt regression risk for module-scoped capturing functions

The one place where the redesign loses precision is **devirtualization
of calls to module-scoped functions that capture module variables**.
Today, `function main()` at module scope is always a Direct call;
devirt and the inliner see through it. After the redesign, if `main`
captures any module binding, calls become Value calls, and devirt
loses the static target unless we add closure-call devirtualization.

**Mitigation 1 — the Direct-call escape hatch** (§7.1 of the scope
design): functions with empty capture sets stay Direct. Existing
benchmarks (`int_kernel`, `obj_kernel`, etc.) are all non-capturing
and unaffected.

**Mitigation 2 — closure-call devirt** (deferred): a future analyzer
pass can prove "this Value call always loads from a cell that
exclusively holds the result of one specific AllocClosure", recovering
Direct-call inlining for the single-target case. This is a standard
optimization but not present today.

For v1 we ship with Mitigation 1 only, document the limitation, and
add closure-call devirt if benchmarks show a real regression.

## What to verify during implementation

These are the empirical checks each step must pass:

- **Step 0 (main auto-call removed)**: after migration, all existing
  conformance + golden + bench-perf + unit tests pass with no
  behavior change.
- **Step A (isBuiltinSymbol)**: no test regressions; add a shadow
  test (`const Math = ...`) that previously gave wrong output and
  verify it now gives the V8-matching answer.
- **Step B (stop emitting Global ops for module bindings)**: all
  existing tests pass. The exporter no longer produces `LoadGlobal`/
  `StoreGlobal` (after this step, until Step C adds the cell-based
  path); the IR opcodes and codegen for them remain in place,
  exercised only when a future producer is added.
- **Step C (module-init)**: existing tests pass; new toplevel-*
  tests pass; perf-kernels stay within budget (verifies the escape
  hatch works).
- **Step D (hoisting)**: existing tests pass; new hoisting tests
  pass.
- **Step E (class scope correctness)**: existing tests pass (no test
  depends on the silent `a → this.a` rewrite); new test for
  `class A { a = 1; foo() { return a; } }` correctly loud-rejects
  when no outer `a` exists.
- **Step F (statics)**: existing tests pass; new static-field /
  static-block tests pass.
- **Step G (private names)**: existing tests pass; new private-name
  tests including brand-check pass.

At every step, run the FULL CI suite (unit + ci_fast + golden +
bench-perf + correct + basic + exhaustive), not just a subset. Any
regression is a stop-the-line.
