# Lazy closure values for nested declarations

## Problem

A nested function declaration that is used as a value anywhere — passed
to `mapType`, `compareProperties`, `createInferenceContext`, stored in a
variable — is hoisted at the owner's entry: its closure is allocated in
every activation of the owner, whether or not the path that uses the
value runs, and stored in the owner's scope record when a nested closure
reads it. `checkTypeRelatedTo` allocates five such closures per call
(`reportError`, `isRelatedTo`, `isRelatedToWorker`, the two incompatible-
signature reporters), 275k calls per compile; `getFlowTypeOfReference`
allocates `getInstanceType` for the one `new` flow node in a hundred,
`getResolvedBaseConstraint` allocates `getBaseConstraint` for the
intersection case. Closures are 2.0M of the 17.5M allocations at the
forty hottest sites, 3.26M per compile in all, 120 bytes each. V8 also
creates them at entry, but its allocation is a bump of a few words and
its optimizing tier drops the unused ones; for the AOT compiler the
creation is a runtime cell with a handle, so creating only on the paths
that need the value is the better trade.

## Design

A nested declaration used as a value gets its closure *on first use* in
an activation, cached in the binding's storage so that identity is
preserved (`f === f`, `seen.has(f)`): the storage — the owner's record
field when the binding is captured by a nested closure, a plain local
otherwise — starts as `undefined` in the prologue; each value use reads
it and, when it is still `undefined`, allocates the closure with the
captures held at that site and stores it back. JS hoisting is preserved:
a use before the declaration's text sees the function, because creation
happens at the use. Direct calls never need the value and are unchanged.

A nested closure that uses the declaration as a value must be able to
create it, so it needs the declaration's captures: the free-variable
rollup now treats a value use of a nested declaration like a direct call
(the user captures what the declaration captures), exactly the rule that
already lets direct calls thread cells. The cost is a few more
environment slots for such closures; the gain is one allocation per
activation that actually reaches the use, instead of one per activation.

Module-level declarations keep their global function values (created
once per program). `TSAOT_LAZY_FN_VALUES=0` (exporter) keeps the eager
hoisting; the parity oracle's corpus is exported with it.

## Verification

Fixture `closures/lazy_function_values`: identity across repeated uses
and across uses from the owner and from nested closures; a use before
the declaration's text; a declaration both called directly and used as
a value; recursion through the value; uses on one branch only (the
closure is never created on the other); generators and async owners;
a declaration capturing a loop constant; `TSAOT_LAZY_FN_VALUES=0` and
`1` against V8; the compiler's closure allocations per compile from the
per-site statistics; the compiler A/B.
