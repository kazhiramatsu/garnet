# String building fast paths (Session 360)

## Problem

Building a string a piece at a time ran five to eight times Node's time.
Three kernels (ns per iteration, 2 M iterations; Node in parentheses):

| kernel | garnet | Node |
|---|---|---|
| vue's codegen `push`: five `ctx.code += piece` through a closure | 95.2 | 18.8 |
| a local's two appends, `s += "ab"; s += "cde"` | 31.5 | 3.85 |
| a template, `` `item-${i}:${i & 7}` `` | 54.2 | 7.53 |

vue's template compiler spends 8% of its time in the codegen's `push`, and
the compiler phase as a whole ran at 1.58 times Node.

The profiles showed the costs piled up in small steps:

- Every `+` of two strings went through the generic add: the number tests,
  the object and symbol tests, four root pushes, two `ts_to_string_v` calls
  that return their argument, and two views. The view of an append's left
  operand, a view of a builder buffer, is out of line.
- The builder's append took the buffer's capacity from the cell's block
  (`gc_cell_capacity`), with a division by the unit size, and wrote the
  terminator with a `memset` call.
- An immediate short string (up to five ASCII bytes in the value itself)
  was copied unit by unit through the generic accessors. A template's
  static pieces are such strings.
- `ts_str_concat_many` scanned its pieces in three loops, rooted each one,
  built each piece's view more than once, and zeroed sixteen digit lengths.
- A template converted every number substitution to a string first (a
  number formatted, then `ts_new_string` decoding the ASCII digits as
  UTF-8 and scanning them twice), so the join's own integer path, which
  formats digits on the stack, never applied.

## Design

- **Two strings.** `ts_add` takes two strings to `ts_str_add2` before any
  other test; the generic path converts its operands and calls it too.
- **The live tail first.** `ts_str_add2` first tests whether the left
  operand is the live tail of an append history: a view of the whole of a
  one-byte buffer, with room for the piece. It needs only the headers, not
  the left operand's view. A short piece's length comes from its value and
  its bytes are stored by two overlapping word stores (`ts_short_str_put`).
  The roots are pushed in line (`gc_root_push`), and the terminator is a
  store. The capacity is a shift.
- **Copies.** `ts_str_copy_units` materializes an immediate short string's
  bytes (`ts_strview_materialize`, now a word copy) and copies up to 32
  bytes by word moves (`ts_copy_small`).
- **ASCII input.** `ts_new_string` checks for ASCII a word at a time and
  takes the one-copy constructor.
- **The simple join.** `ts_concat_simple` handles two to sixteen pieces,
  each a one-byte string or an integer, when the result is below the
  builder threshold. It makes one pass for the lengths (an integer's digits
  on the stack) and one copy pass, and builds a short result in a register.
  Anything else takes the general path.
- **Templates.** Under the strict type profile, a template substitution of
  a number type (number, a number literal, a union of them) is left
  unconverted when the template has two parts or more. Its ToString has no
  effect to order. Such a template joins through `string.template`
  (`ts_str_template`), which converts every piece to a string and never
  adds. The chain form, `ts_str_concat_many`, keeps `+`'s semantics:
  `` `${1}${2}` `` is "12", where `1 + 2 + ""` is "3".
  `TSAOT_TEMPLATE_NUMBERS=0` keeps the conversion.
- **The slot barrier's exit.** A plain object's slot store returns in
  line when the object is remembered and the slot's card is already in its
  dirty range. The codegen context is old, and every `code +=` stores a
  young string into it.

## Measurements

The kernels (ns per iteration):

| kernel | before | after | Node |
|---|---|---|---|
| `push` | 95.2 | 50.5 | 18.8 |
| local appends | 31.5 | 12.9 | 3.85 |
| template | 54.2 | 14.2 | 7.53 |

The real projects (r24 against r23, alternating rounds, medians, outputs
identical): vue 1,049.1 -> 1,020.0 ms (its compiler phase 380 -> 355 ms),
hono's TrieRouter 220.6 -> 208.8 ms, SmartRouter 55.4 -> 54.2, RegExpRouter
54.3 -> 53.7, hono_app 150.0 -> 149.3 (Node 154.5 in the same run), tsc-ts
cycles 0.9906 (instructions 1.0010). PatternRouter read 232.6 -> 237.3 in
the four-router driver and the same alone (a PatternRouter-only driver:
6.587 G instructions and about 235 ms both): the shared binary's layout.

Fixture `strings/template_numbers.ts`: every kind of number in templates
(-0, NaN, the infinities, fractions, 2^53 + 2, 1e21), adjacent number
substitutions, a lone substitution, appends to a local and to a property,
short and long pieces. It agrees with V8 in the plain and strict modes.

## Next

An append still allocates the new view and calls the generic add from
the generated code. The string accumulators (`ts_sb_new`, `ts_sb_append`,
docs/string_accumulators_design.md) keep a local's buffer without views
where the emitter proves the local only appends; the kernel above reads
`s.length` in the loop, which they do not cover yet.
