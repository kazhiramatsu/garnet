// Default Array.sort() compares by STRING form (lexicographic), not numerically,
// and undefined sorts to the end. Array.includes uses SameValueZero (NaN === NaN).
function main(): void {
  // default sort is lexicographic: 1,10,2,20,3 — NOT 1,2,3,10,20.
  console.log([3, 1, 2, 10, 20].sort().join(","));        // 1,10,2,20,3
  console.log([100, 25, 9].sort().join(","));             // 100,25,9

  // undefined elements sort to the end.
  const u = [3, undefined, 1, undefined, 2] as any[];
  console.log(u.sort().map((x: any) => String(x)).join(",")); // 1,2,3,undefined,undefined

  // an explicit comparator still sorts numerically.
  console.log([3, 1, 2, 10, 20].sort((a, b) => a - b).join(",")); // 1,2,3,10,20

  // includes treats NaN as present (SameValueZero); indexOf does not (strict).
  console.log([1, NaN, 3].includes(NaN));                 // true
  console.log([1, NaN, 3].indexOf(NaN));                  // -1
  console.log([0].includes(-0));                          // true
  console.log([1, 2, 3].includes(2), [1, 2, 3].includes(9)); // true false
}

main();
