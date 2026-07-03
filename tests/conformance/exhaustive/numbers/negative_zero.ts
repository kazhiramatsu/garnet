// Negative zero from the `-0` / `-0.0` LITERAL is a genuine double -0.0 (not the
// int-specialized +0), so it is observable exactly as in JS: console.log shows
// "-0", Object.is distinguishes it from +0, and `1 / -0` is -Infinity. String
// coercion / templates / JSON.stringify still render "0" (JS spec), and `-0 === 0`
// is true. Runtime arithmetic that produces -0 must also keep the sign even when
// nearby values are int-specialized.

function main(): void {
  // console.log / inspect show "-0"
  console.log(-0); // -0
  console.log([-0, 1]); // [ -0, 1 ]
  console.log({ a: -0 }); // { a: -0 }

  // Object.is distinguishes -0 from +0
  console.log(Object.is(-0, 0)); // false
  console.log(Object.is(-0, -0)); // true
  console.log(Object.is(-0, 0.0)); // false

  // 1 / -0 === -Infinity (sign of zero matters in division)
  console.log(1 / -0); // -Infinity
  console.log(1 / 0); // Infinity

  // a -0.0 literal stored in a variable keeps its sign everywhere
  const x = -0.0;
  console.log(1 / x); // -Infinity
  console.log(Object.is(x, -0)); // true
  console.log(x); // -0
  console.log(x === 0); // true (=== does not distinguish -0)

  // String coercion / template / JSON render plain "0" (JS spec), unchanged
  console.log(String(-0)); // 0
  console.log(`${-0}`); // 0
  console.log("" + -0); // 0
  console.log((-0).toString()); // 0
  console.log(JSON.stringify(-0)); // 0
  console.log(JSON.stringify([-0])); // [0]
  console.log(-0 === 0); // true

  // a parenthesized -(0) is still the -0 literal
  console.log(Object.is(-(0), -0)); // true

  // CONSTANT arithmetic evaluating to -0 is folded to -0 (exporter, native JS eval):
  console.log(Object.is(0 * -1, -0)); // true
  console.log(Object.is(-1 * 0, -0)); // true
  console.log(1 / (0 * -1)); // -Infinity
  console.log(Object.is(-4 % 2, -0)); // true
  console.log(1 / (0 / -1)); // -Infinity
  console.log(1 / ((2 - 2) * -1)); // -Infinity  (nested constants)
  console.log(0 * -1); // -0
  // non-(-0) constant arithmetic is unchanged
  console.log(0 * 1, 1 * 0, -1 * -1, 4 % 2, 2 * 3); // 0 0 1 0 6
  console.log(0.1 + 0.2); // 0.30000000000000004
  console.log(1 / (1 * 0)); // Infinity  (+0 stays +0)

  // Runtime-variable arithmetic can produce -0. These cases used to be flattened
  // to +0 by int-specialized locals.
  let z = 0;
  console.log(Object.is(-z, -0)); // true
  console.log(1 / -z); // -Infinity
  let y = -1;
  console.log(1 / (0 * y)); // -Infinity
  console.log(Object.is(0 * y, -0)); // true
  let n = -4;
  let two = 2;
  console.log(Object.is(n % two, -0)); // true
  console.log(1 / (n % two)); // -Infinity

  // Math.round preserves the sign of zero: x in [-0.5, -0] -> -0 (ts_math_round),
  // and Math.trunc(-0.x) -> -0 (C trunc). Half-rounding toward +Infinity is intact.
  console.log(1 / Math.round(-0.2)); // -Infinity
  console.log(1 / Math.round(-0.5)); // -Infinity
  console.log(Object.is(Math.round(-0.4), -0)); // true
  console.log(1 / Math.round(-0)); // -Infinity
  console.log(1 / Math.round(0.2)); // Infinity   (+0 stays +0)
  console.log(1 / Math.trunc(-0.2)); // -Infinity
  console.log(Math.round(0.5), Math.round(2.5), Math.round(-2.5), Math.round(-0.6)); // 1 3 -2 -1

  // regression: ordinary +0 / integers unaffected
  console.log(0); // 0
  console.log(Object.is(0, 0)); // true
  console.log(1 / 0.0); // Infinity
  console.log([0, -1, 2]); // [ 0, -1, 2 ]
}

main();
