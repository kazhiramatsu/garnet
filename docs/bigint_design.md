# BigInt

Session 363. Runtime (`runtime/bigint.c`, `ts_rt.c`), exporter (`exporter.ts`), emitter (`emit_c.rs`). Slices 1 to 3 are in.

## Why now

A sample of test262 (500 cases of `built-ins` and `language/statements`) has 29 compile-time rejects on a BigInt literal,
most of them in tests about something else, and of 150 TypedArray cases 61 stop on `BigInt64Array`. The harness's
`testTypedArray.js` mentions them. Real programs use BigInt for ids, nanosecond timers (`process.hrtime.bigint()`) and
64-bit hashes.

## Constraints

- **No cost for a program without BigInt.** Number code stays what it is: unboxed doubles and integers. A program that
  neither writes a literal, nor names `BigInt`, `BigInt64Array`, `BigUint64Array`, `hrtime.bigint`, nor reads
  `getBigInt64`, cannot make one (JSON does not). That is a scan of the program, as the frozen tests have.
- **A mix is a TypeError, never a NaN.** `1n + 1` throws. `ts_to_num` over a BigInt cell must not reach an unboxed slot
  silently: the number conversions throw.

## The value

A heap cell, kind `TS_KIND_BIGINT`, under the object selector as a Symbol is: sign, length, 64-bit limbs in place,
immutable. (`unsigned __int128` gives the full product of two limbs on both targets.) `ts_is_bigint`. The tests that mean "an object, not a Symbol" (`ts_object_like(v) && !ts_is_symbol(v)`) become
`ts_is_object_value`, one definition for both primitive cells. A leaf for the collector.

`typeof` is `"bigint"`. `===` and SameValueZero (Map, Set, `includes`) compare by value: the slow arm of the comparisons,
past the bit test, as strings are. Truthiness: `0n` is false. A property read goes to `BigInt.prototype`, as a Symbol's does.

## The language

- `BigIntLiteral`: `Const { kind: "BigInt", value }`, a cell made once per site at setup, rooted.
- `bigint` classifies as `reference`: no unboxing, no integer specialization.
- A binary or unary operator with a `bigint` operand lowers to `ts_bigint_op(op, a, b)`.
- With an `any` operand, in a program that can make a BigInt, the dynamic operators (`ts_arith_any`) test for the cell on
  their slow arm; in any other program they are what they are today.
- `++`, `--`, compound assignment: the same through the target-once lowering.
- Comparisons between a BigInt and a number or a string: by mathematical value, as the specification says, the double
  compared exactly against the integer.
- `>>>` is a TypeError. `**` with a negative exponent, `/` and `%` by `0n` are RangeErrors.

## The library

`BigInt(x)` (a number must be an integer, a string parses, `new BigInt` is a TypeError), `BigInt.asIntN`, `asUintN`,
`BigInt.prototype.toString(radix)`, `valueOf`, `toLocaleString`, `Number(big)`, `parseInt` of its string, `String(big)`,
template literals, `JSON.stringify` (a TypeError), `BigInt64Array`, `BigUint64Array` (`ta_load` works in doubles: these two
kinds take their own arm in `ts_ta_get`, `ts_ta_set` and the methods), `DataView.getBigInt64` and friends, `Atomics` over them.

## The arithmetic

In the runtime, in C, not in TypeScript compiled by garnet: a number in TS is a double, there is no way to write the high
half of a 64-bit product, and the limbs live inside the collector's cell. The comparisons and `typeof` are the runtime's
in any case.

- Multiplication: schoolbook, Karatsuba above a threshold taken from a measurement. An NTT over 64-bit primes when a
  benchmark asks for it; with it Toom-Cook adds little and can be skipped.
- Division: Knuth's Algorithm D. Burnikel-Ziegler or a Newton inverse over the fast multiplication, likewise on demand.
- Decimal: repeated division by 10^19, divide and conquer past a threshold.

## Small values

What programs do with BigInt is ids, timers and 64-bit hashes, not numbers of thousands of digits, so the size that
matters is one limb. A cell for each intermediate result is the cost there.

`BigInt.asUintN(64, e)` and `asIntN(64, e)`, where `e` is built of `+ - * & | ^ << >>` over `bigint`s known to fit, need
no cell: the wrap is the C type's. The operand types are the checker's and the bound is the call's, so this is a pattern
the exporter can lower to raw `uint64_t`, a loop of FNV or xorshift with no allocation at all. A slice after the
operators work.

## Slices

1. The cell, literal, `typeof`, equality, printing, `BigInt()`, `toString`. A compile-time reject for the operators.
2. The operators, typed and `any`.
3. `asIntN`, `asUintN`, the conversions, JSON, Map and Set keys.
4. The typed arrays, DataView, Atomics.
