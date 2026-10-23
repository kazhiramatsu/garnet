# `arr.push(v)` and `x === n` in line (session 352, slice AA)

Two call forms the tsc-ts build emits thousands of times each went through
out-of-line runtime calls whose common case is a few instructions.

## `arr.push(v)` (2055 sites)

`ts_array_push` tested the receiver and called `ts_array_set`, which tested
the receiver again, the frozen bit, the capacity, stored, and ran the write
barrier: two calls with prologues per push, 2% of the emit phase's samples in
`ts_array_set` alone (the printer builds its output by pushes). The in-line
form mirrors `ts_array_set_inline`: a plain array (not frozen) with room
stores the slot at `len`, bumps `len`, and remembers the array when it is old
(the young-value test and the cards stay out of line in `ts_array_remember`).
Growth, frozen arrays, sparse arrays and other receivers take `ts_array_push`
with the complete semantics. Knob: `TSAOT_PUSH_INLINE=0`.

## `x === n` with one unboxed side (676 sites)

`node.kind === SyntaxKind.X` on a monomorphic field is a double compare
already; the sites left were a boxed value against an unboxed number
(`links.flags === n`, a Map value, an optional number), emitted as
`ts_strict_eq(v, ts_num(d))`: boxing (with NaN canonicalization), the
bit-identity test, then the two-numbers path. Only a number can be strictly
equal to a number, and two numbers are strictly equal exactly when their
doubles are (NaN differs from everything, -0 equals +0), so the site is now
`ts_eq_num(v, d)`: a tag test and a double compare, no boxing. `!==` is its
negation. Knob: `TSAOT_EQ_NUM=0`.

Both are pure fast-path extractions: the slow paths are the previous entries.
Fixtures: `arrays/push_fast_paths`, `numbers/eq_num`.

## Measurements

| program | before | after |
|---|---|---|
| `array_push_eq` kernel (pushes into a growing array, `x === n` on the values read back), instructions | 0.893 G | 0.685 G (-23%) |
| `array_push_eq` kernel, cycles | 0.252 G | 0.252 G (the kernel is bound by its stores) |
| tsc-ts one checker, instructions (2006 push sites, 680 equality sites) | 24.18 G | 23.90 G (-1.2%) |
| tsc-ts one checker, cycles | 5.493 G | 5.492 G |

Outputs byte-identical (`out_ab.sh`).
