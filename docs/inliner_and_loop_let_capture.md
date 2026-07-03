# Two related correctness gaps: inliner local-leak + `let` per-iteration capture

This document designs fixes for the last three exhaustive-conformance failures:
`classes__basic`, `classes__methods` (one bug), and `closures__capture` (the
other). Both are about *binding identity*: each requires distinguishing the
"static" binding in source from the "runtime" storage that actually carries
the value.

The two bugs are independent in code but conceptually parallel: in each case
we currently treat a single binding slot as shared when JS semantics demand a
fresh slot per dynamic context.

## Bug 1: inliner forgets to remap operands of the "generic" fallthrough

### Observation

`exhaustive__classes__basic` is

```ts
class Point {
  x: number; y: number;
  constructor(x: number, y: number) { this.x = x; this.y = y; }
  dist(): number { return Math.sqrt(this.x * this.x + this.y * this.y); }
  toString(): string { return `(${this.x},${this.y})`; }
}
function main(): void {
  const p = new Point(3, 4);
  console.log(p.dist(), p.toString(), p.x + p.y);  // V8: "5 (3,4) 7"
}
```

AOT prints `0 (3,4) 7`: `p.dist()` returns 0, not 5. The IR of `dist` is fine:

```
LoadField dst=1 obj=0 field=2          ; this.x
LoadField dst=2 obj=0 field=2
BinOp     dst=3 op=*   lhs=1 rhs=2    ; x*x
LoadField dst=4 obj=0 field=3          ; this.y
LoadField dst=5 obj=0 field=3
BinOp     dst=6 op=*   lhs=4 rhs=5    ; y*y
BinOp     dst=7 op=+   lhs=3 rhs=6    ; x*x + y*y
CallBuiltinStatic dst=8 builtin=math.sqrt args=[7]
Return    src=8
```

When SROA inlines `dist` into `main`, locals 1..7 are freshly renamed (e.g.
local 7 → main's local 18), but the emitted C reads

```
d18 = (d14 + d17);     // the sum lives in d18 (renamed local 7)
d8  = sqrt(d7);        // but sqrt reads d7  -- UNREMAPPED
```

so sqrt's argument is an uninitialized local 7 in main's frame. Result: 0.

### Root cause

In `analyzer/src/sroa.rs::inline_callee`, the inliner pattern-matches each
callee instruction:

```rust
match inst {
    Inst::LoadField { ... } => /* remap and push */,
    Inst::StoreField { ... } => /* remap and push */,
    Inst::Call { ... } => /* remap and push */,
    Inst::Return { ... } => /* lower to Copy */,
    Inst::Const { ... } => /* remap dst */,
    Inst::BinOp { ... } => /* remap dst+lhs+rhs */,
    Inst::UnOp { ... } => /* remap dst+operand */,
    Inst::Copy { ... } => /* remap dst+src */,
    Inst::LoadField (generic) / StoreField (generic) => /* remap */,
    other => out.push(other.clone()),   // <-- BUG: emits with callee's local IDs
}
```

`CallBuiltinStatic` and several other variants fall into `other`. They are
cloned verbatim. The destination and arg locals refer to the *callee's* local
namespace, which the surrounding `main` does not contain. We get an aliasing
or uninitialized-read silently, depending on which numeric local in main
happens to clash with the callee's IDs.

### Which variants need remapping?

Any `Inst` variant that names a `LocalId` operand. Surveying `escape_ir.rs`,
the variants reachable inside inlined method bodies (no async, no generator,
no try-catch needed for our `dist`/`toString` cases) include:

| variant                     | currently handled | needs remap |
|-----------------------------|-------------------|-------------|
| Const                       | yes               | already ok  |
| Copy                        | yes               | already ok  |
| BinOp, UnOp                 | yes               | already ok  |
| LoadField, StoreField       | yes (incl. `this` SROA) | already ok |
| Return                      | yes (lowered to Copy)   | already ok |
| Call (Direct on this)       | yes (recursive inline)  | already ok |
| **CallBuiltin**             | **NO**            | dst, recv, args |
| **CallBuiltinStatic**       | **NO**            | dst, args   |
| **Call (non-this)**         | **NO**            | dst, recv, args |
| **CallSpread**              | **NO**            | dst, recv, argSpecs.local |
| **AllocClosure**            | **NO**            | dst, captures.cell |
| **AllocObject, AllocArray** | **NO**            | dst         |
| **LoadIndex, StoreIndex**   | **NO**            | dst, arr, index, src |
| **LoadGlobal**              | **NO**            | dst         |
| **GenericLen**              | **NO**            | dst, src    |
| **HasField**                | **NO**            | dst, obj    |
| **StoreFieldDynamic**       | **NO**            | obj, key, src |
| **ArrayLen, ArrayPush, ArrayPop** | **NO**      | dst, arr, src |
| **NewMap, NewSet**          | **NO**            | dst         |
| **Print**                   | **NO**            | src         |
| **If, Loop, TryCatch**      | **NO** (nested bodies need recursion) | cond/dst + recursive remap of bodies |
| **Break, Continue**         | n/a (no operands) | already ok  |
| **ConstructResult**         | **NO**            | dst, inst, ret |

Two notes:

- **Control-flow variants** (`If`, `Loop`, `TryCatch`) contain nested `Vec<Inst>`
  bodies. We must recursively walk and remap those.
- **`Inst::Call` non-`this`** is currently `other`. That includes normal method
  calls inside an inlined method like `this.helper().push(x)`: the inner
  push's `recv` is a fresh local, not `this`. We must remap it.

### Design

Replace the `other => out.push(other.clone())` arm with an exhaustive remap
function. Concretely, add a helper `remap_inst(inst, &m, &mut subst, next,
new_locals, bodies, depth, out)` that handles every variant. For the variants
already specially-cased (LoadField on `this`, Call on `this`, Return),
`inline_callee` continues to handle them inline and the helper is called only
for the rest. Or: keep the special cases but route everything else through a
single exhaustive `remap_and_push` call.

I will go with the second approach (smaller diff, clearer separation). The
helper accepts an `Inst` and a remap function `m`, plus mutable `subst` /
`next` / `new_locals` for nested-body fresh locals (a nested If/Loop body
might introduce locals that also need fresh renames — but in practice, all
locals in the callee body are already in `callee.locals` and have been
pre-renamed in `subst` at the top of `inline_callee`, so we don't need to
allocate new locals during the walk; we only need to remap operands).

Wait — that's only true if `subst` covers *every* local id referenced anywhere
in the callee, including those nested inside If/Loop bodies. Let me check.
`callee.locals` is a flat list of all locals in the function (the IR
representation lifts locals to the function level, not the block level), so
yes: a single pre-pass `subst` from `callee.locals` covers everything.

So the helper is purely structural: it walks an `Inst`, remaps every `LocalId`
field through `m`, and pushes the remapped clone. For variants with nested
`Vec<Inst>` bodies, it recurses into those bodies through the same helper.

### Plan

1. Add `fn remap_inst(inst, m, out)` (or inline as a closure) doing exhaustive
   remap including recursion into If/Loop/TryCatch bodies.
2. In `inline_callee`, replace `other => out.push(other.clone())` with a call
   to that helper.
3. Keep the four `this`-special cases at the top untouched.
4. Verify `classes__basic` and `classes__methods` pass and no regressions in
   correctness or perf benchmarks.

### Risk assessment

Medium-low. The change is localized to the inliner fallthrough — every
correctness benchmark that exercises this code path goes through `Call`
variants we already handle (devirt'd super-call inlining). What changes is
that previously-`other` IR shapes now get correctly remapped instead of
silently broken. Worst case: a variant that *was* working by accident (e.g.
its `dst` happened to alias something innocuous) starts behaving differently
— but "previously working" here means "previously lucky". We have
`syntax_*`, `class*`, `inherit*` benchmarks across both correctness shards
that will catch regressions.

The perf-kernel benchmarks (`obj_kernel`, `typed_field_kernel`,
`inherit_sroa_kernel`) are the most heavily inlined; they will catch any
regression in the existing-correct paths.

---

## Bug 2: `for (let i = ...; ...; ...) { ... captures i ... }` — per-iteration semantics

### Observation

`exhaustive__closures__capture` is

```ts
const fns: Array<() => number> = [];
for (let i = 0; i < 3; i++) { fns.push(() => i); }
console.log(fns[0](), fns[1](), fns[2]());   // V8: "0 1 2"
```

AOT prints `3 3 3`. All three closures see the final value of `i`.

### Root cause

In our current closure conversion, the binding `i` is rewritten to a cell
(an AllocObject whose `value` field stores `i`'s value). All reads and writes
of `i` become LoadField/StoreField on that cell. The capturing closure
captures *the cell itself*.

Today the cell is allocated **once outside the loop** (during the function's
prologue), so all three iterations write to and read from the same cell. By
the time the closures are invoked after the loop, the cell holds 3.

JS `let` in a `for (let i ...)` head has special semantics:

- Before each iteration begins, a NEW binding `i` is created.
- Its initial value is the value `i` had at the end of the previous iteration
  (or the initializer for the first one). Specifically the spec
  ("CreatePerIterationEnvironment" §14.7.4.4) makes a fresh lexical environment
  for the loop body, copies the previous `i` into it, then runs the body.

So each iteration's body sees its own `i`. A closure capturing `i` captures
*that iteration's* `i`. After three iterations there are three separate cells.

### Design (revised after spec study)

Per ECMA-262 §14.7.4.2 ForBodyEvaluation, the order is:
1. Run body (with iteration N's binding)
2. CreatePerIterationEnvironment — copy values from iter-N's env to iter-N+1's env
3. Run update — mutates iter-N+1's env (NOT iter-N's)
4. Test, loop

So closures captured during iter-N reference iter-N's binding, which holds the
value `i` had during body N — *before* the post-body update. The update runs
on the *next* iteration's binding.

I have to allocate a fresh cell per iteration when the loop is `for(let
i=...)` AND `i` is captured by a nested closure. Other forms (`for(var ...)`,
`for(let i=...)` where `i` is not captured) can keep the single-cell layout
(it's more efficient and correctness-equivalent).

The structure is:

```
init_cell = freshCell(site_init)
init_cell.value = E_init
cell_i = init_cell                  // iter-0's cell
first = true
Loop {
  cond_body: {
    if (!first) {
      prev_val = cell_i.value         // value of iter-N's cell (post-body, pre-update)
      cell_i = freshCell(site_per)    // iter-N+1's cell
      cell_i.value = prev_val
      run_update_via_cell_i           // mutates iter-N+1's cell ONLY
    }
    first = false
    cond_local = <cond using cell_i>
  }
  body: { BODY (refers to cell_i) }
}
```

Closures captured during iter-N see `cell_i` = iter-N's cell. The update mutates
the freshly-allocated iter-N+1 cell, so iter-N's cell retains its body-time
value. A `continue` jumps to cond_body — `first` is false after iter 0, so the
update + new-cell flow runs, preserving the body-time mutation in iter-N's cell.

Implementation steps:

1. Detect the case in `lowerStmt` for `isForStatement`:
   - initializer is a `VariableDeclarationList`
   - flag bit `ts.NodeFlags.Let` set
   - single identifier declarator (multi-binding/destructuring deferred)
   - the symbol is in `this.cellBindings`

2. When detected, override the normal initializer + cell flow:
   - **Don't** call `lowerStmt(VarStmt(initializer))` (which would store
     E_init into the prologue cell). Instead, allocate `init_cell` here and
     populate it.
   - The prologue allocation for `i` still happens (it's unconditional based on
     `cellBindings`). The local for the prologue cell becomes dead code — gcc
     removes it. We don't reuse it: we want a FRESH local for `cell_i` so we
     can reassign it each iteration without disturbing the prologue layout.

3. During cond_body and body lowering, temporarily set
   `ctx.cellAccess.set(i_sym, cell_i_local)`. Restore the original value
   (typically the prologue cell) afterwards. All reads/writes of `i` (and
   the update) go through cell_i.

4. The `bodyHasContinue`/`first`/loop kind `forc` machinery from the existing
   for-statement lowering is COMPATIBLE — re-use the same `first` flag for
   the per-iteration logic, since both gate on "not first iteration".

### Alternative considered

I considered keeping the cell at function scope and adding a per-iteration
"copy" of the cell value into a fresh cell only at the AllocClosure site.
That would work for our test case but is **wrong in general**: if the body
mutates `i` after the closure captures it, the captured cell must observe
those mutations (within the same iteration). Per-spec the closure shares the
iteration's binding. The "fresh cell per iteration" design satisfies this.

### Plan

1. In `lowerStmt` for `isForStatement`, detect when the initializer is
   `let` AND declares a binding that's in `cellBindings`. (Only the simple,
   common case — a single identifier-bound declarator. Destructuring `for
   (let [a,b] of ...)` is out of scope for now and will fall through to the
   pre-existing shared-cell behavior with a TODO note.)
2. When that condition holds, generate the per-iteration cell allocation
   structure above. Otherwise, keep the existing transformation (incrementor
   in cond_body, single cell at function scope).
3. Add a conformance test for the `let`-not-captured case to ensure the
   common path stays fast (no per-iteration alloc when unnecessary).

### Risk assessment

Medium. The shape of the lowered code is changing for a specific subset of
for-loops. Risk vectors:

- Performance regression in tight loops: only triggered when `i` is captured,
  which is rare in hot loops. Perf kernels do not capture loop indices, so
  budgets should hold.
- Incorrect cell allocation site: must allocate inside `cond_body` (so the
  fresh cell is associated with each iteration and not the parent function),
  AND the AllocClosure inside the body must use the cell *just allocated*
  in this iteration's cond_body, not a stale one.
- The current "first iteration" flag for `continue` semantics needs to play
  nicely. Concretely, the update must still be skipped on the first iteration.

For safety, I will:

1. Apply the change ONLY when at least one declared binding is a cell
   binding. Loops with non-captured `let` keep the single-cell fast path.
2. Add specific conformance tests covering:
   - captured `let i` with `++`
   - captured `let i` with explicit reassignment in body
   - captured `let i` with `continue`
   - non-captured `let i` (performance regression net)

---

## Order of work

1. Bug 1 (inliner remap). Smaller, more obvious, lower risk. Implement and
   verify FIRST.
2. Bug 2 (per-iteration `let`). Larger surgery on a path used by many
   benchmarks. Implement AFTER bug 1 is committed (gives a known-good
   baseline to bisect against if regressions appear).
3. Run FULL CI (unit / ci_fast / golden / perf / correct1 / correct2 /
   conformance basic + exhaustive) after each bug fix.

## What success looks like

- `exhaustive 31/34 → 34/34`.
- All other shards remain green.
- Perf-kernel budgets unchanged (no slowdown introduced).
- No new entries in KNOWN_GAPS.md from this work.

---

## Implementation record

### Bug 1 fix landed (analyzer/src/sroa.rs)

Replaced the `other => out.push(other.clone())` catch-all in `inline_callee`
with a call to `remap_inst_operands(other, &m)`. The helper is an exhaustive
match over every `Inst` variant (Rust verifies exhaustiveness at compile
time), remapping every `LocalId` operand through `m` and recursing into
nested `Vec<Inst>` bodies (`If`, `Loop`, `TryCatch`). Subst pre-populated
from `callee.locals` covers every local id reachable in any nested body,
since the IR lifts all locals to the function level.

`classes__basic` immediately matched V8 after this fix.

### Side bugs discovered while debugging classes__methods

1. **SROA scalarized non-numeric fields as `Primitive` doubles** (sroa.rs
   `process_function`): `fresh(next, new_locals, false)` was called
   unconditionally for every field, making every field scalar a double. For
   `items: number[]`, the array pointer was passed through `ts_to_num`,
   corrupting it. Fix: select `Reference` vs `Primitive` based on
   `numeric_fields.contains(&(cls, f))`.

2. **`.push(x)` early-path didn't check receiver kind**
   (exporter.ts, near line 670): any `.push(x)` with one arg was lowered to
   `ArrayPush`, including method calls on user classes (e.g.
   `class Stack { push(x) { this.items.push(x); } }`). Fix: guard with
   `builtinReceiverKind(fnx.expression) === "array"`.

3. **`numeric_fields` didn't propagate through inheritance** (sroa.rs,
   discovered as a perf regression in `inherit_sroa_kernel` — 192ms vs
   130ms budget). The set was built per-class without walking ancestors,
   so SROA targets of class `IntBox` (parent `Base$number`) missed the
   numeric tag on the inherited `value` field. Fix: after building the
   initial set, propagate every `(parent, fid)` entry down to every
   descendant class. Restored kernel to 91ms.

### Bug 2 fix landed (exporter.ts in `lowerStmt` for `isForStatement`)

Detect captured-let loops at lowering time: the initializer is a
`VariableDeclarationList` with `NodeFlags.Let`, single identifier
declarator, symbol in `this.cellBindings`. When detected, take a
per-iteration cell allocation path; otherwise keep the existing
single-cell fast path.

Structure (matching the refined design above):

```
init_cell = AllocObject(site_init=once);    // dst = cellLocal
cellLocal.value = E_init;
first = true;
Loop {
  cond_body: {
    if (!first) {
      prev = LoadField(cellLocal, VALUE);
      cellLocal = AllocObject(site_per=many);   // iter-N+1's cell
      StoreField(cellLocal, VALUE, prev);
      update;     // mutates iter-N+1's cell (cellAccess routes via cellLocal)
    }
    first = false;
    cond_local = <cond using cellLocal>;
  }
  body: { BODY }   // cellAccess overridden -> reads/writes go through cellLocal
}
```

`cellAccess.set(sym, cellLocal)` is set before lowering cond_body and body,
and restored after. The prologue's original cell for `sym` becomes dead and
is removed by gcc. Loop kind stays `"forc"` so `continue` is a real C
continue jumping to cond_body, which runs the update path correctly
(`first` is already false after iter 0).

### Conformance tests added

- `exhaustive/closures/capture_continue.ts` — captured `let i` with
  `continue`. Each non-`continue`'d iteration captures its own `i`.
- `exhaustive/closures/capture_mutate.ts` — closure references both `i`
  and an array indexed by `i`; both must be iteration-local.
- `exhaustive/closures/capture_no_alloc.ts` — non-captured `let i` (single-
  cell fast path, performance regression net).

### Final state

- exhaustive: 31/34 → **37/37** (with the 3 new tests).
- All other shards green: unit 7, basic 3, golden 48, perf all kernels
  within budget, correct1, correct2, ci_fast.
