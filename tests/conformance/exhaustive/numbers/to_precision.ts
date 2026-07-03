// Number.toPrecision: exponential when the exponent < -6 or >= precision, else
// fixed; rounding may carry into the next power of ten (9.99 -> 10).
function main(): void {
  console.log((0.00001234).toPrecision(2));      // 0.000012
  console.log((123456).toPrecision(3));          // 1.23e+5
  console.log((3.14159).toPrecision(3), (123.456).toPrecision(5)); // 3.14 123.46
  console.log((100).toPrecision(2), (5).toPrecision(3));           // 1.0e+2 5.00
  console.log((0).toPrecision(3), (0).toPrecision(1));             // 0.00 0
  console.log((-1234.5).toPrecision(2));         // -1.2e+3
  console.log((0.0001).toPrecision(1), (0.0000001).toPrecision(1)); // 0.0001 1e-7

  // rounding carries
  console.log((99.9).toPrecision(2), (9.99).toPrecision(2));       // 1.0e+2 10
  console.log((9.95).toPrecision(2));            // 9.9 (9.95 is ~9.94999 as a double)
  console.log((9999).toPrecision(1));            // 1e+4
}

main();
