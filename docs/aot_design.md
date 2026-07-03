# TS → Rust AOT compiler — architecture

Goal: ahead-of-time compile a TypeScript subset to native code by **emitting Rust
that targets a small Rust runtime crate**, using the escape analysis to choose
cheap allocation representations and letting `rustc` re-verify memory safety.

## 0. Why emit Rust (not LLVM/native directly)
- We get a mature optimizer/codegen, portability, and—crucially—the **borrow
  checker as a free verifier** of our region choices (see §4).
- A *lightweight* runtime is feasible precisely because escape analysis moves the
  majority of allocations off the managed heap, so the residual GC is small.

## 1. Pipeline — two IRs, one site identity
The existing Escape IR is **flow-insensitive and lossy**: great for analysis,
unusable for codegen. AOT therefore uses a *second* control-flow-preserving
codegen IR; the two share allocation-site identity (SiteId ↔ source span, already
emitted in `sites.json`).

```
TS AST ─┬─► Escape IR (flow-insensitive) ─► analyzer ─► per-site strategy
        │                                                   │  keyed by SiteId/span
        └─► Codegen IR (typed CFG / ANF, faithful) ◄────────┘  annotate
                     │
                     ▼
              Rust emitter ─► .rs ─► rustc ─► native binary
                                      └─ borrow checker re-verifies regions
```

## 2. Value model & memory
- **Baseline `Value`** (always correct): a tagged enum
  `Undefined | Null | Bool | Num(f64) | Str(Rc<str>) | Obj(Heap) | Fun(Heap)`.
  Objects that must alias+mutate live behind the managed heap cell.
- **Managed heap `Heap`**: start with `Rc<RefCell<Obj>>`; add a cycle collector
  later (TS makes cycles: parent/child, doubly-linked). Because escape analysis
  keeps few objects here, even a simple mark/sweep or Bacon–Rajan cycle collector
  suffices. `Obj` is either a **struct-backed** monomorphic record (known shape →
  named Rust fields) or a **map-backed** dynamic record (`HashMap<Key,Value>` /
  hidden-class) fallback.
- **Specialized reps** chosen by analysis replace the heap cell where safe (§3).

## 3. Representation tiers = escape strategy (proven in the slice)
| escape | + layout/multiplicity | Rust representation |
|---|---|---|
| NoEscape | determinable ∧ once | **stack struct** / scalar-replaced locals |
| NoEscape | many / not determinable | **frame-local bump arena** (`bumpalo`), `&'fn` |
| ArgEscape | — | **caller-provided region** (region-polymorphic fn), else heap |
| GlobalEscape | — | **managed heap** (`Rc<RefCell>` / `Gc`) |

The vertical slice (`aot_emit.rs` → `aot_demo_gen.rs`) emits exactly this:
`pointSum`'s `{x,y}` (NoEscape) becomes a stack `struct` (`p.x + p.y` ⇒ prints 7),
`makeBox`'s `{val}` (escapes via return) becomes `Rc<MakeBoxB>` (prints 42).
Field access syntax is uniform (`x.f`) because `Rc` derefs.

## 4. Escape lattice ≅ Rust region lattice  →  rustc verifies us
`NoEscape ⊑ ArgEscape ⊑ GlobalEscape` maps to `'fn ⊑ 'caller ⊑ 'static(heap)`.
So codegen emits **borrows** (`&'fn`, `&'caller`) for non-global tiers. If the
analysis is wrong (an object marked NoEscape actually escapes), the emitted `&'fn`
fails to satisfy the lifetimes and **rustc rejects the program** — a miscompile
becomes a compile error. Demonstrated: `aot_demo_bad.rs` (escaping object emitted
as stack + returned borrow) → `error[E0515]: cannot return reference to local`.
This is a second, *static* safety net complementing the runtime harness; codegen
must use borrows (never silently `clone`) so the check keeps its teeth.

## 5. Closures
Our cell lowering already boxes captured variables. Map per strategy:
- cell NoEscape → a stack/arena `Cell { value }` the closure **borrows**;
  closure NoEscape → a Rust closure `move |..|` borrowing those cells.
- cell/closure escaping → `Rc<RefCell<Cell>>` and `Rc<dyn Fn(..)->Value>`.
The "box stays local while its contents escape" result (e.g. `leaksCaptured`)
means: emit the `Cell` on the stack but store its `value` into the heap root.

## 6. Dynamic features — specialize what's known, fall back otherwise
- **Structural / monomorphic types** (interfaces, classes with fixed fields):
  emit Rust structs + static field offsets. Needs the TypeShape table we deferred.
- **`any` / open / polymorphic**: `Value` + map-backed object + dynamic dispatch.
- **`this` / methods**: pass receiver explicitly; methods → free fns / trait impls.
- **Exceptions**: thread `Result<Value, Value>` (typed, cheap) rather than unwinding.
- **Numbers**: `f64` by default; narrow to `i64`/`i32` where a range/int analysis proves it.
- **async / generators**: hardest (event-loop + suspendable frames). Defer past the
  synchronous core; later map to Rust `async`/coroutines with a runtime scheduler.

## 7. Runtime crate `ts_rt`
Provides `Value`, `Heap`/`Gc` + (eventual) cycle collector, the bump `Arena`,
string interning, JS operator semantics (`add`, comparisons, truthiness,
coercions), and builtins (`console`, `Array`, `Object`, `Math`). Emitted programs
`use ts_rt::*;`. Kept small because most allocations are specialized away.

## 8. Roadmap
1. **Synchronous monomorphic core**: functions, primitives, struct-backed objects,
   arrays, control flow, the four allocation tiers. (Slice already proves tiers + verifier.)
2. **Codegen IR** (typed ANF/CFG) + Rust emitter from the real AST; join strategies by SiteId/span.
3. **Closures** (borrowed vs Rc), **arenas** (`bumpalo`) for NoEscape-many/ArgEscape.
4. **Dynamic fallback**: `Value`, map objects, `any` paths; populate the TypeShape table.
5. **Managed heap + cycle collector**; exceptions via `Result`.
6. **async/generators**; int specialization; inline caches for megamorphic sites.

## 9. Risks / open questions
- **Cycles**: pure `Rc` leaks; needs a collector (kept cheap by escape analysis).
- **ArgEscape placement**: region-polymorphic functions vs defaulting to heap — needs
  the callee summary's containment direction to place storage in the caller.
- **Borrow-checker friction**: arbitrary TS aliasing graphs won't borrow-check as
  native references; that's exactly why escaping/shared objects use the heap cell —
  borrows are reserved for the analysis-proven `'fn`/`'caller` tiers.
- **Lowering faithfulness**: the verdicts are only as sound as the AST→IR lowering;
  needs a lowering-soundness spec + property-based differential testing.
