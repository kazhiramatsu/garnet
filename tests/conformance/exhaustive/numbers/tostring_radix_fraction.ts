// Number.toString(radix) for fractions (Steele & White rounding), and
// Array.includes with a fromIndex.
function main(): void {
  console.log((255.5).toString(16));         // ff.8
  console.log((0.5).toString(2), (0.25).toString(2), (0.75).toString(4)); // 0.1 0.01 0.3
  console.log((255).toString(16), (10).toString(2), (0).toString(16));    // ff 1010 0
  console.log((-255.5).toString(16));        // -ff.8
  console.log((0.1).toString(2));            // 0.0001100110011001100110011001100110011001100110011001101
  console.log((0.1).toString(3));            // 0.0022002200220022002200220022002201
  console.log((100.125).toString(8));        // 144.1
  console.log((-3.14159).toString(2).slice(0, 5)); // -11.0

  // Array.includes(value, fromIndex)
  console.log([1, 2, 3].includes(1, 1), [1, 2, 3].includes(3, 1)); // false true
  console.log([1, 2, 3, 1].includes(1, -1), [1, 2, 3].includes(1, -10)); // true true
}

main();
