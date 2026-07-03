# Capture & Cell Lowering — Escape IR (P0)

This spec fixes how captured variables are lowered, so that the Rust analyzer
handles closures with the **existing** object/field machinery and the IR
contract does not churn once P1 is built. It is the last open design decision
before P0 freeze.

## Principle

A closure that captures a variable is lowered to ordinary objects and fields:

- A **captured** binding becomes a **cell**: a synthetic single-slot object.
- A **non-captured** binding stays a pure stack local (no cell, no allocation).
  The exporter decides purely from `Binding.capturedBy` being empty or not.
- Reads/writes of a captured binding become `LoadField`/`StoreField` on its cell.
- A closure is an object whose fields point to the cells it captures.

Consequence: the connection graph already models objects, fields and
points-to, so **closures need no separate dataflow pass** — only a ~3-line
instruction handler for `AllocClosure` (add one field edge per capture).

## The cell

For a captured binding `b: T`, the exporter synthesises:

- a type `Cell<T>` = `TypeShape::Object { fields: [ value: T ] }`
  (an ordinary entry in `Program.types`; nothing special to the analyzer),
- a `FieldInfo` for the `value` slot (an ordinary `Program.fields` entry).

The cell is materialised in the binding's **owner function** (the function
whose scope `b` lives in, per `Binding.scope`):

```
AllocObject { dst: cell_b, typeId: Cell<T>, site: S }   // locals[cell_b].binding = b
```

`cell_b.refKind = reference`. Non-captured bindings emit no such alloc.

## Lowering rules

| Source construct (for captured `b`) | Escape IR |
|---|---|
| declaration of `b` | `AllocObject cell_b : Cell<T>` in owner fn |
| read `b` | `LoadField dst, obj=cell_b, field=value` |
| write `b = x` | `StoreField obj=cell_b, field=value, src=x` |
| closure `F` capturing `b` | inside `F`'s body, `b` accesses go through a local `cell_b@F` (binding=b) provided by the environment |
| `AllocClosure` for `F` (in creating fn `G`) | `AllocClosure { dst: clo, func: F, captures: [{ binding: b, cell: cell_b@G }], site }` |

**Environment threading.** The cell is allocated once in the owner function.
Any function `F` that captures `b` receives the cell reference through its
closure environment and surfaces it as a local `cell_b@F` (with `binding = b`).
At an `AllocClosure` site in function `G`, each capture's `cell` field is the
cell local available **in G** (G is either the owner, or itself captured `b`
and thus has a threaded `cell_b@G`). The exporter guarantees this local exists
using the scope tree — so the analyzer never performs a cross-function lookup.

Parameters and `this` are bindings too (`declKind = param`); if captured, the
prologue copies them into a cell the same way.

## How the analyzer treats `AllocClosure`

```
O_clo = fresh object node for `dst` (siteId)
for cap in captures:
    # field edge: the closure holds a reference to the captured cell
    add Field edge  O_clo.[cap.binding] -> pointsTo(cap.cell)
```

Reachability then does the rest:

- `clo` escapes (returned / stored into an escaping object / global / passed to
  `Unknown` callee) ⇒ `O_clo` escapes ⇒ each captured cell escapes ⇒ the
  captured variable's contents escape. Correct.
- `clo` is `NoEscape` ⇒ its cells are `NoEscape` ⇒ codegen may elide the box
  (scalar-replace the cell).

## Multiplicity is a codegen concern, not the analyzer's

Escape is **multiplicity-independent**: whether a cell is allocated once or once
per loop iteration does not change *whether* it escapes. So the flat,
flow-insensitive `body` list is sufficient for P1 — **we do not need loop
structure in the IR**.

`Binding.perIteration` and loop multiplicity feed **codegen**, which decides
stack vs heap from: `EscapeResult[site]` ∧ `TypeInfo.layoutDeterminable` ∧
single-instance-vs-coexisting. Codegen recovers the binding via
`site → dst local → Local.binding → Binding`.

### `var` vs `let` traced

```
for (var i = 0; i < 3; i++) fns.push(() => i);   // i: var, perIteration = false
```
One function-scoped cell `cell_i`, shared by every closure. If `fns` escapes,
the single shared cell escapes (`ArgEscape`/`GlobalEscape`). Matches the
runtime semantics (all closures see the same final `i`).

```
for (let i = 0; i < 3; i++) fns.push(() => i);   // i: let, perIteration = true
```
A fresh cell per iteration. Same **escape verdict** as above when `fns` escapes.
The difference surfaces only in **codegen**: if NoEscape, the `var` case needs 1
stack slot, the `let` case needs N coexisting cells (stack-able only if the loop
trip count is bounded/known, else heap). The analyzer reports the same state
for both; codegen splits them via `perIteration`.

## Optimisation notes (codegen)

- `NoEscape` cell ⇒ box elimination / scalar replacement.
- `const` captured binding ⇒ cell is single-assignment; if `NoEscape`, codegen
  can inline the captured value and drop the cell entirely.

## Verifier invariants

1. `locals[capture.cell].binding == Some(capture.binding)`.
2. Every binding with non-empty `capturedBy` has exactly one cell-allocating
   `AllocObject` in its owner function (per-iteration ones are loop-internal).
3. Reads/writes of a captured binding go through `LoadField`/`StoreField` on its
   cell — never a bare `Copy` of the variable.
4. A binding with empty `capturedBy` has no cell.

## Deferred (additive, no contract impact)

`catch` modelling, async/generator frame objects, and exception-flow refinement
all map onto existing sinks/objects and are added in P4/P5 without changing this
contract.
