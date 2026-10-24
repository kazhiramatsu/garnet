# Static micro-patterns: tag compares, inline element reads, raw loop flags, conditions

Session 350, after the slot-first inline cache. The compiler's profile is
flat (the hottest generated function, `getObjectFlags`, is 1.2% of samples),
so the remaining gap to V8 is spread over the per-operation cost of the
generated C. These three patterns recur in nearly every function of the
compiler and each is decided from information the emitter already has.
Section 4 (session 353) adds the exporter's lowering of logical operators in
condition position.

## 1. Strict and loose equality against `undefined`, `null` and booleans

`array !== undefined`, `node.x === undefined`, `flag === true` were emitted
as `ts_strict_eq(a, b)`: an inline function that compares the bits, then
tests for numbers (NaN), then for strings (content compare out of line), then
for heap references with the handle/pointer duality. The constant operand
was a local holding `TS_UNDEFINED`, so none of those tests could fold.

`undefined`, `null`, `true` and `false` each have exactly one encoding in the
NaN-boxed value (no handle duality, and `ts_num` canonicalizes a NaN whose
bits would look like one), so `a === <tag>` is `a == TAG` on the raw bits.
`tag_consts_for` collects, per function, the locals whose every definition
is the same `Const Undef`/`Null`/`Bool`; parameters and catch variables are
defined outside the instruction stream and are excluded. The `===`/`!==`
arms emit the bit compare when one operand is such a local and the other is
boxed; `==`/`!=` against `undefined` or `null` emit `ts_is_nullish_fast`
(the only loose-equality rule that applies to those two values). Numbers and
strings never qualify (NaN, -0, string contents).

## 2. Inline array element reads

`a[i]` called `ts_array_get` out of line at 1,773 sites in the compiler. The
array case is three loads and two compares (`kind == ARRAY`, `i < len`,
hole test); only a string receiver (a one-character view, which allocates)
or an exotic receiver needs the call. `ts_array_get_inline` and its lazy-frame
variant (which links the frame only around the out-of-line call, as
`ts_array_get_lazy` did) put the array case in the caller. The hole marker
moves to the header so the inline test can see it.

## 3. Raw boolean constants in condition temporaries

The exporter lowers `for (init; cond; update)` with a first-iteration flag
(`first = true; loop { if (first) {} else { update } first = false; ... }`)
so that `continue` is a plain C `continue`. The flag's definitions are
boolean constants, which the condition-temporary rule
(`docs/truthy_unbox_design.md`) did not admit, so every such loop boxed the
flag with `ts_bool` and tested it with `ts_truthy_fast` per iteration. A
boolean constant is now an admitted raw definition (0/1) of a local whose
uses are all conditions; with the flag a plain `long long`, clang peels the
first iteration and the flag disappears.

`TSAOT_TAG_EQ=0` and `TSAOT_INLINE_INDEX=0` keep the previous forms
(parity oracle); the loop flag is covered by `TSAOT_TRUTHY_UNBOX=0`.
Fixtures `operators/tag_eq` (every value kind against every tag, constants on
either side, reassigned parameters, catch variables, locals holding several
constants over time, the compares used as values, loose equality with
booleans) and `arrays/index_inline` (holes, out-of-range and negative
indices, strings, nested arrays, growth, truncation, deletion, lazy-frame and
allocating callers).

## 4. Logical operators in condition position

The exporter lowered `a && b` and `a || b` everywhere as a value: `res = a; if
(a) res = b`, and an `if (a && b)` then tested `res`, a local of the operands'
union kind. Where an operand is an object, a string or `undefined` and the
other a number (`if (node.parent && node.parent.flags & 1)`, the compiler's
daily idiom), `res` is boxed: the number is wrapped by `ts_num` and the test
unwraps it again through `ts_truthy_fast`, a tag test and a NaN check per
condition. 20.7% of the compiler project's `If` conditions (9,550 of 46,229)
have this shape.

In condition position (`if`, `while`, `for`, `?:`, and under a `!` there)
the exporter now lowers `&&` and `||` as short-circuit control flow over a
primitive truth flag (`lowerCond`): `flag = truthy(a); if (flag) flag =
truthy(b)` for `&&`, the mirror for `||`, `!` negating the flag, and the
`If` tests the flag. An operand that is itself logical or negated
contributes its own flag; a value in a primitive local is copied as the
number it is (the test reads a number as before); a boxed value goes
through `!!`, two negations the C compiler folds into one truthiness test.
The flag's final truthiness is the value's (`truthy(a) ? truthy(b) : false`
for `&&`), so nothing observable changes; `??` and logical operators used as
values keep the value lowering. Fixture `expressions/logical_conditions`
(every operand kind including NaN, -0 and "", short-circuit side effects,
chains, negations, loops, the ternary) against V8.

Measured: the `flags_truthy` kernel 8.53 to 8.21 G instructions (-3.7%,
one such condition per iteration), the compiler's one-checker compile
instructions 0.9857 and cycles 0.9931 (trained builds, outputs identical).
`TSAOT_COND_FLAGS=0` restores the value lowering.
