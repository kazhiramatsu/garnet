// Variadic Math.hypot / String.concat, ToNumber-coercing global isNaN/isFinite,
// and String.codePointAt.
function main(): void {
  console.log(Math.hypot(3, 4, 12));            // 13
  console.log(Math.hypot(5), Math.hypot(-7));   // 5 7
  console.log(Math.hypot(), Math.hypot(3, 4));  // 0 5

  console.log("a".concat("b", "c", "d"));        // abcd
  console.log("x".concat("y"), "x".concat());    // xy x

  // global isNaN/isFinite coerce their argument (Number.* versions do not).
  console.log(isNaN("abc" as any), isNaN("123" as any), isNaN(NaN));      // true false true
  console.log(isFinite("42" as any), isFinite("x" as any), isFinite(Infinity)); // true false false

  console.log("A".codePointAt(0), "abc".codePointAt(1)); // 65 98
  console.log(String("ab".codePointAt(5)));      // undefined
}

main();
