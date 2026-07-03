# TypeScript syntax coverage — audit & roadmap

Goal: AOT every TS construct. Status per construct, with the gap-filling order.
"silently dropped" = the exporter emits nothing for it (UNSOUND — must become an
explicit error until implemented).

## Expressions
| construct | status | notes |
|---|---|---|
| identifier, this, super | DONE | |
| numeric/string/bool/null literal | DONE | |
| `new C(...)` | DONE | class-tagged alloc + Direct ctor |
| call, method call | DONE | devirt Direct/Set/Unknown |
| property/element access | DONE | typed field or ts_get |
| binary arith/compare | DONE | +,-,*,/,%,<,<=,>,>=,==,=== etc |
| assignment `=` | DONE | |
| prefix/postfix unary | DONE | `!`,`-`,`++`,`--` with correct pre/post value |
| conditional `?:` | DONE | If-guarded value select |
| array/object literal | DONE | |
| arrow/function expr | DONE | closures lifted |
| as/non-null/paren | DONE | unwrap |
| compound assign `+= -= *= /= %=` | DONE | desugared to x = x op y |
| logical `&& \|\| ??` | DONE | short-circuit via If; ?? approximates falsy |
| template literal w/ `${}` | DONE | desugared to string concat |
| **spread `...`** | **DROPPED** | medium |
| `typeof` | DONE | ts_typeof runtime helper -> JS type-tag string |
| `void` | DONE | evaluate operand, yield undefined |
| `instanceof` | DONE (compile-time) | resolved from static class + subclass walk; dynamic-class operand errors loudly |
| `in` / `delete` | DROPPED | need dynamic property machinery |
| **comma, tagged template, optional chaining `?.`** | **DROPPED** | medium |
| `yield`/`await` | **P5 — not supported (errors loudly)** | needs state-machine transform + Promise/event-loop runtime; see docs/async_design.md |

## Statements
| construct | status | notes |
|---|---|---|
| block, var/let/const | DONE | |
| expression stmt | DONE | |
| return/throw | DONE | throw = return-as-sink (no real unwind) |
| if/else | DONE | flow-insensitive (sound) |
| for / while | DONE | lowered to Loop |
| do-while | DONE | body once + post-test Loop |
| for-of (arrays) | DONE | index-loop desugar over ts_array; for-in still errors |
| switch/case | DONE | exclusive if/else-if chain (no-fall-through) |
| break/continue | DONE (with caveats) | break in while/for/for-of; continue in while; switch break = no-op; continue in for/for-of and do-while break/continue error loudly |
| for-of over generator | DONE | .next()-driven; nested/break/continue/gen-consuming-gen; own g/r locals per loop |
| generator (function*/yield) | DONE | yield in loops/conditionals via general state-machine builder; yield*/in-try rejected |
| async/await | DONE | await in loops/conditionals/sub-exprs via general state-machine builder | state-machine coroutine; nested await rejected |
| fetch | DONE (http://) | non-blocking Promise + I/O queue; https needs TLS |
| try/catch/finally | DONE | setjmp/longjmp unwind; finally on normal+caught path; finally-through-return/throw rejected |
| **labeled stmt** | **DROPPED** | low |
| class declaration | DONE | full (fields, methods, accessors, ctor, super, inheritance) |
| optional chaining `?.` | DONE | TS downlevels; verified |
| nullish `??` | DONE | proper null/undefined test (not falsy); `0 ?? x === 0` |
| array destructuring | DONE | `[a,b]`, holes `[,x]`, nested `[[p,q],r]` |
| object destructuring | DONE | `{x,y}`, rename `{x: r}`; computed names error |
| destructuring params | DONE | `function f({x,y})` / `f([a,b])` |
| array spread | DONE | `[...a, b, ...c]` via ArrayPushAll |
| object spread | DONE | `{...o, k: v}` via ObjectCopyProps; later keys override |
| destructuring defaults | DONE | `[a=1]` / `{x=2}`; applies only on undefined |
| rest params | DONE | `function f(...args)`; callee gathers args[k..nargs] |
| call spread | DONE | `f(a, ...b, c)`; dynamic args buffer (CallSpread IR) |
| `in` operator | DONE | literal + dynamic key (ts_intern_field at runtime) |
| comma operator `(a, b)` | DONE | evaluate left, discard, return right |
| `delete obj.x` | DONE | static + obj['lit'] key; ts_delete_prop |
| `obj[k]` dynamic key | DONE | read+write via ts_get_dyn/ts_set_dyn (interned) |
| rest in destructuring | DONE | `[a, ...rest]` (slice), `{a, ...rest}` (ObjectRest) |
| for-in | DONE | lowered to Object.keys + index loop |
| labeled loop | DONE (innermost) | `L: for(...) break L`; multi-level jump errors |

## Priority order for gap-filling (by frequency × tractability)
1. compound assignment (`+= -= *= /= %=`)  — desugar to `x = x op y`
2. logical `&&` `||` `??`                   — short-circuit via If
3. unary `!`, `-`, `++`/`--`, ternary value — emit real value ops
4. switch + break/continue                  — lower to If-chain / labeled breaks
5. do-while                                 — Loop with post-test
6. template literals                        — desugar to string concat (ts_add)
7. typeof/instanceof/in                     — runtime helpers
8. optional chaining / nullish              — If-guarded loads
9. spread / rest / destructuring            — desugar
10. try/catch/finally, generators, async    — P5 (needs unwind/coroutine model)

## Safety rule (IMPLEMENTED)
The exporter now collects unsupported constructs and **exits nonzero** (code 3),
listing each with file:line, unless TSAOT_ALLOW_UNSUPPORTED=1. Silent miscompiles
are gone — every un-lowered construct is reported loudly.

## (original note)
Until a construct is implemented, the exporter must EMIT AN EXPLICIT ERROR
(unsupported-syntax) rather than silently dropping it, so we never produce
incorrect AOT output. This converts "silent miscompile" into "loud unsupported".

## Arrays (added)
The runtime now has a dense `ts_array` (length + contiguous tsv elements, GC-traced).
The IR gained LoadIndex/StoreIndex/ArrayLen/ArrayPush; the exporter lowers array
literals, `a[i]` read/write, `arr.length`, `arr.push(x)`, and `for-of` over arrays.
for-in and iterator-protocol for-of over non-arrays remain unsupported (error).

## Generics (works via type erasure; monomorphization planned)
Generic classes/functions currently compile via **type erasure** (like tsc):
`Box<T>` -> one class with `value: tsv`, `identity<T>` ignores `T`. Correct, but
all generic code takes the dynamic `tsv` fallback path and misses int64/double
specialization + SROA.

Planned: **monomorphization** (Rust/C++-template style) — emit a concrete
specialization per statically-resolvable type-argument tuple (`Box$number` with
`double value`), flowing through the existing specialization/SROA pipeline;
fall back to the erased version when instantiations aren't statically resolvable.
Complex type operations (conditional/mapped/`infer`/recursive types) are NOT
evaluated by tsaot — the TS checker reduces them to a concrete structural type
first, and tsaot only maps that to a C layout. See docs/generics_design.md.

## Fixes during typeof/void/instanceof work
- **strings are references, not unboxed primitives**: `classify` previously
  lumped StringLike into `primitive` (raw double), so a `string` field/param was
  coerced via `ts_to_num` and corrupted. Strings/symbols/bigints are now
  classified `reference` (heap-boxed tsv). Number/bool/void/undef/null remain the
  only unboxables.
- **bool consts boxed correctly**: a `tsv` local holding `true/false` now emits
  `ts_bool()` instead of `ts_num(1)`, so `typeof b === "boolean"` works.
- **strict equality on non-numbers**: `===`/`!==`/`==`/`!=` now use
  `ts_strict_eq` unless both operands are unboxed numbers, so string/bool/object
  comparisons are correct (numeric `==` fast path retained for numbers).
- **logical not via truthiness**: `!x` now emits `!ts_truthy(x)` instead of a
  numeric `== 0`, correct for boxed bools/objects/strings.
- **SROA excludes inheriting classes**: a class with a parent (or that is a
  parent) is not scalar-replaced, because the inliner does not yet correctly
  re-map a nested `super(...)` receiver to the field scalars. Such classes take
  the normal class path (correct); non-inheriting NoEscape classes still SROA.
