# Callback specialization (whole-program item 1)

Implemented in Session 350 (slice `x30`); exporter only
(`exporter/exporter.ts`). Knob `TSAOT_SPECIALIZE_CALLBACKS=0` disables it;
`TSAOT_SPECIALIZE_CALLBACKS_LOG=1` prints one line per clone.

## Finding

`binarySearch(array, value, keySelector, keyComparer)` and
`binarySearchKey` are called through `containsType` and `addTypesToUnion`
with `getTypeId` and `compareValues` (83 inclusive samples of the `x28`
profile, 3%); `getCombinedFlags(node, getter)` (33 self samples) and the
`core.ts` iteration helpers take their callbacks the same way. Inside
such a function the callback is a parameter, so every call to it goes
through a function value: the closure's generic entry, boxed arguments,
and no inlining of the one-line callee.

## Change

At a call `f(a, cb)` to a module-level function whose argument `cb`
names a module-level function (directly, or through an enclosing clone's
binding), the exporter lowers a clone of `f` with the parameter bound to
that function and routes the call to it. Inside the clone a call to the
parameter is a direct call to the function, which specializes in turn
when the clone passes the parameter on (`binarySearch` →
`binarySearchKey`), and a read of the parameter as a value yields the
function's value. The clone drops the bound parameters and the call site
drops the arguments. Clones are cached per (function, bound parameters)
and capped at sixteen per function; a recursive call inside a clone hits
the cache and calls the clone itself.

A parameter qualifies when it is a plain identifier without a default
value, is never assigned, and every reference to it in the body is either
a callee or an argument of a call whose callee names a module-level
function; a reference from a nested function or class keeps the
parameter on the generic path (the clone has no local for it to
capture). The function must be a non-async, non-generator declaration
that does not read `arguments` and does not take `this`. The target must
be a function declaration (module-level, or nested) that does not take
`this` and whose captured cells are all among the owner's: the clone
calls it directly with those cells threaded, and a value use boxes it
with the cells the clone holds (`directFunctionValue`; a target with
cells the owner lacks would need the pre-scanned value global, and the
first attempt tripped the emitter's cell-count check for exactly that
case). Generic functions are cloned erased (the type-parameter
specialization of `specializeGenericCall` takes precedence when it
applies).

The compiler's export creates 54 clones, among them `binarySearch` and
`binarySearchKey` bound to `getTypeId` + `compareValues` (the checker's
`containsType` / `addTypesToUnion` sites), to `getPos` + `compareValues`,
to `identity` + `compareStringsCaseSensitive`; `getCombinedFlags` bound
to `getNodeFlags`; `getFirstJSDocTag` to fifteen JSDoc tag predicates;
`insertSorted`, `deduplicate`, `pushIfUnique`, `comparePathsWorker` and
`getSpellingSuggestion` to their comparers. Parser helpers such as
`lookAhead` and `tryParse` stay generic: their callbacks capture the
parser's state cells that the helpers do not hold.

## A latent hole in direct calls to clones

A direct call threads the callee's captured module cells as leading
arguments, looking the callee's declaration up by function id. A clone
shares its declaration with the original but has a fresh id, which that
lookup did not know: the first `x30` build threaded no cells into the
clone of `createModuleOrTypeReferenceResolutionCache`, every argument
shifted by one, and the compiler died with "value is not a function" in
`toPath` (the conformance fixtures have no cell-capturing specialized
function, so they passed). Clones now register their id against the
declaration (`registerSpecNode`), for callback clones and for the
generic-type clones of `specializeGenericCall`, which had the same hole.
The fixture gained a module-cell case (an owner and a target that both
capture module-level `let` bindings).

## Verification

Fixture `functions/callback_specialization`: binary search with several
selectors and comparers (including a generic identity), pass-through to
another helper, a callback that throws, a parameter also used as a value
(unchanged path), a reassigned parameter (unchanged path), closures and
arrows as callbacks (unchanged path), extra and missing arguments through
an `any` cast, recursion through a bound parameter, and the same helper
called with different callbacks in a loop. Identical to V8. The parity
oracle sees ordinary functions (the clones are plain IR), so no oracle
knob is needed. The compiler A/B (`x30` against `x28`) is in the TODO
entry.

## Results

Compiler A/B, `x30` against `x28` (alternating three runs, outputs
validated, diagnostics zero): 5.554 → 5.483 s median wall (−1.3%; the
pairs −0.9%, −1.9%, −1.3%), Node 3.30 s. The runtime statistics are
unchanged (the clones change the call shape, not the allocations).
