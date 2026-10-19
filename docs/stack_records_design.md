# Scope records on the C stack

Implemented in Session 350 (build `x51`); analyzer (`codegen.rs`) and the
lifetime fixture. Knob `TSAOT_STACK_RECORDS=0` keeps every record on the
heap.

## Finding

The allocation-site statistics of `x47` count 2.34M scope records per
compile (the capture context a function allocates at entry for its
captured mutable variables, `docs/capture_contexts_design.md`), the
largest category of counted allocations: `getSignaturesOfType` 472k,
`checkTypeRelatedTo` 275k, `checkIdentifier` 260k, `getFlowTypeOfReference`
250k. With the sound and nest-aware analysis of `x48`-`x50`, 1.08M of
them per compile are `NoEscape`, but `codegen::decide` keeps every record
on the heap ("shared with closures, which may outlive this frame through
paths the per-frame analysis does not bound") — a rule written when the
analysis lost stores through parameter contents (`x48`) and had no
summaries for the checker (`x49`).

## Design

- A record site that is `NoEscape`, single-shot (`Multiplicity::Once`: the
  function-entry record; per-iteration records stay `Many`) and in a
  function that is neither a generator nor async takes the `Stack`
  strategy: the existing class-instance emission declares the struct at
  function scope and the record's local holds the stack-tagged reference.
  Everything the record reaches is still traced: the frame slot roots it,
  `gc_mark_visit_slow` scans a non-heap cell's contents, and the write
  barrier skips a stack owner because it is scanned as a root.
- The escape state already bounds the record's lifetime: a record is only
  ever stored into the environments of the closures that capture it and
  passed to the nested functions that use it; a closure that escapes (any
  path: returned, stored, handed to a retaining builtin, kept by a callee)
  carries the record with it, and a callee that stores its record
  parameter reports it through its summary.
- Generator and async bodies run as state machines whose C frame does not
  survive a suspension; their records stay on the heap.

## Verification

Fixture `closures/stack_records_lifetimes`: a record used only by nested
direct functions and local callbacks while holding young objects across
collections; the counter closure; records retained by a module array, a
Map, a promise, a bound function, a direct helper that stores, a nested
function that stores; a closure stored into its own record and returned;
generator and async bodies; deep recursion with a record per frame.
Identical to V8, under `TSAOT_GC_YOUNG_THRESHOLD=1`, the GC stress gate,
and the usual gates; the compiler A/B in the TODO entry.

## Results

Decision report, count-weighted by the per-site statistics: records 1.02M
per compile Heap -> Stack at 120 sites (`getSignaturesOfType` 472k,
`checkIdentifier` 260k, `structuredTypeRelatedToWorker` 88k). Runtime
statistics: all allocations 14.29M -> 13.27M per compile, plain objects
5.88M -> 4.85M, minor collections 311 -> 291. Compiler A/B (`x51` against
`x50`): 4.512 vs 4.487 s and 4.488 vs 4.512 s median, neutral: the records
were cheap bump allocations and the stack struct is initialized per call.
A closure that reads a captured object's numeric field (`last ? last.v :
0`) still sends the whole record to the heap: the two-deep phantom carries
no path and the `+` materialization marks it global (the next slice).
