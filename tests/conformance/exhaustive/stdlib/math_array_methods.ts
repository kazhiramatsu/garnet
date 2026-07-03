function main(): void {
  // Math.cbrt: correctly rounded (perfect cubes are exact, matching V8).
  console.log(Math.cbrt(27), Math.cbrt(8), Math.cbrt(64), Math.cbrt(-27));   // 3 2 4 -3
  console.log(Math.cbrt(2).toFixed(10));                                      // 1.2599210499

  // Array.prototype.fill with start/end range and negative indices.
  console.log([1, 2, 3, 4].fill(0, 1, 3).join(","));      // 1,0,0,4
  console.log([1, 2, 3].fill(9).join(","));               // 9,9,9
  console.log([1, 2, 3, 4].fill(7, 2).join(","));         // 1,2,7,7
  console.log([1, 2, 3, 4, 5].fill(0, -2).join(","));     // 1,2,3,0,0

  // sort with comparator (numeric asc/desc) and default lexicographic.
  console.log([3, 1, 4, 1, 5, 9, 2, 6].sort((a, b) => a - b).join(","));   // 1,1,2,3,4,5,6,9
  console.log([1, 2, 3, 4, 5].sort((a, b) => b - a).join(","));            // 5,4,3,2,1
}
main();
