# Interfaces that extend Array are arrays

## Problem

The exporter classifies a receiver as an array from its static type
(`T[]`, tuples, `Array<T>`, `readonly T[]`), and an array receiver takes the
array paths: `for...of` as an index loop, `length` as `ArrayLen`, the
builtin element methods. A user interface whose base type is
`ReadonlyArray<T>` — the compiler's `NodeArray<T>` (`pos`, `end`,
`hasTrailingComma` on top of the elements) — was left dynamic: 174
`for...of` loops over node arrays stepped through the generic iterator
protocol (`ts_iter_step`: a `next` lookup, `ts_call_method`,
`ts_array_iterator_next` allocating a `{value, done}` object with two
generic property sets per element, then two inline-cache reads of it), and
`nodes.length`, `nodes.map(...)`, `nodes.some(...)` took the generic
length and the dynamic method dispatch.

## Design (`isArrayDerivedType` in `builtinReceiverKind`;
`TSAOT_ARRAY_INTERFACES=0` keeps the dynamic paths)

An object type is array-derived when it is an array type, or an interface
(a type reference's target) whose symbol is the global `Array` or
`ReadonlyArray`, or whose base types reach one (`checker.getBaseTypes`,
depth-limited). Such a receiver is classified `"array"` before the
user-symbol exclusion. Classes are excluded: a class extending `Array`
keeps the dynamic paths (species and subclass behaviour).

The assumption is the one the array type already makes: a value of the type
is a runtime array. For an interface this holds when every instance is
created as an array and augmented (how the compiler builds node arrays); an
object literal implementing the interface structurally would be
misclassified, which is why the knob exists and the design is recorded.

Fixture `arrays/array_interfaces` (an interface over `ReadonlyArray` with
extra properties and one over `Array`, created from `slice()` and
augmented; `for...of`, `length`, index reads, `map`/`filter`/`some`/
`every`/`findIndex`/`slice`/`indexOf`/`push`, spread, nested arrays of
them, a union with `undefined` narrowed first, passing to a `readonly T[]`
parameter, `Array.isArray`, `instanceof`, `JSON.stringify`, `Object.keys`).
