# Callbacks that builtins call but do not retain

Implemented in Session 350 (build `x50`); analyzer only (`interproc.rs`),
active in the phantom mode (`TSAOT_ESCAPE_PHANTOMS=0` keeps the previous
analysis).

## Finding

After the nest summaries (`x49`) the hottest heap closures of a compile
were callbacks handed to builtins: `members.forEach((symbol, id) => ...)`
in `getNamedMembers` (55k per compile), `callSignatures.some(sig => ...)`
in `resolveCallExpression` (52k), the predicates of `filter`, `find` and
`every`. A builtin call made every argument escape globally, so each such
callback was a nursery allocation and its environment copied the captured
cells.

## Change

- `callback_argument(builtin)` names the argument position of a callback
  that the builtin calls and drops: the iteration methods of arrays
  (`forEach`, `some`, `every`, `filter`, `map`, `find`, `findIndex`,
  `findLast`, `findLastIndex`, `flatMap`, `reduce`, `reduceRight`), the
  comparator of `sort`, `Map.forEach` and `Set.forEach`, the function form
  of `replace` / `replaceAll`, the map function of `Array.from`. That
  argument is not copied to the global sink; the receiver and the other
  arguments keep the conservative rule, so the elements the callback
  receives are global as before. A builtin that keeps its argument (`then`,
  `bind`, `Map.set`, `push`) is not listed.
- The callback's effects on its captured cells were already applied when
  it was created (`AllocClosure` applies the lifted body's summary, folding
  `field_ret` to the global sink), but a captured *value* (a by-value
  capture is a leading parameter of the body) that the body returns was
  not: `[1, 2, 3].map(() => b)` left `b` on the stack while the result
  array held it, and the same hole existed for a callback that a direct
  helper calls and whose result the caller stores. At creation a `ret`
  entry naming a capture parameter now sends the captured actual to the
  global sink.

## Verification

Fixture `closures/builtin_callback_lifetimes`: callbacks capturing a local
object through every listed method with the results read back after 200k
allocations; callbacks a container or builtin keeps (`Map.set`, `push`,
`then`, `bind`, a closure created inside a `forEach` callback and pushed
outside) and a captured object returned through `map` and through a direct
helper, all read back after collections. Identical to V8 and under
`TSAOT_GC_YOUNG_THRESHOLD=1`; the other lifetime fixtures unchanged; the
old mode's decision report byte-identical; the usual gates; the compiler
A/B (`x50` against `x49`) in the TODO entry.

## Results

Decision report, count-weighted: closures 110k per compile Heap -> Stack
at 256 sites, none the other way; scope records `NoEscape` for 1.08M
allocations per compile (983k before: the records captured by these
callbacks). Analysis of the compiler unchanged (26 s).
