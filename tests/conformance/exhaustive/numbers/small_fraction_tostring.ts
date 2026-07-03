// Number -> String uses plain decimal notation for fractions down to 1e-6, then
// switches to exponential at 1e-7 and below (matching V8 / the spec).
function main(): void {
  console.log((0.000001).toString());   // 0.000001
  console.log((0.00001).toString());    // 0.00001
  console.log((0.0000001).toString());  // 1e-7
  console.log((0.0000015).toString());  // 0.0000015
  console.log(0.000001, 0.00001, 0.0001, 0.0000001); // 0.000001 0.00001 0.0001 1e-7
  console.log(-0.000003);               // -0.000003
  console.log(1e-10, 5e-8, 2.5e30);     // 1e-10 5e-8 2.5e+30
  console.log((1e21).toString());       // 1e+21
}

main();
