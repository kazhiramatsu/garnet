# String accumulators

Session 350, build `x67`. Emitter (`emit_c.rs`), runtime (`ts_rt.c`).

## Finding

`getTypeListId` (the key of the union, intersection and type-list caches)
builds its result with `result += ","`, `result += startId` and
`result += ":" + count`; it alone took 3.4% of the compiler's samples
(`x62` profile), nearly all in the generic `ts_add`. Each `+` dispatches on
both operands, roots four values, and, when the left string is the live
tail of a builder buffer, extends the buffer in place but allocates a new
view cell for the intermediate string (the result of every `+` is a value
the program could keep). The intermediate strings are never observed here:
the local is only appended to, its length read, and returned. The IR of the
compiler has 21 such locals (`getTypeListId`, the scanner's `scanString`,
`scanTemplateAndSetTokenValue`, `scanIdentifierParts`, the diagnostic
formatters).

## Design

A local `L` is an *accumulator* of a function when

- it is defined exactly once by a copy of a string constant (`let s = ""`,
  `let s = "x"`), and otherwise only by appends: `T = L + E` followed by
  `L = T`, the temporary `T` defined and used nowhere else, `E` not `L`;
- every use of `L` is the left operand of such an append, a string length
  read (`StringLen`), or a `return L`;
- `L` is not a parameter, and the function is not a generator or async
  (their locals live in the coroutine frame across suspensions).

Then `L` holds a private builder (a buffer string with capacity) that no
other code can reach until the return:

- the initial copy is `ts_sb_new(constant)`;
- an append is `L = ts_sb_append(L, E)`: `E`'s ToPrimitive / ToString (a
  string's units, a number's digits) written into the buffer, a bigger
  buffer only when the capacity or the encoding (UTF-16) runs out; no
  intermediate string;
- the length read is the builder's length;
- the return is `ts_sb_finish(L)`: the buffer becomes an ordinary immutable
  string (its BUFFER flag cleared, so the generic `+` never extends it in
  place; a short ASCII result becomes the canonical immediate string).

The decision is the emitter's (the IR is unchanged): every other pass sees
the same instructions. `TSAOT_STRING_ACCUM=0` keeps the generic `+` (the
parity oracle).

## Results

The compiler: 16 functions with accumulators (65 appends), among them
`getTypeListId`, the scanner's string, template and identifier scanners
and the diagnostic formatters. A `getTypeListId` kernel (600k calls):
204 -> 119 ms (Node 120 ms with its startup). The compiler A/B against
`x66`: 4.306 vs 4.363 s and 4.259 vs 4.304 s median, five of six pairs
faster, about -1.2%.

## Not covered

An accumulator read in any other way (stored, passed, compared, read with
`charCodeAt`) keeps the generic `+`: materializing it would have to
snapshot the buffer before the next append. An accumulator initialized from
a non-constant (`let s = prefix`) is not one: its initial value may not be a
string at run time, and `+` would be addition.

## Gates

Fixture `strings/string_accumulators` (appends of strings, integers,
doubles, booleans, null and undefined, objects with toString / valueOf /
Symbol.toPrimitive, a UTF-16 append into an ASCII builder, growth past
several capacities, length reads between appends, an exception thrown by an
append's operand with the partial result returned from the catch, loops,
early returns, short results that must compare equal to literals and work
as Map keys, a disqualified local that is read between appends);
conformance, GC stress, parity (old text under the knob); the compiler's
A/B.
