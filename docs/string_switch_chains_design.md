# Strict equality against string literals

Session 350, build `x69`. Emitter (`emit_c.rs`), runtime (`ts_rt.h`).

## Finding

Comparing the compiler's profile with V8's per function (`node --cpu-prof`
against `sample`, each runtime frame charged to its generated caller) put
`getCannotFindNameDiagnosticForName` at 26 ms against V8's 6 ms. It is a
`switch (node.escapedText)` over about thirty string labels, lowered as a
chain of `x === "label"` tests that computes the case index, and it runs
for every identifier the checker resolves. Each test was the generic
`ts_strict_eq`: two numeric tag tests, an object test, then the
out-of-line `ts_strict_eq_str` (views of both operands, the lengths, the
content), thirty calls for a name that matches no label.

## Change

A local whose every definition is the same string constant
(`str_consts_for`, like the tag constants of `undefined` / `null` /
booleans) makes `x === lit` and `x !== lit` the inline `ts_eq_strlit(x,
lit, len)`: the same value; a heap string (any representation: flat,
view, buffer) of the literal's length; a short immediate string of that
length; only then the content compare. Every other kind and every other
length answers without a call. `TSAOT_STR_EQ_CONST=0` keeps the generic
equality (the parity oracle).

## Also in this build

The native compiler's host read source files with `fopen`, a size probe
by `fseek` to the end, `ftell` and `rewind`, then `fread`: `readFile` took
47 ms against V8's 8 ms, 20 of them in `fseek`. It now uses `open`,
`fstat` and `read`, as Node's `readFileSync` does.

## Results

Neutral on the compiler: A/B against `x68`, 4.305 vs 4.291 s and 4.261 vs
4.264 s median. The per-function comparison that found both items charges
a small function's time to its own name in garnet but to its (inlining)
callers in V8, and charged a full collection to whichever allocation
triggered it (`toFileNameLowerCase` looked 7x slower than V8 for that
reason alone); the collections are now a separate row of the comparison.

## Gates

Fixture `strings/strict_eq_literals` (a thirty-label switch with grouped
cases, matched by literals, slices, concatenations, short immediates,
UTF-16, the empty string; `===` / `!==` against values of every kind; also
under GC stress); conformance; the compiler's A/B.
