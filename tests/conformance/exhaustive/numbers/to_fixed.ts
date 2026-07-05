// Number.toFixed: round half away from zero based on the EXACT value of the
// double — so 1.45 (really 1.4499...) -> "1.4", but exact ties (2.5) -> "3".
function main(): void {
  console.log((1.45).toFixed(1));                    // 1.4
  console.log((2.675).toFixed(2));                   // 2.67
  console.log((0.5).toFixed(0), (1.5).toFixed(0), (2.5).toFixed(0)); // 1 2 3
  console.log((-0.5).toFixed(0), (-2.5).toFixed(0)); // -1 -3
  console.log((1.005).toFixed(2));                   // 1.00 (1.005 is 1.00499...)
  console.log((3.7).toFixed(0), (3.4).toFixed(0), (0).toFixed(0)); // 4 3 0
  console.log((3.14159265).toFixed(5), (1).toFixed(3)); // 3.14159 1.000
  console.log((9.95).toFixed(1), (9.99).toFixed(1));  // 9.9 10.0  (9.95 is 9.949...)
  console.log((0.999).toFixed(2), (9.999).toFixed(2)); // 1.00 10.00
  console.log((0.125).toFixed(2), (0.375).toFixed(2)); // 0.13 0.38 (exact ties -> away)
  console.log((123456.789).toFixed(2));              // 123456.79
  console.log((-1.45).toFixed(1));                   // -1.4
  // sign of zero: -0 is NOT < 0, so it drops the sign; a genuinely-negative
  // value keeps its sign even when it rounds to zero (ECMA-262 21.1.3.3).
  console.log((-0).toFixed(2), (-0).toFixed(0));            // 0.00 0
  console.log((-0.0001).toFixed(2), (-0.001).toFixed(2));  // -0.00 -0.00
  console.log((-0.004).toFixed(2), (-0.005).toFixed(2));   // -0.00 -0.01
  console.log((0).toFixed(2), (0.0001).toFixed(2));        // 0.00 0.00
}

main();
