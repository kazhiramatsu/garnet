# P6 — codegen integration & runtime soundness

## Why codegen reads the analysis, not the other way round
The Escape IR is a *flow-insensitive analysis* artifact: it drops control flow
and concrete values, so it cannot regenerate the program. Codegen therefore
consumes the analysis: the backend, which holds the real AST/CFG, looks up each
allocation site's verdict and picks an allocation strategy.

## Decision predicate
```
strategy(site) =
  NoEscape     → (layoutDeterminable ∧ multiplicity = Once) ? Stack    // slot / scalar-replace
                                                            : FrameArena // per-call region, freed on return
  ArgEscape    → CallerArena   // caller-provided storage, else Heap
  GlobalEscape → Heap
```
- **NoEscape alone licenses a frame-local arena** (sound: no reference survives
  the frame). It does *not* by itself license a single stack slot.
- **Multiplicity is required** because NoEscape means "does not leave the frame",
  not "does not leave the loop iteration". Reusing one slot across coexisting
  loop instances would corrupt memory, so `Many` (loop / per-iteration) sites
  stay in the arena.
- **Layout-determinability** gates scalar replacement / fixed-size slots; open
  (`any`, index signatures) or growable (arrays) shapes fall back to the arena.

`multiplicity`, `layoutDeterminable`, and `kind` are carried per-site in the IR
(`Program.siteMeta`, additive — the analyzer ignores it) and are filled by the
exporter from the AST (loop nesting, type shape).

## Runtime soundness harness
The harness executes cell-lowered programs (cells and closures are explicit
objects, mirroring the lowering) and checks the **NoEscape invariant**: an object
allocated at a NoEscape site must be unreachable from any escape root — the value
returned out of its frame, and the global sink — at frame exit and at program
end. A reachable NoEscape object proves unsoundness (a miscompile if stack-
allocated). A negative control deliberately mislabels an escaping site as
NoEscape to confirm the check has teeth.

Notably, for a closure whose body leaks a *captured variable's value* to a
global, the harness confirms at runtime that the cell box and the closure object
stay local while only the value escapes — matching the static verdict exactly.

## Known refinements
- `layoutDeterminable` is a shallow heuristic (object literal type, no index
  signature); the literal's own type can hide an annotated index signature.
- `ArgEscape → CallerArena` currently defaults to heap; proper caller-side
  storage placement needs the containment direction from the callee summary.
