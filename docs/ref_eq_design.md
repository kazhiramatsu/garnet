# Strict equality of two references (session 352, slice AS)

## Problem

`a === b` compiles to `ts_strict_eq`, an inline fast path of several tag
tests: identical bits (then a NaN test), a number on either side, an object or
a function on the left, two strings out of line. tsc-ts has 2,376 such sites,
and the checker's hot ones compare nodes, symbols, types and flow nodes:
references, or a reference against `undefined`, where the whole question is
whether the bits are equal (a heap cell has one reference, and `null` and
`undefined` one encoding each). The tag tests are paid at every one of them.

## Design

The exporter, in the strict profile, marks the operand locals of a `===` or
`!==` whose declared types are references only (object types: class
instances, arrays, functions, object literals; plus `null`, `undefined`,
`void`; no primitive, `any`, `unknown`, type parameter or intersection
member) as reference-typed (`tyKind: "reference"`, the mark the typed Map
probes already read). The declared type, not the narrowed one: an identifier
answers for its declaration, a property access for the property, because the
local that holds a variable serves every site of the variable, and a
narrowing at one site says nothing about the value at another. The emitter
compares the bits of two reference-typed boxed operands; `TSAOT_REF_EQ=0`
keeps the call (the parity oracle). A union with a string member keeps the
content compare and a number member the numeric one (fixture
`classes/ref_eq`).

## Measurements

| program | before | after |
|---|---|---|
| tsc-ts typed, one checker, instructions | 23.50 G | 22.80 G (-3.0%) |
| cycles | 5.45 G | 5.31 G (-2.5%) |
| wall | 1.26 s | 1.23 s |
| `ts_strict_eq` sites in the generated code | 2,376 | 394 |

Outputs identical.
