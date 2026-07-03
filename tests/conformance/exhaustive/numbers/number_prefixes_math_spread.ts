// Number() parses 0b/0o/0x prefixes; Math.max/min/hypot accept spread arguments.
function main(): void {
  console.log(Number("0b101"), Number("0o17"), Number("0x1F")); // 5 15 31
  console.log(Number("  0b11  "), Number("0B1010"));            // 3 10
  console.log(Number("0b"), Number("0b2"), Number("0o9"));      // NaN NaN NaN
  console.log(Number("42"), Number("3.14"), Number(""));        // 42 3.14 0

  const a = [3, 7, 2, 9, 1];
  console.log(Math.max(...a), Math.min(...a));                  // 9 1
  console.log(Math.max(1, ...[3, 7], 5), Math.min(10, ...[3, 7], 0)); // 7 0
  console.log(Math.hypot(...[3, 4, 12]));                       // 13
  console.log(Math.max(...[1, NaN, 3]));                        // NaN

  const empty: number[] = [];
  console.log(Math.max(...empty), Math.min(...empty));          // -Infinity Infinity
}

main();
