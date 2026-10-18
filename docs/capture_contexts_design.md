# Capture contexts — scope records instead of one cell per variable

Slice C5b of `docs/v8_parity_roadmap.md` (track C, item 5). Builds on typed
cells (C5a, `docs/capture_lowering.md`).

## Problem

A captured variable is one heap cell (`__cell`, one slot). A closure's
environment is an array with one handle per captured variable, copied when
the closure is created, and every call of a function with `n` captures copies
`n` handles from the environment into its frame (`F.v<i> = _env[i]`) and
roots them (`ts_frame_push(&F.h, nlocals)`). The compiler is written as
factories: `createTypeChecker` owns 2,251 captured bindings and its nested
functions capture up to 249 of them each, so a call of `checkTypeRelatedTo`
copies 249 handles before doing anything, and the checker creates thousands
of such closures. The free-variable fixpoint also makes intermediate
functions carry every binding their inner closures need.

## Representation

- For every function `F` (including `__module_init`), the **record bindings**
  `R(F)` are the captured bindings `F` owns whose declaration is not inside a
  loop of `F`, excluding the lexical-`this` sentinel and the self binding of a
  named function expression. If `R(F)` is not empty, `F` has a synthetic class
  `__ctx_<fid>` with one boxed field per binding (`c<bindingId>`), the
  **scope record**.
- `F` allocates its record once at entry (site kind `cell`, always heap),
  where the per-variable cells used to be allocated, and stores `undefined`
  into every field (boxed-field initialization from Session 350). Reads and
  writes of a record binding are `LoadField`/`StoreField` on the record.
- Bindings outside `R` keep their cells unchanged: per-iteration `let`/`const`
  (and anything else declared inside a loop), the lexical-`this` cell of
  arrows, the self cell of named function expressions.
- A closure or direct callee `G` captures **slots**, computed from
  `sortedFreeVars(G)` identically at every creation site, call site and in
  `G`'s own prologue: first one `record` slot per distinct owner (ordered by
  the owner record's binding id), then one `cell` slot per cell-resident free
  variable (ordered by binding id). The capture count is the slot count (plus
  the lexical-`this` cell for arrows). A record slot is supplied by the
  creator's own record (owner == creator), by the record parameter it holds
  for that owner (the free-variable fixpoint guarantees a creator holds every
  binding its inner closures need, hence the owner's record), or, for the
  module record, by the global `__modctx` that `__module_init` publishes.
- In the IR a record is an ordinary classed `AllocObject`; the capture record
  keeps `{binding, cell}` with the record's synthetic binding id on both the
  capture and the local (verifier invariant), so interprocedural summaries,
  SROA disqualification of captured locals and the heap rule for captured
  allocations apply unchanged.

## Invariants

1. Every access to a record binding goes through the record of the owning
   activation: the owner's local, or the parameter that received it. There is
   no copy of a record binding's value outside the record.
2. Per-iteration semantics are untouched: bindings declared inside loops stay
   per-iteration cells, so closures created in different iterations keep
   observing their own binding.
3. The slot layout is a pure function of the callee's free variables, so a
   creation site, a direct call and the callee prologue agree without any
   side channel.
4. Records are never scalar-replaced or stack-allocated while a closure may
   hold them (the existing captured-allocation rules).

## Slices

- **C5b-1 (this slice)**: function-scope records, closures and direct calls
  capture records, module record published in `__modctx`. Exporter only;
  `TSAOT_CAPTURE_CONTEXTS=0` keeps the per-variable cells (the parity corpus
  is exported with it).
- **C5b-2**: block records for per-iteration bindings (one record per
  iteration instead of one cell per captured binding).
- **C5b-3**: unboxed numeric record fields where the binding's type is a
  plain `number` and it is definitely assigned.
- **C5b-4** (needs track B): resolve the record handle once per activation
  and keep a raw pointer while no collection can move it.

## Expected effect

A call of a nested checker function copies one handle instead of up to 249,
its frame shrinks accordingly, closure creation copies one handle per owner
instead of one per variable, and a record's fields are adjacent in memory.
A field access costs what a cell access costs today (handle resolve plus one
load). Gates: conformance (including the capture fixtures), parity with the
legacy export, GC stress, bundler, selfconf, bench, then the compiler A/B.

## Implementation notes (C5b-1)

- `captureSlots(frees)` is the single source of the layout; `supplySlot`
  (creation sites, direct calls, module fallback allowed) and `heldSlot`
  (constructor paths, strict) resolve a slot to a local; `bindCaptureParam`
  declares the receiving parameter; `hasCaptured`/`loadCaptured`/
  `storeCaptured` hide whether a binding is a record field or a cell.
- The module record is loaded from `__modctx` at every use inside methods
  and other functions that do not hold it as a parameter. Caching that load
  in a per-function map was wrong: a load emitted on one control-flow path is
  not available on another (first compiler build, fixed before measuring).
- The synthetic `__module_init` node has no source position; its record's
  allocation site is recorded without a node.
