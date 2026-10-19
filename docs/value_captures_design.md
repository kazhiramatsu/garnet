# Capture by value for immutable bindings

## Problem

A captured binding lives in a cell: in its owner's scope record (one
`__ctx_<owner>` instance per activation of the owner, allocated in the
prologue) or, for a loop-declared binding, in a `__cell` object per
iteration. Closures carry references to those cells, and every access —
in the owner as well as in the closure — is a field load or store through
them. The per-site allocation statistics of Session 350 put scope records
at the top of the compiler's allocations: `getTypeFactsWorker` 882k per
compile, `instantiateTypeWithSingleGenericCallSignature` 528k,
`getSignaturesOfType` 472k, `hasMatchingRecursionIdentity` 359k,
`checkTypeRelatedTo` 275k, `isDeeplyNestedType` 264k, ... (5.4M of the
17.5M allocations at the forty hottest sites). In every one of the hottest
cases the record exists because a small arrow passed to `some`, `map`,
`everyType` or `reduceLeft` reads a *parameter* that nobody ever assigns
(`callerOnlyNeeds`, `identity`, `stack`/`depth`/`maxDepth`, `writing`,
`assumeTrue`, `kind`), and it is allocated whether or not the arrow is
ever created. V8 allocates a context for such a function too, but its
optimizing tier removes it when the closure does not escape; an AOT
compiler can do better statically: a binding that is never reassigned has
one value for its whole lifetime, so a closure may carry the value itself.

## Design

A third capture slot kind, `value`, next to `record` and `cell`:

- **Eligibility** (exporter prepass `computeImmutableBindings`): a
  binding is *immutable* when no assignment targets it anywhere —
  `=`, compound assignment, `++`/`--`, a destructuring assignment target,
  the loop variable of `for (x of …)`/`for (x in …)` with an existing
  variable — other than its own declaration initializer. A binding is
  *value-capturable* when it is immutable, owned by a function other than
  the module initializer (module-scope bindings already live in the global
  record, no allocation per call), declared as a parameter (a plain
  identifier) or by `const`/`let`/`var` with an initializer, and is not a
  function or class declaration (nested declarations may be mutually
  recursive: their closure values are created in hoisting order), nor the
  lexical `this` sentinel.
- **Initialization order.** A parameter is initialized at entry, so any
  capturing function — a hoisted declaration included — sees its value.
  A `const`/`let`/`var` binding is initialized when its declaration runs,
  so it may be captured by value only by functions created after that:
  arrows, function expressions, methods of class expressions and
  accessors whose text starts after the declaration ends, and nested
  declarations that are never used as values (called directly: the cells
  are threaded at the call, which happens after initialization in any
  program that does not read the binding in its temporal dead zone — the
  exporter already rejects the TDZ reads it can see, and the runtime has
  no TDZ checks for cells today either). A hoisted declaration used as a
  value captures body constants through the record as before.
- **Representation.** The owner keeps a value-captured binding as a plain
  local (it is removed from `cellBindings`, so no record field and no cell
  is created for it). `captureSlots` lists value slots after the records
  and cells, in binding-id order, so creation sites, direct-call sites and
  the callee prologue agree. At a creation or direct-call site the slot is
  supplied from the supplier's `localOfSymbol` (its own local, or the value
  parameter it received); in the callee, `bindCaptureParam` declares a
  leading parameter with the binding's reference kind and registers it in
  `localOfSymbol`, so every read is the ordinary local path — a numeric
  binding arrives as a raw double through the typed direct entry. The IR
  is unchanged: `AllocClosure.captures` and `capture_count` already carry
  arbitrary locals as leading environment slots, the environment array
  holds them as values, and the collector scans environments as `tsv`.
- **Escape analysis** already records each capture as a reference held by
  the closure object (`FieldKey::Capture`), so an object captured by value
  escapes with its closure exactly as a cell did.
- **Loop-declared constants** (`for (const t of types) f(() => t)`) are
  value-capturable, which also removes the per-iteration cell.

`TSAOT_VALUE_CAPTURES=0` (exporter) keeps every capture in cells; the
parity oracle's corpus is exported with it.

## Expected effect

No scope record for a function whose captured bindings are all immutable
(the hottest eleven sites above), smaller records elsewhere, no
per-iteration cells for loop constants, and captured reads that are plain
locals (one load fewer, unboxed numerics). Risks: a binding wrongly
classified immutable (an assignment form the prepass does not recognize)
would make a closure observe a stale value — the fixture enumerates every
assignment form; a capture before initialization would observe the
uninitialized local — the fixture covers hoisted declarations, expression
closures before and after the declaration, and direct-call-only
declarations.

## Verification

Fixture `closures/value_captures`: parameters captured by arrows passed to
callbacks and by hoisted declarations; `const`/`let` captured after their
declaration, including loop constants (per-iteration semantics) and
closures stored and called later; nested threading three levels deep;
every assignment form (`=`, `+=`, `++`, destructuring, `for of` with an
existing variable, a self-assignment) keeping its binding in a cell and
shared; generators and async functions; methods of class expressions;
`TSAOT_VALUE_CAPTURES=0` and `1` compared against V8; GC stress with
captured object values; the compiler A/B and the per-site statistics
(records per compile).
